import tls from "node:tls";
import type { Duplex } from "node:stream";

// A small IMAP client: enough to read Gmail (or any IMAP mailbox) without OAuth or a paid service.
// Gmail allows IMAP sign-in with an "app password" (Google Account > Security > 2-Step Verification
// > App passwords). The inbox is opened with EXAMINE, which is read-only: reading mail here never
// marks it as read, moves or deletes anything. The only write is APPEND to the Drafts folder, and
// OmniPilot does that only when the user approves a draft.

export interface ImapLogin {
  user: string;
  pass: string;
  host?: string;
  port?: number;
  /** Tests pass a fake server here. */
  connect?: () => Duplex;
  timeoutMs?: number;
}

/** One untagged response: its text (with literals shown as {n}) and the literals' contents in order. */
interface Record {
  text: string;
  literals: Buffer[];
}

const quote = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

export class ImapSession {
  private buf = Buffer.alloc(0);
  private tag = 0;
  private waiting: { tag: string; records: Record[]; resolve: (r: { ok: boolean; status: string; records: Record[] }) => void; reject: (e: Error) => void; onContinue?: () => void } | null = null;
  private current: Record | null = null;
  private literalLeft = 0;
  private greeting: Promise<void>;
  private closed = false;

  constructor(private readonly socket: Duplex, private readonly timeoutMs: number) {
    let greeted: () => void;
    let failGreeting: (e: Error) => void;
    this.greeting = new Promise((res, rej) => ((greeted = res), (failGreeting = rej)));
    let gotGreeting = false;
    socket.on("data", (chunk: Buffer) => {
      this.buf = Buffer.concat([this.buf, chunk]);
      if (!gotGreeting) {
        const nl = this.buf.indexOf("\r\n");
        if (nl < 0) return;
        const line = this.buf.subarray(0, nl).toString("utf8");
        this.buf = this.buf.subarray(nl + 2);
        gotGreeting = true;
        if (/^\* (OK|PREAUTH)/i.test(line)) greeted();
        else failGreeting(new Error(`The mail server refused the connection: ${line.slice(0, 120)}`));
      }
      this.drain();
    });
    const fail = (e: Error) => {
      this.closed = true;
      failGreeting?.(e);
      this.waiting?.reject(e);
      this.waiting = null;
    };
    socket.on("error", (e) => fail(e));
    socket.on("close", () => fail(new Error("The mail server closed the connection.")));
  }

  private drain() {
    for (;;) {
      if (this.literalLeft > 0) {
        if (this.buf.length < this.literalLeft) return;
        this.current!.literals.push(this.buf.subarray(0, this.literalLeft));
        this.buf = this.buf.subarray(this.literalLeft);
        this.literalLeft = 0;
        continue;
      }
      const nl = this.buf.indexOf("\r\n");
      if (nl < 0) return;
      const line = this.buf.subarray(0, nl).toString("utf8");
      this.buf = this.buf.subarray(nl + 2);
      const lit = /\{(\d+)\}$/.exec(line);
      if (this.current) this.current.text += line;
      else if (line.startsWith("+") && this.waiting?.onContinue) {
        const go = this.waiting.onContinue;
        this.waiting.onContinue = undefined;
        go();
        continue;
      } else if (this.waiting && line.startsWith(this.waiting.tag + " ")) {
        const w = this.waiting;
        this.waiting = null;
        const status = line.slice(w.tag.length + 1);
        w.resolve({ ok: /^OK/i.test(status), status, records: w.records });
        continue;
      } else this.current = { text: line, literals: [] };
      if (lit) {
        this.literalLeft = Number(lit[1]);
        continue;
      }
      if (this.current) {
        this.waiting?.records.push(this.current);
        this.current = null;
      }
    }
  }

  async ready() {
    await this.withTimeout(this.greeting);
  }

  private withTimeout<T>(p: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout;
    return Promise.race([p, new Promise<T>((_, rej) => (timer = setTimeout(() => rej(new Error("The mail server didn't answer in time.")), this.timeoutMs)))]).finally(() => clearTimeout(timer));
  }

