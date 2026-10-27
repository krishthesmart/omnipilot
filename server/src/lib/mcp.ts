import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { db } from "../db.js";
import { registerExecutor } from "./actions.js";
import { APP_VERSION } from "./status.js";

// A real Model Context Protocol client. OmniPilot connects to MCP servers the user adds, either a
// local program (stdio: e.g. `npx -y @modelcontextprotocol/server-filesystem ~/Documents`) or a
// server on the web (Streamable HTTP), lists their tools, and calls them.
//   - Adding a server runs a program or connects to a URL, so it only happens when the user
//     approves it, with the exact command shown.
//   - Tools the server marks read-only (annotations.readOnlyHint) run straight away; every other
//     tool call is shown to the user and runs only when approved.
//   - Local servers get only a minimal environment (no OmniPilot keys), and idle ones are stopped.

db.exec(`
CREATE TABLE IF NOT EXISTS mcp_servers (
  name TEXT PRIMARY KEY,
  transport TEXT NOT NULL,     -- 'stdio' | 'http'
  command TEXT,
  args TEXT,                   -- JSON array
  url TEXT,
  headers TEXT,                -- JSON object (e.g. an Authorization header); never returned by the API
  tools TEXT,                  -- JSON: the last tools/list result
  added_at TEXT NOT NULL
)`);

export const PROTOCOL_VERSION = "2025-06-18";

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; title?: string };
}

export interface McpServerConfig {
  name: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
}

const TIMEOUT_MS = () => Number(process.env.OMNIPILOT_MCP_TIMEOUT_MS ?? 30_000) || 30_000;
const IDLE_MS = 5 * 60_000;

interface Transport {
  request(method: string, params?: unknown): Promise<any>;
  notify(method: string, params?: unknown): Promise<void>;
  close(): void;
}

class StdioTransport implements Transport {
  private proc: ChildProcessWithoutNullStreams;
  private id = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private buf = "";
  private stderr = "";

  constructor(command: string, args: string[]) {
    // Only what a program needs to start: no API keys or tokens from OmniPilot's environment.
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, SystemRoot: process.env.SystemRoot, TMPDIR: process.env.TMPDIR, LANG: process.env.LANG };
    this.proc = spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"], shell: process.platform === "win32" });
    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (chunk: string) => {
      this.buf += chunk;
      let nl: number;
      while ((nl = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, nl).trim();
        this.buf = this.buf.slice(nl + 1);
        if (!line) continue;
        try {
          this.onMessage(JSON.parse(line));
        } catch {
          // not JSON-RPC (a stray log line): ignore
        }
      }
    });
    this.proc.stderr.on("data", (c) => (this.stderr = (this.stderr + c).slice(-2000)));
    const fail = (why: string) => {
      for (const p of this.pending.values()) p.reject(new Error(why));
      this.pending.clear();
    };
    this.proc.on("error", (e) => fail(`Couldn't start "${command}": ${e.message}`));
    this.proc.on("exit", (code) => fail(`The MCP server stopped (exit code ${code}).${this.stderr ? ` It said: ${this.stderr.trim().split("\n").slice(-3).join(" ")}` : ""}`));
  }

  private onMessage(msg: any) {
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message ?? "MCP error"));
      else p.resolve(msg.result);
    } else if (msg.id !== undefined && msg.method) {
      // A request from the server (sampling, roots...): OmniPilot doesn't offer these.
      this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Not supported by OmniPilot" } }) + "\n");
    }
  }

  request(method: string, params?: unknown) {
    const id = ++this.id;
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`The MCP server didn't answer ${method} in time.`));
      }, TIMEOUT_MS());
      this.pending.set(id, { resolve: (v) => (clearTimeout(timer), resolve(v)), reject: (e) => (clearTimeout(timer), reject(e)) });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) }) + "\n");
    });
  }

  async notify(method: string, params?: unknown) {
    this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) }) + "\n");
  }

  close() {
    this.proc.kill();
  }
}

class HttpTransport implements Transport {
  private id = 0;
  private session: string | null = null;
  constructor(private readonly url: string, private readonly headers: Record<string, string>) {}

