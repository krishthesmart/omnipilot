// A permanent link to OmniPilot on Cloudflare's free plan. OmniPilot runs on a free host (HOSTED_URL, e.g.
// Render) or on your computer (or any always-on machine) and is shared with `npm run share`, which opens a Cloudflare Tunnel at a new
// random address each time and saves that address here (in KV). This Worker forwards every visit
// to it, so the link you give people never changes. It only forwards: signing in, data and keys all
// stay with OmniPilot. Free plan limits (100,000 requests a day) are plenty for one person or a demo.

interface Env {
  LINK: KVNamespace;
  /** A hosted OmniPilot (e.g. https://omnipilot.onrender.com): when set, the link always goes there. */
  HOSTED_URL?: string;
}

const HOSTED = /^https:\/\/[a-z0-9-]+\.(onrender\.com|hf\.space)$/;

let cached: { target: string | null; at: number } | null = null;

async function target(env: Env): Promise<string | null> {
  if (env.HOSTED_URL && HOSTED.test(env.HOSTED_URL)) return env.HOSTED_URL;
  if (cached && Date.now() - cached.at < 15_000) return cached.target;
  const t = await env.LINK.get("target");
  cached = { target: t && /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/.test(t) ? t : null, at: Date.now() };
  return cached.target;
}

const offline = () =>
  new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>OmniPilot is offline</title>
<style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#f5f6f8;color:#1f2937}main{max-width:440px;padding:28px;background:#fff;border-radius:16px;box-shadow:0 4px 24px #0001;text-align:center}@media (prefers-color-scheme:dark){body{background:#111318;color:#e5e7eb}main{background:#1b1e24}}</style>
<main><h1>OmniPilot is offline</h1><p>The computer it runs on is off, asleep, or not sharing right now. Try again in a little while.</p></main>`,
    { status: 503, headers: { "content-type": "text/html; charset=utf-8", "retry-after": "60" } }
  );

export default {
  // Free hosts put an app to sleep when nobody visits (Render: after 15 minutes). A visit every 10 minutes
  // (wrangler.jsonc "triggers") keeps the hosted OmniPilot awake, so routines run and pages open instantly.
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    if (env.HOSTED_URL && HOSTED.test(env.HOSTED_URL)) await fetch(`${env.HOSTED_URL}/api/engine/health`).catch(() => undefined);
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const to = await target(env);
    if (!to) return offline();
    const url = new URL(request.url);
    const headers = new Headers(request.headers);
    // OmniPilot checks changes come from the address the visitor is on: tell it this one.
    headers.set("X-OmniPilot-Forwarded-Host", url.host);
    headers.set("X-Forwarded-Proto", "https");
    try {
      const res = await fetch(to + url.pathname + url.search, {
        method: request.method,
        headers,
        body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
        redirect: "manual",
      });
      // The tunnel answers 530/502 when OmniPilot's computer isn't connected.
      if (res.status === 530 || res.status === 502) return offline();
      return res;
    } catch {
      return offline();
    }
  },
};
