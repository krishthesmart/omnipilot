import net from "node:net";
import type { AgentName } from "../../types.js";
import { logAudit } from "../audit.js";
import { BrowserbaseError, bbCreateSession, bbFetch, bbReleaseSession, bbSearch, webToolsEnabled, type SearchResult } from "./browserbase.js";
import { renderPageText } from "./cdp.js";

// The web tools agents may call (read-only), backed by Browserbase:
//   search(query)      -> titles + URLs                   (Browserbase Search)
//   fetchPage(url)     -> the page as markdown, no JS      (Browserbase Fetch)
//   renderPage(url)    -> visible text after JS runs        (a cloud browser session)
// Prefer search/fetch; renderPage is for pages that need a real browser.
//
// Every agent attempt gets its own WebTools with limits: number of calls, one
// browser session, a time limit per call and overall, and a cap on how much
// text comes back. Each call is written to the activity log (what was looked
// up and how it went, never page contents). Sessions are always released.
// Pages are untrusted data: callers must never treat their text as
// instructions, and nothing here can submit forms, click or log in.

export interface WebLimits {
  maxCalls: number;
  maxSessions: number;
  deadlineMs: number;
  maxCharsPerPage: number;
  maxTotalChars: number;
}

export const DEFAULT_LIMITS: WebLimits = {
  maxCalls: Number(process.env.WEB_TOOLS_MAX_CALLS ?? 10),
  maxSessions: Number(process.env.WEB_TOOLS_MAX_SESSIONS ?? 1),
  deadlineMs: Number(process.env.WEB_TOOLS_DEADLINE_MS ?? 90_000),
  maxCharsPerPage: 12_000,
  maxTotalChars: 60_000,
};

const CALL_TIMEOUT = { search: 15_000, fetch: 30_000, render: 45_000 };
const SESSION_LIFETIME_S = 60;

export class WebToolError extends Error {
  constructor(
    readonly code: "not_configured" | "budget" | "blocked_url" | "timeout" | "failed" | "stopped",
    message: string
  ) {
    super(message);
    this.name = "WebToolError";
  }
}

export interface PageText {
  url: string;
  title: string;
  text: string;
  /** How it was read: fetch (no JS) or render (a real browser). */
  via: "fetch" | "render";
  truncated: boolean;
}

const PRIVATE_V4 = [/^10\./, /^127\./, /^169\.254\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^0\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./];

/**
 * Only public web pages: http(s), default ports, no credentials in the URL, and never
 * localhost, private networks, link-local or cloud-metadata addresses (Browserbase
 * fetches from its own servers, so those would reach *its* internal network).
 */
export function checkUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new WebToolError("blocked_url", "not a valid URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new WebToolError("blocked_url", "only http(s) pages");
  if (url.username || url.password) throw new WebToolError("blocked_url", "URLs with credentials aren't allowed");
  if (url.port && url.port !== "80" && url.port !== "443") throw new WebToolError("blocked_url", "only standard ports");
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".lan") || !host.includes(".") && net.isIP(host) === 0) {
    throw new WebToolError("blocked_url", "local and internal hosts aren't allowed");
  }
  if (net.isIP(host) === 4 && PRIVATE_V4.some((re) => re.test(host))) throw new WebToolError("blocked_url", "private network addresses aren't allowed");
  if (net.isIP(host) === 6 && (host === "::1" || host === "::" || /^(fc|fd|fe8|fe9|fea|feb)/.test(host) || host.startsWith("::ffff:"))) {
    throw new WebToolError("blocked_url", "private network addresses aren't allowed");
  }
  if (host === "metadata.google.internal" || host === "169.254.169.254") throw new WebToolError("blocked_url", "cloud metadata addresses aren't allowed");
  return url;
}

/** Short, log-safe description of a URL (no query string: it can carry tokens). */
const logUrl = (u: URL) => `${u.hostname}${u.pathname}`.slice(0, 200);

/** Markdown navigation noise (image/link-only lines) makes a small model's context worse. */
export function cleanText(text: string): string {
  const kept = text
    .replace(/<!--[\s\S]*?-->/g, "")
    // Product pages often name things only in logo images: "The Chrome logo, a ..." -> "Chrome".
    .replace(/!\[The ([^\],]{2,40}?) logo\b[^\]]*\]\([^)]*\)/gi, "$1")
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() && !/^\s*(!?\[[^\]]*\]\([^)]*\)\s*)+$/.test(l) && !/^\s*[-*]\s*!?\[[^\]]*\]\([^)]*\)\s*$/.test(l))
    .join("\n");
  // Plain text for the model: images go, links keep their words (even links spanning lines),
  // markdown line breaks ("\") and video-player labels go.
  return kept
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .split("\n")
    .map((l) => l.replace(/\s*\\$/, "").trimEnd())
    .filter((l) => l.trim() && !/^(Play|Pause) silent looping video/i.test(l.trim()))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
}