  private async post(body: unknown): Promise<any> {
    const res = await fetch(this.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": PROTOCOL_VERSION,
        ...(this.session ? { "Mcp-Session-Id": this.session } : {}),
        ...this.headers,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS()),
    });
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.session = sid;
    if (res.status === 202 || res.status === 204) return null;
    if (res.status === 401 || res.status === 403) throw new Error(`The MCP server refused access (HTTP ${res.status}). Check its access token.`);
    if (!res.ok) throw new Error(`The MCP server answered HTTP ${res.status}.`);
    const type = res.headers.get("content-type") ?? "";
    const text = await res.text();
    if (type.includes("text/event-stream")) {
      // The answer is one of the SSE events (others can be progress notifications).
      const want = (body as any).id;
      for (const block of text.split(/\r?\n\r?\n/)) {
        const data = block.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
        if (!data) continue;
        try {
          const msg = JSON.parse(data);
          if (msg.id === want) return msg;
        } catch {
          // skip
        }
      }
      throw new Error("The MCP server's stream ended without an answer.");
    }
    return text ? JSON.parse(text) : null;
  }

  async request(method: string, params?: unknown) {
    const id = ++this.id;
    const msg = await this.post({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) });
    if (msg?.error) throw new Error(msg.error.message ?? "MCP error");
    return msg?.result;
  }

  async notify(method: string, params?: unknown) {
    await this.post({ jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) });
  }

  close() {
    if (this.session) fetch(this.url, { method: "DELETE", headers: { "Mcp-Session-Id": this.session, ...this.headers } }).catch(() => {});
  }
}

interface Live {
  transport: Transport;
  timer: NodeJS.Timeout;
  info: { name?: string; version?: string };
}
const live = new Map<string, Promise<Live>>();

async function open(config: McpServerConfig): Promise<Live> {
  const transport = config.transport === "stdio" ? new StdioTransport(config.command!, config.args ?? []) : new HttpTransport(config.url!, config.headers ?? {});
  try {
    const init = await transport.request("initialize", { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "OmniPilot", version: APP_VERSION } });
    await transport.notify("notifications/initialized");
    return { transport, timer: setTimeout(() => {}, 0), info: init?.serverInfo ?? {} };
  } catch (e) {
    transport.close();
    throw e;
  }
}

/** A connection to a server (reused while it's being used; closed after 5 idle minutes). */
async function connection(config: McpServerConfig): Promise<Live> {
  let p = live.get(config.name);
  if (!p) {
    p = open(config);
    live.set(config.name, p);
    p.catch(() => live.delete(config.name));
  }
  const conn = await p;
  clearTimeout(conn.timer);
  conn.timer = setTimeout(() => closeServer(config.name), IDLE_MS);
  conn.timer.unref?.();
  return conn;
}

export function closeServer(name: string) {
  const p = live.get(name);
  live.delete(name);
  p?.then((c) => (clearTimeout(c.timer), c.transport.close())).catch(() => {});
}

export function closeAllServers() {
  for (const name of [...live.keys()]) closeServer(name);
}

/** Connects (without saving) and returns the server's tools: used to check a server before adding it. */
export async function probeServer(config: McpServerConfig): Promise<{ tools: McpTool[]; serverName?: string }> {
  const conn = await connection(config);
  const tools: McpTool[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const r = await conn.transport.request("tools/list", cursor ? { cursor } : {});
    tools.push(...(r?.tools ?? []));
    cursor = r?.nextCursor;
    if (!cursor) break;
  }
  return { tools, serverName: conn.info.name };
}

// --- saved servers ---

const rowToConfig = (r: any): McpServerConfig => ({
  name: r.name,
  transport: r.transport,
  command: r.command ?? undefined,
  args: r.args ? JSON.parse(r.args) : [],
  url: r.url ?? undefined,
  headers: r.headers ? JSON.parse(r.headers) : {},
});

export function getServer(name: string): (McpServerConfig & { tools: McpTool[] }) | null {
  const r = db.prepare(`SELECT * FROM mcp_servers WHERE name = ? COLLATE NOCASE`).get(name) as any;
  return r ? { ...rowToConfig(r), tools: r.tools ? JSON.parse(r.tools) : [] } : null;
}