  /** Sends a command; `literal` is sent after the server's "+" go-ahead (APPEND). */
  command(cmd: string, literal?: Buffer): Promise<{ ok: boolean; status: string; records: Record[] }> {
    if (this.closed) return Promise.reject(new Error("The mail connection is closed."));
    const tag = `A${++this.tag}`;
    const p = new Promise<{ ok: boolean; status: string; records: Record[] }>((resolve, reject) => {
      this.waiting = { tag, records: [], resolve, reject, onContinue: literal ? () => this.socket.write(Buffer.concat([literal, Buffer.from("\r\n")])) : undefined };
    });
    this.socket.write(`${tag} ${cmd}\r\n`);
    return this.withTimeout(p);
  }

  async login(user: string, pass: string) {
    const r = await this.command(`LOGIN ${quote(user)} ${quote(pass)}`);
    if (!r.ok) throw new Error(/AUTHENTICATIONFAILED|Invalid credentials/i.test(r.status) ? "Gmail didn't accept that address and app password. Use an app password (not your normal password); see the steps on the Gmail card." : `Sign-in failed: ${r.status.slice(0, 160)}`);
  }

  /** Opens a mailbox read-only. Returns how many messages it has. */
  async examine(mailbox = "INBOX"): Promise<number> {
    const r = await this.command(`EXAMINE ${quote(mailbox)}`);
    if (!r.ok) throw new Error(`Couldn't open ${mailbox}: ${r.status.slice(0, 120)}`);
    return Number(r.records.map((x) => /^\* (\d+) EXISTS/i.exec(x.text)?.[1]).find(Boolean) ?? 0);
  }

  /** Message UIDs matching a search. Gmail understands its own search syntax ("is:unread from:bob"). */
  async search(gmailQuery: string | null, fallback = "ALL"): Promise<number[]> {
    let r = gmailQuery ? await this.command(`UID SEARCH X-GM-RAW ${quote(gmailQuery)}`) : null;
    if (!r || !r.ok) r = await this.command(`UID SEARCH ${fallback}`);
    if (!r.ok) throw new Error(`Search failed: ${r.status.slice(0, 120)}`);
    return r.records.flatMap((x) => (/^\* SEARCH\b(.*)$/i.exec(x.text)?.[1] ?? "").trim().split(/\s+/).filter(Boolean).map(Number));
  }

  async fetch(uids: number[]): Promise<Email[]> {
    if (!uids.length) return [];
    const r = await this.command(`UID FETCH ${uids.join(",")} (UID FLAGS BODY.PEEK[HEADER.FIELDS (FROM TO SUBJECT DATE CONTENT-TYPE CONTENT-TRANSFER-ENCODING)] BODY.PEEK[TEXT]<0.6000>)`);
    if (!r.ok) throw new Error(`Couldn't read messages: ${r.status.slice(0, 120)}`);
    return r.records.filter((x) => /^\* \d+ FETCH/i.test(x.text)).map(parseFetch);
  }

  async appendDraft(raw: string, mailbox = "[Gmail]/Drafts") {
    const bytes = Buffer.from(raw.replace(/\r?\n/g, "\r\n"), "utf8");
    const r = await this.command(`APPEND ${quote(mailbox)} (\\Draft \\Seen) {${bytes.length}}`, bytes);
    if (!r.ok) throw new Error(`Couldn't save the draft: ${r.status.slice(0, 120)}`);
  }

  async logout() {
    try {
      await this.command("LOGOUT");
    } catch {
      // closing anyway
    }
    this.socket.destroy();
  }
}

export interface Email {
  uid: number;
  from: string;
  to: string;
  subject: string;
  date: string;
  unread: boolean;
  text: string;
}

/** Decodes =?utf-8?B?...?= / =?utf-8?Q?...?= header words. */
export function decodeWords(s: string): string {
  return s
    .replace(/\?=\s+=\?/g, "?==?")
    .replace(/=\?([\w-]+)\?([bq])\?([^?]*)\?=/gi, (_m, charset: string, enc: string, data: string) => {
      const bytes = enc.toLowerCase() === "b" ? Buffer.from(data, "base64") : Buffer.from(data.replace(/_/g, " ").replace(/=([0-9a-f]{2})/gi, (_x, h) => String.fromCharCode(parseInt(h, 16))), "latin1");
      try {
        return new TextDecoder(charset).decode(bytes);
      } catch {
        return bytes.toString("utf8");
      }
    });
}