/** The page's headings (product names on a products page, sections in docs), for "list them all" requests. */
export function headings(text: string, max = 60): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/^#{1,6}\s+(.+)$/gm)) {
    const h = m[1].replace(/[*_`]/g, "").trim();
    if (h.length >= 2 && h.split(/\s+/).length <= 4 && !isNavLabel(h)) out.add(h);
  }
  return [...out].slice(0, max);
}

/** Site furniture rather than content: "Filter by", "Resources", "More about us", "Product support". */
const NAV_WORDS = new Set(["filter", "by", "resources", "resource", "more", "about", "us", "support", "help", "menu", "contact", "overview", "outreach", "initiatives", "research", "technology", "careers", "blog", "news", "products", "product", "home", "and", "our", "see", "all", "explore", "discover", "learn", "sign", "in", "search", "new", "ways", "follow", "privacy", "terms", "cookies", "skip", "to", "content", "main", "navigation"]);
export const isNavLabel = (label: string) => label.toLowerCase().split(/[^a-z]+/).filter(Boolean).every((w) => NAV_WORDS.has(w));

export interface WebToolsDeps {
  search: typeof bbSearch;
  fetch: typeof bbFetch;
  createSession: typeof bbCreateSession;
  releaseSession: typeof bbReleaseSession;
  render: typeof renderPageText;
}

const realDeps: WebToolsDeps = { search: bbSearch, fetch: bbFetch, createSession: bbCreateSession, releaseSession: bbReleaseSession, render: renderPageText };

/**
 * Behind the Python front door, search and page reading go through its tool router (Exa, Tavily or
 * Browserbase for search; Tabstack or Browserbase for pages: one service per call, with a shared budget
 * and a day-long cache). Temporary while this engine is ported to Python.
 */
async function engineTool(kind: string, args: Record<string, unknown>, signal: AbortSignal | undefined, timeoutMs: number): Promise<any> {
  const res = await fetch(`${process.env.OMNIPILOT_ENGINE_URL}/api/internal/tools/${kind}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-omnipilot-internal": process.env.OMNIPILOT_INTERNAL_TOKEN ?? "" },
    body: JSON.stringify({ args, budget: { max_calls: 2, deadline_s: Math.ceil(timeoutMs / 1000) } }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs + 2000)]) : AbortSignal.timeout(timeoutMs + 2000),
  });
  const body = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) throw new BrowserbaseError("http_error", String(body.message ?? `HTTP ${res.status}`).slice(0, 200), res.status);
  return body;
}
const engineDeps = (): WebToolsDeps => ({
  ...realDeps,
  search: async (query, numResults, signal, timeoutMs = 15_000) =>
    ((await engineTool("web_search", { query, count: numResults }, signal, timeoutMs)).results ?? []).map((r: any) => ({ title: r.title, url: r.url })),
  fetch: async (url, signal, timeoutMs = 30_000) => {
    const out = await engineTool("read_page", { url }, signal, timeoutMs);
    return { statusCode: out.status ?? 200, content: String(out.markdown ?? ""), contentType: "text/markdown" };
  },
});
const useEngine = () => Boolean(process.env.OMNIPILOT_ENGINE_URL && process.env.OMNIPILOT_INTERNAL_TOKEN);

export class WebTools {
  private calls = 0;
  private sessions = 0;
  private chars = 0;
  private readonly started = Date.now();

  constructor(
    private readonly runId: string,
    private readonly agent: AgentName,
    private readonly signal: AbortSignal,
    readonly limits: WebLimits = DEFAULT_LIMITS,
    private readonly deps: WebToolsDeps = realDeps
  ) {}

  /** Calls and time left (for agents planning how much to look up). */
  remaining() {
    return { calls: this.limits.maxCalls - this.calls, ms: Math.max(0, this.limits.deadlineMs - (Date.now() - this.started)) };
  }

  private log(action: string, parameters: Record<string, unknown>, outcome: string) {
    logAudit({ runId: this.runId, agent: this.agent, action, parameters, outcome });
  }

  /** Budget check before each call; the per-call timeout never runs past the overall deadline. */
  private take(kind: keyof typeof CALL_TIMEOUT): number {
    if (this.signal.aborted) throw new WebToolError("stopped", "the run was stopped");
    if (this.calls >= this.limits.maxCalls) throw new WebToolError("budget", `web tool limit reached (${this.limits.maxCalls} calls)`);
    const left = this.limits.deadlineMs - (Date.now() - this.started);
    if (left <= 1000) throw new WebToolError("budget", "web tool time limit reached");
    if (this.chars >= this.limits.maxTotalChars) throw new WebToolError("budget", "web tool reading limit reached");
    this.calls++;
    return Math.min(CALL_TIMEOUT[kind], left);
  }

  private bound(text: string): { text: string; truncated: boolean } {
    const room = Math.max(0, Math.min(this.limits.maxCharsPerPage, this.limits.maxTotalChars - this.chars));
    const out = text.length > room ? text.slice(0, room) : text;
    this.chars += out.length;
    return { text: out, truncated: out.length < text.length };
  }

