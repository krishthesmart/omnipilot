// Browserbase REST client (https://docs.browserbase.com): Search, Fetch, and
// browser sessions. Server-side only: BROWSERBASE_API_KEY comes from
// server/.env and is never sent to the browser, logged, or returned. Agents
// don't use this directly; they go through the limited, logged tools in
// webTools.ts.

const apiBase = () => (process.env.BROWSERBASE_API_URL ?? "https://api.browserbase.com").replace(/\/$/, "");

export const browserbaseKey = (): string | null => process.env.BROWSERBASE_API_KEY?.trim() || null;

/** Web tools are on when a key is set (WEB_TOOLS=off turns them off). */
export const webToolsEnabled = () => Boolean(browserbaseKey()) && process.env.WEB_TOOLS !== "off";

export class BrowserbaseError extends Error {
  constructor(
    readonly code: "not_configured" | "timeout" | "http_error" | "network_error" | "bad_response",
    message: string,
    readonly status?: number
  ) {
    super(message);
    this.name = "BrowserbaseError";
  }
}

async function post<T>(path: string, body: unknown, signal: AbortSignal | undefined, timeoutMs: number): Promise<T> {
  const key = browserbaseKey();
  if (!key) throw new BrowserbaseError("not_configured", "BROWSERBASE_API_KEY isn't set");
  // One controller with a plain timer (held until the call ends), rather than AbortSignal.any: a merged
  // signal's time limit can fail to cancel the request, which once let a stalled search run 200 s.
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onStop = () => controller.abort();
  signal?.addEventListener("abort", onStop, { once: true });
  try {
    let res: Response;
    try {
      res = await fetch(`${apiBase()}${path}`, {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json", "X-BB-API-Key": key },
        body: JSON.stringify(body),
      });
    } catch (err: any) {
      if (timedOut) throw new BrowserbaseError("timeout", `Browserbase didn't answer within ${Math.round(timeoutMs / 1000)}s`);
      if (signal?.aborted) throw err; // the run was stopped: let that propagate
      throw new BrowserbaseError("network_error", "Couldn't reach Browserbase");
    }
    // Reading the body is covered by the same time limit.
    const data = (await res.json().catch(() => null)) as any;
    if (timedOut) throw new BrowserbaseError("timeout", `Browserbase didn't finish answering within ${Math.round(timeoutMs / 1000)}s`);
    if (!res.ok) {
      // Browserbase's own error message (bounded); never echo request headers.
      const message = typeof data?.message === "string" ? data.message.slice(0, 200) : `HTTP ${res.status}`;
      throw new BrowserbaseError("http_error", message, res.status);
    }
    if (data === null) throw new BrowserbaseError("bad_response", "Browserbase returned no JSON");
    return data as T;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onStop);
  }
}

export interface SearchResult {
  title: string;
  url: string;
  publishedDate?: string;
}

/** POST /v1/search -- titles and URLs only (no snippets). */
export async function bbSearch(query: string, numResults: number, signal?: AbortSignal, timeoutMs = 15_000): Promise<SearchResult[]> {
  const data = await post<{ results?: { title?: string; url?: string; publishedDate?: string }[] }>(
    "/v1/search",
    { query: query.slice(0, 200), numResults: Math.max(1, Math.min(25, numResults)) },
    signal,
    timeoutMs
  );
  return (data.results ?? [])
    .filter((r) => typeof r.url === "string")
    .map((r) => ({ title: String(r.title ?? r.url).slice(0, 200), url: r.url!, ...(r.publishedDate ? { publishedDate: r.publishedDate } : {}) }));
}

export interface FetchedPage {
  statusCode: number;
  content: string;
  contentType: string;
}

/** POST /v1/fetch as markdown. No JavaScript, 5 MB and 60 s limits (Browserbase's). */
export async function bbFetch(url: string, signal?: AbortSignal, timeoutMs = 30_000): Promise<FetchedPage> {
  const data = await post<{ statusCode?: number; content?: unknown; contentType?: string; encoding?: string }>(
    "/v1/fetch",
    { url, format: "markdown", allowRedirects: true },
    signal,
    timeoutMs
  );
  const content = data.encoding === "base64" || typeof data.content !== "string" ? "" : data.content;
  return { statusCode: Number(data.statusCode ?? 0), content, contentType: String(data.contentType ?? "") };
}

export interface BrowserSession {
  id: string;
  connectUrl: string;
}

/** POST /v1/sessions. Browserbase ends the session by itself after `lifetimeS` even if release fails. */
export async function bbCreateSession(lifetimeS: number, signal?: AbortSignal, timeoutMs = 20_000): Promise<BrowserSession> {
  const data = await post<{ id?: string; connectUrl?: string }>("/v1/sessions", { timeout: Math.max(60, lifetimeS) }, signal, timeoutMs);
  if (!data.id || !data.connectUrl) throw new BrowserbaseError("bad_response", "Browserbase didn't return a session");
  return { id: data.id, connectUrl: data.connectUrl };
}

/** POST /v1/sessions/{id} { status: REQUEST_RELEASE } -- ends the session now. Not tied to the run's signal: cleanup must happen even after a stop. */
export async function bbReleaseSession(id: string, timeoutMs = 15_000): Promise<void> {
  await post(`/v1/sessions/${encodeURIComponent(id)}`, { status: "REQUEST_RELEASE" }, undefined, timeoutMs);
}
