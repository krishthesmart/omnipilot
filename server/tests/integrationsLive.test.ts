import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { decodeWords, bodyText } from "../src/lib/imap.js";
import { setImapConnector } from "../src/lib/gmail.js";
import { gmailQuery } from "../src/agents/mail.js";
import { infraPilotAgent } from "../src/agents/infraPilot.js";
import { executeAction, getAction, saveAction } from "../src/lib/actions.js";
import { setConnectorStatus, setConnectorVerified } from "../src/db.js";
import { closeAllServers, listServers, removeServer } from "../src/lib/mcp.js";
import { parseAddRequest } from "../src/agents/mcpSkill.js";
import { decideAgents } from "../src/router/decisionModel.js";
import { applyPatch, savePatchSet, undoPatch, safeNewPath } from "../src/lib/patches.js";

const ctx = () => ({ signal: new AbortController().signal, workspaceRoot: process.env.OMNIPILOT_WORKSPACE! }) as any;
const infra = (q: string) => infraPilotAgent({ runId: "i", requestText: q, context: {} } as any, ctx());

// ---------- A fake Gmail IMAP server ----------
const MAIL = [
  { uid: 41, seen: false, from: '"Ms. Lee" <lee@school.edu>', subject: "=?UTF-8?B?RmllbGQgdHJpcCDwn5qM?=", body: "Please sign the field trip form by Friday." },
  { uid: 42, seen: true, from: "Sam <sam@example.com>", subject: "Robotics meeting", body: "Meeting moved to 4pm." },
];
const log: string[] = [];
class FakeImap extends Duplex {
  private pending = "";
  private literal: { left: number; tag: string } | null = null;
  constructor(private readonly password: string) {
    super();
    setImmediate(() => this.push("* OK Gimap ready\r\n"));
  }
  _read() {}
  _write(chunk: Buffer, _enc: string, cb: () => void) {
    this.pending += chunk.toString("utf8");
    for (;;) {
      if (this.literal) {
        if (Buffer.byteLength(this.pending) < this.literal.left + 2) break;
        log.push(`DRAFT:${this.pending.slice(0, this.literal.left)}`);
        this.pending = this.pending.slice(this.literal.left + 2);
        this.push(`${this.literal.tag} OK APPEND completed\r\n`);
        this.literal = null;
        continue;
      }
      const nl = this.pending.indexOf("\r\n");
      if (nl < 0) break;
      const line = this.pending.slice(0, nl);
      this.pending = this.pending.slice(nl + 2);
      this.handle(line);
    }
    cb();
  }
  private handle(line: string) {
    const [tag, cmd, ...rest] = line.split(" ");
    const arg = rest.join(" ");
    log.push(`${cmd} ${cmd === "LOGIN" ? "***" : arg}`);
    const ok = (t = "done") => this.push(`${tag} OK ${t}\r\n`);
    if (cmd === "LOGIN") return arg.endsWith(`"${this.password}"`) ? ok() : this.push(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials\r\n`);
    if (cmd === "EXAMINE") return this.push(`* ${MAIL.length} EXISTS\r\n* 0 RECENT\r\n${tag} OK [READ-ONLY] EXAMINE completed\r\n`);
    if (cmd === "UID" && rest[0] === "SEARCH") {
      const unread = /is:unread/.test(arg);
      return this.push(`* SEARCH ${MAIL.filter((m) => !unread || !m.seen).map((m) => m.uid).join(" ")}\r\n${tag} OK SEARCH completed\r\n`);
    }
    if (cmd === "UID" && rest[0] === "FETCH") {
      const uids = rest[1].split(",").map(Number);
      for (const [i, m] of MAIL.entries()) {
        if (!uids.includes(m.uid)) continue;
        const head = `From: ${m.from}\r\nSubject: ${m.subject}\r\nDate: Fri, 16 Oct 2026 09:00:00 +0000\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n`;
        this.push(`* ${i + 1} FETCH (UID ${m.uid} FLAGS (${m.seen ? "\\Seen" : ""}) BODY[HEADER.FIELDS (FROM TO SUBJECT DATE CONTENT-TYPE CONTENT-TRANSFER-ENCODING)] {${Buffer.byteLength(head)}}\r\n${head} BODY[TEXT]<0> {${Buffer.byteLength(m.body)}}\r\n${m.body})\r\n`);
      }
      return ok("FETCH completed");
    }
    if (cmd === "APPEND") {
      this.literal = { left: Number(/\{(\d+)\}$/.exec(arg)![1]), tag };
      return this.push("+ go ahead\r\n");
    }
    if (cmd === "LOGOUT") return this.push(`* BYE\r\n${tag} OK bye\r\n`);
    this.push(`${tag} BAD unknown\r\n`);
  }
}

describe("Gmail (read-only IMAP)", () => {
  afterEach(() => {
    setImapConnector(undefined);
    setConnectorStatus("Gmail", "not_connected");
    log.length = 0;
  });

  it("decodes encoded headers and multipart bodies", () => {
    expect(decodeWords("=?UTF-8?B?RmllbGQgdHJpcCDwn5qM?=")).toBe("Field trip 🚌");
    expect(decodeWords("=?iso-8859-1?Q?caf=E9_menu?=")).toBe("café menu");
    const h = new Map([["content-type", 'multipart/alternative; boundary="b1"']]);
    const body = '--b1\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nHello =E2=9C=93\r\n--b1\r\nContent-Type: text/html\r\n\r\n<p>Hello</p>\r\n--b1--';
    expect(bodyText(body, h).trim()).toBe("Hello ✓");
  });

  it("turns requests into Gmail searches", () => {
    expect(gmailQuery("summarize my unread emails from today")).toBe("in:inbox is:unread newer_than:1d");
    expect(gmailQuery("any emails from lee@school.edu this week?")).toContain("from:(lee@school.edu)");
    expect(gmailQuery("search my email for the field trip form")).toContain('"field trip form"');
  });

  it("connects only with a working app password, and reads mail without marking it read", async () => {
    setImapConnector(() => new FakeImap("abcdefghijklmnop"));
    const { createApp } = await import("../src/app.js");
    const request = (await import("supertest")).default;
    const app = createApp();
    const bad = await request(app).post("/api/connectors/Gmail/connect").send({ account: "me@gmail.com", token: "wrong" });
    expect(bad.status).toBe(400);
    expect(bad.body.message).toMatch(/app password/);
    const good = await request(app).post("/api/connectors/Gmail/connect").send({ account: "me@gmail.com", token: "abcd efgh ijkl mnop" });
    expect(good.status).toBe(200);
    expect(good.body.account_label).toMatch(/me@gmail.com \(2 messages/);
    expect(JSON.stringify(good.body)).not.toContain("abcdefgh");

    log.length = 0;
    const r = await infra("summarize my unread emails");
    expect(r.status).toBe("success");
    expect(r.findings.join("\n")).toContain("Field trip 🚌");
    expect(r.findings.join("\n")).not.toContain("Robotics meeting"); // read, so not unread
    // Read-only: EXAMINE (never SELECT), BODY.PEEK (never marks as read), no STORE/EXPUNGE.
    expect(log.some((l) => l.startsWith("EXAMINE"))).toBe(true);
    expect(log.some((l) => /^(SELECT|STORE|EXPUNGE|COPY|MOVE)/.test(l) || /UID (STORE|EXPUNGE|MOVE)/.test(l))).toBe(false);
    expect(log.find((l) => l.includes("FETCH"))).toContain("BODY.PEEK");
  });

  it("asks to connect when Gmail isn't connected", async () => {
    const r = await infra("what's in my inbox?");
    expect(r.status).toBe("needs_connection");
  });

  it("saves an approved draft to Drafts (and never sends)", async () => {
    setImapConnector(() => new FakeImap("pw"));
    setConnectorVerified("Gmail", "me@gmail.com", JSON.stringify({ address: "me@gmail.com", password: "pw" }));
    saveAction("d1", "gmail_draft", { to: "lee@school.edu", subject: "Field trip", body: "Signed form attached." });
    const out = await executeAction("d1");
    expect(out.ok).toBe(true);
    const draft = log.find((l) => l.startsWith("DRAFT:"))!;
    expect(draft).toContain("To: lee@school.edu");
    expect(Buffer.from(draft.split("\r\n\r\n")[1].replace(/\s/g, ""), "base64").toString()).toBe("Signed form attached.");
    expect(log.find((l) => l.startsWith("APPEND"))).toContain('"[Gmail]/Drafts" (\\Draft \\Seen)');
  });
});

// ---------- Integration actions ----------
describe("approved integration actions", () => {
  afterEach(() => vi.restoreAllMocks());

  it("opens a GitHub issue with the stored parameters, once", async () => {
    setConnectorVerified("GitHub", "@me", "ghp_test");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ number: 7, html_url: "https://github.com/acme/site/issues/7" }), { status: 201 }));
    saveAction("g1", "github_issue", { repo: "acme/site", title: "Broken", body: "steps" });
    const out = await executeAction("g1");
    expect(out).toMatchObject({ ok: true, url: "https://github.com/acme/site/issues/7" });
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://api.github.com/repos/acme/site/issues");
    expect((fetchMock.mock.calls[0][1] as any).headers.Authorization).toBe("Bearer ghp_test");
    expect(await executeAction("g1")).toMatchObject({ ok: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    setConnectorStatus("GitHub", "not_connected");
  });

  it("a failed action stays pending so it can be retried", async () => {
    setConnectorVerified("Slack", "ws", "xoxb");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ ok: false, error: "not_in_channel" }), { status: 200 }));
    saveAction("s1", "slack_message", { channel: "#x", text: "hi" });
    const out = await executeAction("s1");
    expect(out.ok).toBe(false);
    expect(out.message).toMatch(/Invite the OmniPilot app/);
    expect(getAction("s1")!.status).toBe("pending");
    setConnectorStatus("Slack", "not_connected");
  });

  it("fails clearly when the service was disconnected after proposing", async () => {
    saveAction("n1", "notion_append", { pageId: "x", text: "hi" });
    expect((await executeAction("n1")).message).toMatch(/isn't connected/);
  });
});

// ---------- MCP ----------
const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-mcp-server.mjs");

describe("MCP servers (real stdio client)", () => {
  afterAll(() => {
    removeServer("notes");
    closeAllServers();
  });

  it("parses add requests", () => {
    expect(parseAddRequest("add an mcp server called files: `npx -y @modelcontextprotocol/server-filesystem /tmp/docs`")).toEqual({
      name: "files",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp/docs"],
    });
    expect(parseAddRequest("connect the MCP server at https://mcp.example.com/mcp")).toMatchObject({ transport: "http", url: "https://mcp.example.com/mcp", name: "example" });
  });

  it("adding a server is only proposed; approving it connects and loads tools", async () => {
    const r = await infra(`add an MCP server called notes: \`${process.execPath} ${FAKE}\``);
    expect(r.status).toBe("needs_approval");
    expect(r.proposedActions[0].preview).toContain("Runs this program on your computer");
    expect(listServers().find((s) => s.name === "notes")).toBeUndefined();
    const out = await executeAction(r.proposedActions[0].id);
    expect(out.ok).toBe(true);
    expect(out.message).toContain("list_notes");
    expect(listServers().find((s) => s.name === "notes")!.tools).toHaveLength(2);
  });

  it("routes requests that name a server to InfraPilot", () => {
    expect(decideAgents("ask notes what's on my list").selectedAgents).toContain("InfraPilot");
  });

  it("runs read-only tools directly; anything else needs approval", async () => {
    const read = await infra("call list_notes on notes");
    expect(read.status).toBe("success");
    expect(read.findings.join("\n")).toContain("buy milk");

    const write = await infra('call add_note on notes with {"text": "walk dog"}');
    expect(write.status).toBe("needs_approval");
    expect(write.proposedActions[0].preview).toContain("walk dog");
    const again = await infra("call list_notes on notes");
    expect(again.findings.join("\n")).not.toContain("walk dog"); // not run yet

    expect((await executeAction(write.proposedActions[0].id)).ok).toBe(true);
    expect((await infra("call list_notes on notes")).findings.join("\n")).toContain("walk dog");
  });

  it("lists servers and tools", async () => {
    const r = await infra("list my mcp servers");
    expect(r.findings.join("\n")).toMatch(/notes.*2 tools/s);
  });
});