  private failure(err: unknown, timeoutMs: number): WebToolError {
    if (err instanceof WebToolError) return err;
    if (this.signal.aborted) return new WebToolError("stopped", "the run was stopped");
    if (err instanceof BrowserbaseError) return new WebToolError(err.code === "timeout" ? "timeout" : err.code === "not_configured" ? "not_configured" : "failed", err.message);
    const message = (err as Error)?.message ?? "failed";
    return new WebToolError(message === "timeout" ? "timeout" : "failed", message === "timeout" ? `no answer within ${Math.round(timeoutMs / 1000)}s` : message.slice(0, 160));
  }

  async search(query: string, numResults = 5): Promise<SearchResult[]> {
    const q = query.trim().slice(0, 200);
    const timeoutMs = this.take("search");
    const t = Date.now();
    try {
      const results = (await this.deps.search(q, Math.min(numResults, 10), this.signal, timeoutMs)).filter((r) => {
        try {
          checkUrl(r.url);
          return true;
        } catch {
          return false;
        }
      });
      this.log("web_search", { query: q, results: results.length, ms: Date.now() - t }, "completed");
      return results;
    } catch (err) {
      const e = this.failure(err, timeoutMs);
      this.log("web_search", { query: q, ms: Date.now() - t }, `failed: ${e.code}`);
      throw e;
    }
  }

  async fetchPage(rawUrl: string): Promise<PageText> {
    const url = checkUrl(rawUrl);
    const timeoutMs = this.take("fetch");
    const t = Date.now();
    try {
      const page = await this.deps.fetch(url.toString(), this.signal, timeoutMs);
      if (page.statusCode >= 400) throw new WebToolError("failed", `the site answered ${page.statusCode}`);
      const cleaned = cleanText(page.content);
      const title = /^#\s+(.+)$/m.exec(cleaned)?.[1]?.trim().slice(0, 200) ?? url.hostname;
      const { text, truncated } = this.bound(cleaned);
      this.log("web_fetch", { url: logUrl(url), status: page.statusCode, chars: text.length, ms: Date.now() - t }, "completed");
      return { url: url.toString(), title, text, via: "fetch", truncated };
    } catch (err) {
      const e = this.failure(err, timeoutMs);
      this.log("web_fetch", { url: logUrl(url), ms: Date.now() - t }, `failed: ${e.code}`);
      throw e;
    }
  }

  /** A real browser, for pages that need JavaScript. One session per agent attempt; always released. */
  async renderPage(rawUrl: string): Promise<PageText> {
    const url = checkUrl(rawUrl);
    if (this.sessions >= this.limits.maxSessions) throw new WebToolError("budget", `browser session limit reached (${this.limits.maxSessions})`);
    const timeoutMs = this.take("render");
    this.sessions++;
    const t = Date.now();
    let sessionId: string | null = null;
    try {
      const session = await this.deps.createSession(SESSION_LIFETIME_S, this.signal, Math.min(20_000, timeoutMs));
      sessionId = session.id;
      this.log("web_session", { session: session.id }, "started");
      const page = await this.deps.render(session.connectUrl, url.toString(), Math.max(1000, timeoutMs - (Date.now() - t)), this.signal);
      const { text, truncated } = this.bound(cleanText(page.text));
      this.log("web_render", { url: logUrl(url), chars: text.length, ms: Date.now() - t }, "completed");
      return { url: page.url || url.toString(), title: page.title.slice(0, 200) || url.hostname, text, via: "render", truncated };
    } catch (err) {
      const e = this.failure(err, timeoutMs);
      this.log("web_render", { url: logUrl(url), ms: Date.now() - t }, `failed: ${e.code}`);
      throw e;
    } finally {
      if (sessionId) {
        try {
          await this.deps.releaseSession(sessionId);
          this.log("web_session", { session: sessionId }, "released");
        } catch (err) {
          // Browserbase still ends it when its lifetime runs out.
          this.log("web_session", { session: sessionId }, `release failed (${(err as Error)?.name ?? "error"}); ends after ${SESSION_LIFETIME_S}s`);
        }
      }
    }
  }

  /** Fetch, falling back to a real browser when the page is empty without JavaScript (and a session is left). */
  async readPage(rawUrl: string): Promise<PageText> {
    try {
      const page = await this.fetchPage(rawUrl);
      if (page.text.trim().length >= 300 || this.sessions >= this.limits.maxSessions) return page;
    } catch (err) {
      if (err instanceof WebToolError && ["blocked_url", "budget", "stopped", "not_configured"].includes(err.code)) throw err;
      if (this.sessions >= this.limits.maxSessions) throw err;
    }
    return this.renderPage(rawUrl);
  }
}

/** Web tools for one agent attempt, or null when Browserbase isn't configured. */
export function createWebTools(runId: string, agent: AgentName, signal: AbortSignal): WebTools | null {
  if (useEngine()) return new WebTools(runId, agent, signal, DEFAULT_LIMITS, engineDeps());
  return webToolsEnabled() ? new WebTools(runId, agent, signal) : null;
}
