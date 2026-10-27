import { Container, getContainer } from "@cloudflare/containers";

// OmniPilot on Cloudflare. OmniPilot is a full Node.js server (a database, running and testing code,
// long jobs), which a Worker on its own can't run, so the Worker is a thin front door: every request
// goes to OmniPilot running in a Cloudflare Container. The container sleeps when nobody's using it
// (you pay only while it's awake) and wakes on the next visit or on the cron below, which runs due
// routines. Container disks are wiped when they sleep, so OmniPilot keeps its database and workspace
// in R2 (see Dockerfile.cloudflare and scripts/cloudflare-entrypoint.sh).

interface Env {
  OMNIPILOT: DurableObjectNamespace<OmniPilotContainer>;
  OMNIPILOT_PUBLIC_URL: string;
  TZ: string;
  SLEEP_AFTER: string;
  R2_BUCKET: string;
  [secret: string]: unknown;
}

/** Everything OmniPilot needs, passed to the container when it starts (secrets never leave Cloudflare). */
const FORWARD = [
  "OMNIPILOT_PASSWORD",
  "OMNIPILOT_PUBLIC_URL",
  "OMNIPILOT_CRON_SECRET",
  "TZ",
  "GROQ_API_KEY",
  "GROQ_DAILY_TOKENS",
  "R2_BUCKET",
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "E2B_API_KEY",
  "BROWSERBASE_API_KEY",
  "BROWSER_USE_API_KEY",
  "LANGFUSE_PUBLIC_KEY",
  "LANGFUSE_SECRET_KEY",
  "LANGFUSE_BASE_URL",
];

export class OmniPilotContainer extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = "15m";
  enableInternet = true; // Groq, R2, E2B, Browserbase...

  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
    this.sleepAfter = env.SLEEP_AFTER || "15m";
    this.envVars = Object.fromEntries(FORWARD.filter((k) => typeof env[k] === "string" && env[k]).map((k) => [k, env[k] as string]));
  }

  override onError(error: unknown) {
    console.error("OmniPilot container error:", error);
    throw error;
  }
}

/** The one OmniPilot (your data lives in a single instance). */
const omnipilot = (env: Env) => getContainer(env.OMNIPILOT, "main");

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!env.OMNIPILOT_PUBLIC_URL) return new Response("Set OMNIPILOT_PUBLIC_URL in wrangler.jsonc (your Worker's https address), then deploy again.", { status: 500 });
    const url = new URL(request.url);
    // OmniPilot checks it's being reached at its own address (sign-in protection).
    const headers = new Headers(request.headers);
    headers.set("X-Forwarded-Host", url.host);
    headers.set("X-Forwarded-Proto", url.protocol.replace(":", ""));
    const ip = request.headers.get("CF-Connecting-IP");
    if (ip) headers.set("X-Forwarded-For", ip);
    return omnipilot(env).fetch(new Request(request, { headers }));
  },

  // The cron: wake OmniPilot and run routines that are due.
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    if (typeof env.OMNIPILOT_CRON_SECRET !== "string") return console.error("Set the OMNIPILOT_CRON_SECRET secret so routines can run.");
    ctx.waitUntil(
      omnipilot(env)
        .fetch(new Request(`${env.OMNIPILOT_PUBLIC_URL || "https://omnipilot"}/api/routines/run-due`, { method: "POST", headers: { "X-OmniPilot-Cron": env.OMNIPILOT_CRON_SECRET, "X-Forwarded-For": "cron" } }))
        .then(async (r) => console.log("routines:", r.status, await r.text()))
        .catch((e) => console.error("Couldn't wake OmniPilot:", e))
    );
  },
};