function headers(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of raw.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const m = /^([\w-]+):\s*(.*)$/.exec(line);
    if (m) out.set(m[1].toLowerCase(), m[2].trim());
  }
  return out;
}

const decodeQp = (s: string) => Buffer.from(s.replace(/=\r?\n/g, "").replace(/=([0-9a-f]{2})/gi, (_x, h) => String.fromCharCode(parseInt(h, 16))), "latin1").toString("utf8");
const decodeB64 = (s: string) => Buffer.from(s.replace(/[^A-Za-z0-9+/=]/g, "").replace(/=+$/, "").slice(0, Math.floor(s.replace(/[^A-Za-z0-9+/]/g, "").length / 4) * 4), "base64").toString("utf8");
const stripHtml = (s: string) =>
  s.replace(/<(style|script)[\s\S]*?<\/\1>/gi, " ").replace(/<br\s*\/?>|<\/p>|<\/div>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"');

function decodePart(body: string, h: Map<string, string>): string {
  const enc = (h.get("content-transfer-encoding") ?? "").toLowerCase();
  const text = enc === "base64" ? decodeB64(body) : enc === "quoted-printable" ? decodeQp(body) : body;
  return /text\/html/i.test(h.get("content-type") ?? "") ? stripHtml(text) : text;
}

/** The readable text of a (possibly multipart, possibly cut-off) message body. */
export function bodyText(body: string, h: Map<string, string>, depth = 0): string {
  const boundary = /boundary="?([^";]+)"?/i.exec(h.get("content-type") ?? "")?.[1];
  if (!boundary || depth > 3) return decodePart(body, h);
  const parts = body.split(`--${boundary}`).slice(1).filter((p) => !p.startsWith("--"));
  const parsed = parts.map((p) => {
    const split = p.search(/\r?\n\r?\n/);
    const ph = headers(split >= 0 ? p.slice(0, split) : "");
    return { h: ph, body: split >= 0 ? p.slice(split).replace(/^\r?\n\r?\n/, "") : "" };
  });
  const pick = parsed.find((p) => /text\/plain/i.test(p.h.get("content-type") ?? "")) ?? parsed.find((p) => /multipart\//i.test(p.h.get("content-type") ?? "")) ?? parsed.find((p) => /text\/html/i.test(p.h.get("content-type") ?? ""));
  return pick ? bodyText(pick.body, pick.h, depth + 1) : "";
}

function parseFetch(rec: Record): Email {
  // Match each literal to the item name in front of it.
  const names = [...rec.text.matchAll(/(BODY\[[^\]]*\](?:<\d+>)?)\s*\{\d+\}/gi)].map((m) => m[1].toUpperCase());
  const lit = (prefix: string) => {
    const i = names.findIndex((n) => n.startsWith(prefix));
    return i >= 0 && rec.literals[i] ? rec.literals[i].toString("latin1") : "";
  };
  const h = headers(Buffer.from(lit("BODY[HEADER"), "latin1").toString("utf8"));
  const raw = Buffer.from(lit("BODY[TEXT]"), "latin1").toString("utf8");
  const text = bodyText(raw, h).replace(/\r/g, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  return {
    uid: Number(/UID (\d+)/i.exec(rec.text)?.[1] ?? 0),
    from: decodeWords(h.get("from") ?? ""),
    to: decodeWords(h.get("to") ?? ""),
    subject: decodeWords(h.get("subject") ?? "(no subject)"),
    date: h.get("date") ?? "",
    unread: !/\\Seen/i.test(/FLAGS \(([^)]*)\)/i.exec(rec.text)?.[1] ?? ""),
    text: text.slice(0, 2500),
  };
}

/** Signs in and opens a session (the caller logs out). */
export async function openImap(login: ImapLogin): Promise<ImapSession> {
  const timeoutMs = login.timeoutMs ?? 15_000;
  const socket = login.connect ? login.connect() : tls.connect({ host: login.host ?? "imap.gmail.com", port: login.port ?? 993, servername: login.host ?? "imap.gmail.com" });
  const s = new ImapSession(socket, timeoutMs);
  try {
    await s.ready();
    await s.login(login.user, login.pass);
    return s;
  } catch (e) {
    socket.destroy();
    throw e;
  }
}