// ---------- Multi-file change sets ----------
describe("change sets across files", () => {
  const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "omni-set-"));
  afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

  it("creates new files and edits existing ones together, and undoes them together", () => {
    fs.writeFileSync(path.join(ROOT, "main.py"), "print('hi')\n");
    savePatchSet("set1", "new app", [
      { file: "main.py", original: "print('hi')\n", fixed: "from app.core import run\nrun()\n" },
      { file: "app/core.py", original: "", fixed: "def run():\n    print('hi')\n", isNew: true },
    ]);
    expect(applyPatch("set1", ROOT)).toMatchObject({ ok: true, files: ["main.py", "app/core.py"] });
    expect(fs.readFileSync(path.join(ROOT, "app/core.py"), "utf8")).toContain("def run");
    expect(undoPatch("set1", ROOT)).toMatchObject({ ok: true });
    expect(fs.existsSync(path.join(ROOT, "app/core.py"))).toBe(false);
    expect(fs.existsSync(path.join(ROOT, "app"))).toBe(false); // the folder it created is gone too
    expect(fs.readFileSync(path.join(ROOT, "main.py"), "utf8")).toBe("print('hi')\n");
  });

  it("applies nothing if any file in the set has changed", () => {
    fs.writeFileSync(path.join(ROOT, "a.js"), "a\n");
    fs.writeFileSync(path.join(ROOT, "b.js"), "b\n");
    savePatchSet("set2", "x", [
      { file: "a.js", original: "a\n", fixed: "A\n" },
      { file: "b.js", original: "OLD\n", fixed: "B\n" },
    ]);
    expect(applyPatch("set2", ROOT)).toMatchObject({ ok: false, error: "changed" });
    expect(fs.readFileSync(path.join(ROOT, "a.js"), "utf8")).toBe("a\n");
  });

  it("never creates files outside the workspace", () => {
    expect(safeNewPath(ROOT, "../escape.js")).toBeNull();
    expect(safeNewPath(ROOT, "/etc/x")).toBeNull();
    fs.symlinkSync(os.tmpdir(), path.join(ROOT, "out"));
    expect(safeNewPath(ROOT, "out/x.js")).toBeNull();
    expect(safeNewPath(ROOT, "new/dir/x.js")).toBe(path.join(fs.realpathSync(ROOT), "new/dir/x.js"));
  });
});
