// Reads a page in a Browserbase cloud browser over the Chrome DevTools
// Protocol, using Node's built-in WebSocket (no Playwright needed). Read-only
// by construction: it can only open one URL and read the page's title and
// visible text. There is no click, type, form or script-injection command.

export interface RenderedPage {
  title: string;
  url: string;
  text: string;
}

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };

/** The fixed, read-only expression evaluated in the page (never built from input). */
const READ_PAGE = "JSON.stringify({ title: document.title, url: location.href, text: document.body ? document.body.innerText.slice(0, 200000) : '' })";

export async function renderPageText(connectUrl: string, url: string, timeoutMs: number, signal?: AbortSignal): Promise<RenderedPage> {
  const ws = new WebSocket(connectUrl);
  const pending = new Map<number, Pending>();
  const listeners = new Set<(msg: any) => void>();
  let nextId = 1;
  let timer: NodeJS.Timeout | undefined;

  const fail = (err: Error) => {
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  };
  ws.addEventListener("message", (ev) => {
    let msg: any;
    try {
      msg = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    if (typeof msg.id === "number" && pending.has(msg.id)) {
      const p = pending.get(msg.id)!;
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`browser: ${String(msg.error.message ?? "error").slice(0, 120)}`));
      else p.resolve(msg.result);
    } else for (const l of listeners) l(msg);
  });
  ws.addEventListener("close", () => fail(new Error("browser connection closed")));
  ws.addEventListener("error", () => fail(new Error("browser connection failed")));

  const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string) =>
    new Promise<any>((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });

  const work = (async () => {
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", () => reject(new Error("couldn't connect to the browser")), { once: true });
    });
    const { targetInfos } = await send("Target.getTargets");
    let targetId: string | undefined = (targetInfos as any[])?.find((t) => t.type === "page")?.targetId;
    if (!targetId) targetId = (await send("Target.createTarget", { url: "about:blank" })).targetId;
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    await send("Page.enable", {}, sessionId);
    const loaded = new Promise<void>((resolve) => {
      const onMsg = (msg: any) => {
        if (msg.sessionId === sessionId && msg.method === "Page.loadEventFired") {
          listeners.delete(onMsg);
          resolve();
        }
      };
      listeners.add(onMsg);
    });
    const nav = await send("Page.navigate", { url }, sessionId);
    if (nav?.errorText) throw new Error(`couldn't open the page (${String(nav.errorText).slice(0, 80)})`);
    await loaded;
    const out = await send("Runtime.evaluate", { expression: READ_PAGE, returnByValue: true }, sessionId);
    const page = JSON.parse(out?.result?.value ?? "{}");
    return { title: String(page.title ?? ""), url: String(page.url ?? url), text: String(page.text ?? "") };
  })();

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
  });
  const stopped = new Promise<never>((_, reject) => {
    if (signal?.aborted) reject(new Error("stopped"));
    signal?.addEventListener("abort", () => reject(new Error("stopped")), { once: true });
  });
  try {
    return await Promise.race([work, timeout, stopped]);
  } finally {
    clearTimeout(timer);
    try {
      ws.close();
    } catch {
      // already closed
    }
  }
}
