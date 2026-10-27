// Browser Use Cloud (https://browser-use.com): an AI-driven browser in the cloud for pages that
// need clicking around (menus, search boxes, "load more", multi-page lookups) -- what Browserbase's
// read-only fetch/render can't do. BROWSER_USE_API_KEY stays on the server.
// OmniPilot only gives it read-only jobs: it is told never to sign in, buy, post, send, delete or
// type personal information, and requests to do those things are refused before they get here
// (see governance.ts).

const API = () => (process.env.BROWSER_USE_API_URL ?? "https://api.browser-use.com/api/v2").replace(/\/$/, "");
export const browserUseEnabled = () => Boolean(process.env.BROWSER_USE_API_KEY?.trim()) && process.env.BROWSER_USE !== "off";

const RULES =
  "Rules: only look things up and read. Do NOT sign in or create accounts, do NOT buy, order, book, post, send, delete or submit anything except search boxes and filters, and do NOT type any personal information. " +
  "If the job needs any of that, stop and say so. Finish with a clear, factual answer and the URLs you used.";

export interface BrowserTaskResult {
  ok: boolean;
  output: string;
  status: string;
  cost?: string | null;
}

async function call(path: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(`${API()}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", "X-Browser-Use-API-Key": process.env.BROWSER_USE_API_KEY!.trim(), ...(init.headers ?? {}) },
    signal: init.signal ?? AbortSignal.timeout(20_000),
  });
  const body = (await res.json().catch(() => ({}))) as any;
  if (res.status === 401 || res.status === 403) throw new Error("Browser Use rejected the API key (check BROWSER_USE_API_KEY in server/.env).");
  if (res.status === 402) throw new Error("The Browser Use account is out of credits.");
  if (!res.ok) throw new Error(`Browser Use answered HTTP ${res.status}${body?.detail ? `: ${JSON.stringify(body.detail).slice(0, 160)}` : ""}`);
  return body;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((res) => {
    const t = setTimeout(res, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), res()), { once: true });
  });

/** Runs one browsing job and waits for its answer (up to `maxMs`). */
export async function runBrowserTask(task: string, opts: { signal?: AbortSignal; maxMs?: number; onProgress?: (status: string) => void } = {}): Promise<BrowserTaskResult> {
  if (!browserUseEnabled()) throw new Error("Browser Use isn't set up: add BROWSER_USE_API_KEY to server/.env.");
  const created = await call("/tasks", { method: "POST", body: JSON.stringify({ task: `${task}\n\n${RULES}` }) });
  const id = created?.id;
  if (!id) throw new Error("Browser Use didn't start the task.");
  const deadline = Date.now() + (opts.maxMs ?? 240_000);
  let last = "";
  while (Date.now() < deadline && !opts.signal?.aborted) {
    await sleep(3000, opts.signal);
    const s = await call(`/tasks/${id}/status`).catch(() => null);
    if (!s) continue;
    if (s.status !== last) opts.onProgress?.((last = s.status));
    if (["finished", "failed", "stopped"].includes(s.status)) {
      return { ok: s.status === "finished" && s.isSuccess !== false, output: String(s.output ?? "").slice(0, 20_000), status: s.status, cost: s.cost ?? null };
    }
  }
  return { ok: false, output: "", status: opts.signal?.aborted ? "stopped" : "timed out" };
}