/** A saved server the request names, if any. */
export function mentionedServer(text: string): string | null {
  const names = listServers().map((s) => s.name);
  return names.find((n) => new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text)) ?? null;
}

/** Public view of the saved servers (no headers/tokens). */
export function listServers(): { name: string; transport: string; target: string; tools: McpTool[] }[] {
  return (db.prepare(`SELECT * FROM mcp_servers ORDER BY name`).all() as any[]).map((r) => ({
    name: r.name,
    transport: r.transport,
    target: r.transport === "stdio" ? [r.command, ...(r.args ? JSON.parse(r.args) : [])].join(" ") : r.url,
    tools: r.tools ? JSON.parse(r.tools) : [],
  }));
}

export async function addServer(config: McpServerConfig): Promise<{ tools: McpTool[] }> {
  closeServer(config.name);
  const { tools } = await probeServer(config);
  db.prepare(`INSERT OR REPLACE INTO mcp_servers (name, transport, command, args, url, headers, tools, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    config.name,
    config.transport,
    config.command ?? null,
    JSON.stringify(config.args ?? []),
    config.url ?? null,
    JSON.stringify(config.headers ?? {}),
    JSON.stringify(tools),
    new Date().toISOString()
  );
  return { tools };
}

export function removeServer(name: string): boolean {
  closeServer(name);
  return db.prepare(`DELETE FROM mcp_servers WHERE name = ? COLLATE NOCASE`).run(name).changes > 0;
}

/** Refreshes a saved server's tool list. */
export async function refreshTools(name: string): Promise<McpTool[]> {
  const s = getServer(name);
  if (!s) throw new Error(`There's no MCP server called "${name}".`);
  const { tools } = await probeServer(s);
  db.prepare(`UPDATE mcp_servers SET tools = ? WHERE name = ?`).run(JSON.stringify(tools), s.name);
  return tools;
}

/** Calls a tool and returns its text output (images and other content are summarised). */
export async function callTool(serverName: string, tool: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const s = getServer(serverName);
  if (!s) throw new Error(`There's no MCP server called "${serverName}".`);
  const conn = await connection(s);
  const r = await conn.transport.request("tools/call", { name: tool, arguments: args });
  const parts = (r?.content ?? []).map((c: any) =>
    c.type === "text" ? c.text : c.type === "resource" ? (c.resource?.text ?? `[resource ${c.resource?.uri}]`) : c.type === "resource_link" ? `[${c.name ?? c.uri}](${c.uri})` : `[${c.type} content]`
  );
  if (!parts.length && r?.structuredContent) parts.push(JSON.stringify(r.structuredContent, null, 2));
  return { text: parts.join("\n").slice(0, 20_000), isError: Boolean(r?.isError) };
}

export const isReadOnly = (t: McpTool) => t.annotations?.readOnlyHint === true && t.annotations?.destructiveHint !== true;

registerExecutor("mcp_tool", async (p: { server: string; tool: string; args: Record<string, unknown> }) => {
  const r = await callTool(p.server, p.tool, p.args);
  return { ok: !r.isError, message: r.isError ? `${p.tool} reported an error: ${r.text.slice(0, 400)}` : `Ran ${p.tool} on ${p.server}.${r.text ? `\n\n${r.text.slice(0, 1500)}` : ""}` };
});

registerExecutor("mcp_add_server", async (config: McpServerConfig) => {
  const { tools } = await addServer(config);
  return { ok: true, message: `Added the MCP server "${config.name}" with ${tools.length} tool${tools.length === 1 ? "" : "s"}${tools.length ? `: ${tools.slice(0, 12).map((t) => t.name).join(", ")}` : ""}.` };
});

/** "npx -y @modelcontextprotocol/server-filesystem ~/Documents" -> command + args (quotes respected). */
export function splitCommand(line: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) out.push(m[1] ?? m[2] ?? m[3]);
  return out.map((a) => (a.startsWith("~/") && process.env.HOME ? process.env.HOME + a.slice(1) : a));
}
