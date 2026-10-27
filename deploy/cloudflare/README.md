# OmniPilot on Cloudflare

OmniPilot is a full Node.js server: it keeps a database, runs and tests code, and does long jobs.
A Cloudflare Worker alone can't do that (no file system, no running programs, short time limits).
So this sets up a small **Worker as the front door** and runs **OmniPilot in a Cloudflare Container**
behind it, with your data in **R2**:

- Your address is `https://omnipilot.<your-subdomain>.workers.dev`, with HTTPS from Cloudflare.
- The container **sleeps when nobody's using it** (no charge while asleep) and wakes on the next visit.
- A **cron** wakes it every 30 minutes so routines run (they run within half an hour of their time;
  see "Routines" below to make that exact).
- Cloudflare wipes a container's disk when it sleeps, so the database is streamed to R2 as it changes
  (Litestream) and the workspace files are synced to R2 every minute (rclone); both come back on wake.
- Hosted, OmniPilot asks for your password before anyone can use it.

## What it costs

Containers need the **Workers Paid plan ($5/month)**, which includes 25 GiB-hours of memory,
375 vCPU-minutes and 200 GB-hours of disk a month. With the `basic` instance (1/4 vCPU, 1 GiB, 4 GB),
rough estimates from [Cloudflare's prices](https://developers.cloudflare.com/containers/pricing/):

| How it runs | About |
|---|---|
| Sleeps when idle, cron every 30 min (default) | $5 + ~$3–4 a month |
| Always awake (cron every 5 min) | $5 + ~$7 a month |

R2 storage for OmniPilot's data stays inside R2's free allowance for one person.

## Set it up (once)

You need Docker running to deploy (it builds the image; e.g. `colima start`), and a Cloudflare account
on the Workers Paid plan.

```bash
cd deploy/cloudflare
npm install
npx wrangler login

# 1. A bucket for your data, and an R2 API token for it
npx wrangler r2 bucket create omnipilot-data
#    Dashboard > R2 > Manage API tokens > Create token: "Object Read & Write", only this bucket.
#    Note the Access Key ID, Secret Access Key, and your Account ID.

# 2. Secrets (each command asks for the value; they stay in Cloudflare)
npx wrangler secret put OMNIPILOT_PASSWORD        # 12+ characters: what you'll sign in with
npx wrangler secret put OMNIPILOT_CRON_SECRET     # any random text, e.g. from: openssl rand -hex 24
npx wrangler secret put GROQ_API_KEY
npx wrangler secret put R2_ACCOUNT_ID
npx wrangler secret put R2_ACCESS_KEY_ID
npx wrangler secret put R2_SECRET_ACCESS_KEY
#    Optional: E2B_API_KEY, BROWSERBASE_API_KEY, BROWSER_USE_API_KEY, LANGFUSE_PUBLIC_KEY,
#    LANGFUSE_SECRET_KEY, LANGFUSE_BASE_URL

# 3. Your address and timezone: edit "vars" in wrangler.jsonc
#    OMNIPILOT_PUBLIC_URL = "https://omnipilot.<your-subdomain>.workers.dev"
#    TZ = your timezone (routines run on it), e.g. "America/New_York"

# 4. Deploy (the first build takes a few minutes)
npx wrangler deploy
```

Open your address and sign in with your password. The first visit after it has been asleep takes a
few seconds while the container starts and restores your data.

## Your link

After `npx wrangler deploy`, Wrangler prints your address, for example
`https://omnipilot.<your-subdomain>.workers.dev` (your subdomain is under Workers & Pages > your
Worker > Settings > Domains & Routes; you can add your own domain there too). That link works from
any device; it asks for your password.

## Sharing it publicly (a demo for judges, teachers, classmates)

Don't share your own OmniPilot: whoever has the password can read your connected Gmail and Drive and
use your keys. Deploy a **separate demo copy** instead: its own link, its own empty data, none of your
accounts connected, and a password you're happy to share.

```bash
cd deploy/cloudflare
npx wrangler r2 bucket create omnipilot-demo-data

# Secrets for the demo copy (note --name): a password to share, the cron secret, Groq, and R2.
npx wrangler secret put OMNIPILOT_PASSWORD --name omnipilot-demo     # e.g. a phrase you put in your submission
npx wrangler secret put OMNIPILOT_CRON_SECRET --name omnipilot-demo
npx wrangler secret put GROQ_API_KEY --name omnipilot-demo
npx wrangler secret put R2_ACCOUNT_ID --name omnipilot-demo
npx wrangler secret put R2_ACCESS_KEY_ID --name omnipilot-demo
npx wrangler secret put R2_SECRET_ACCESS_KEY --name omnipilot-demo
#    Leave out E2B_API_KEY and BROWSER_USE_API_KEY unless you're happy to pay for visitors' use.

npx wrangler deploy --name omnipilot-demo \
  --var R2_BUCKET:omnipilot-demo-data \
  --var OMNIPILOT_PUBLIC_URL:https://omnipilot-demo.<your-subdomain>.workers.dev
```

Share `https://omnipilot-demo.<your-subdomain>.workers.dev` and the demo password. Visitors share your
Groq free-tier allowance (about 200,000 tokens per model per day), so a busy demo can run out; the
page then says so and when it resets. Before judging, run your demo prompts once: repeats are
answered from the cache instantly and don't use the allowance.

To take the demo down: `npx wrangler delete --name omnipilot-demo`.

## Routines

Routines run when OmniPilot is awake at or after their time. The cron in `wrangler.jsonc` decides how
often it wakes:

- `"*/30 * * * *"` (default): within 30 minutes of the time, low cost.
- `"*/5 * * * *"`: always awake, routines on time, higher cost.
- Your routines' own times, e.g. `["30 7 * * *", "0 16 * * *"]` for 7:30 and 16:00. Cron times are
  in **UTC**, so convert from your timezone.

## Google Drive

Hosted, Google sign-in needs a **Web application** OAuth client (Google Cloud > Credentials) with the
redirect URI `https://omnipilot.<your-subdomain>.workers.dev/api/oauth/google/callback`. A "Desktop app"
client only works when OmniPilot runs on your own computer.

## Updating and logs

```bash
npx wrangler deploy     # after pulling updates (rebuilds the image)
npx wrangler tail       # live logs from the Worker
```
