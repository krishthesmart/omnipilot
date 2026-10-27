# Keeping OmniPilot running

Routines and the app need OmniPilot to be running. There are two ways, depending on whether your
computer stays on.

## 1. On your computer, in the background (no terminal, no `caffeinate`)

```bash
npm run service:install     # builds once, then runs OmniPilot as a background service
npm run service:status      # running? where are the logs?
npm run service:restart     # after changing server/.env or updating (rebuilds)
npm run service:uninstall   # stop and remove it
```

OmniPilot then starts by itself when you log in, restarts if it ever stops, and doesn't rebuild every
time (unlike `npm start`). It uses the Node.js of the terminal you install it from (22.13 or newer).

**When the computer sleeps (lid closed), nothing on it can run**, including OmniPilot. Routines whose
time passed while it slept run as soon as it wakes. To keep OmniPilot working while your computer is
off, host it on a server (below).

## 2. On an always-on server

OmniPilot comes as a Docker image. Hosted, it asks for a password (`OMNIPILOT_PASSWORD`) before
anyone can use it; it refuses to start without one.

What changes when hosted:
- Set `TZ` to your timezone (e.g. `TZ=America/New_York`): servers run on UTC, and routines run on this clock.
- Your data (chats, routines, connections) lives on the server's disk (`/data`), not your computer.
- Its workspace is `/data/workspace` (the starter files are copied there on first start).
- Voice input uses your browser's speech recognition (the local Whisper model isn't in the image).
- Google Drive sign-in needs a **Web application** OAuth client in Google Cloud with the redirect URI
  `https://<your address>/api/oauth/google/callback` (a Desktop client only works on your computer).

### Free with no time limit: Oracle Cloud Always Free (recommended)

A free always-on server (up to 4 Arm cores, 24 GB memory), a free `https://<name>.duckdns.org` address
and free HTTPS, set up with one script: [deploy/oracle/README.md](../deploy/oracle/README.md). $0, works
while your computer is off.

### Cloudflare's free plan: a public link to OmniPilot on your computer

`npm run share` gives the OmniPilot on your computer a public `https://` link with a free Cloudflare
Tunnel (visitors sign in with your password), and an optional free Worker makes that link permanent.
It works while the computer is on and awake. Steps: [deploy/cloudflare-free/README.md](../deploy/cloudflare-free/README.md).

### Cloudflare (Worker + Container + R2)

A Worker as the front door and OmniPilot in a Cloudflare Container that sleeps when idle, with your data
kept in R2. Needs the Workers Paid plan ($5/month) plus roughly $3–7/month of container time. Steps:
[deploy/cloudflare/README.md](../deploy/cloudflare/README.md).

### Fly.io (about $2–5 a month for a small always-on machine)

```bash
fly launch --no-deploy --copy-config        # choose a unique app name
fly volumes create omnipilot_data --size 1  # 1 GB disk for your data
fly secrets set OMNIPILOT_PASSWORD='a long password' \
  OMNIPILOT_PUBLIC_URL=https://<app-name>.fly.dev \
  GROQ_API_KEY=gsk_...                      # plus any optional keys (E2B_API_KEY, BROWSERBASE_API_KEY...)
fly deploy
```

Open `https://<app-name>.fly.dev` and sign in with your password. `fly.toml` keeps one machine running
all the time, which routines need.

### A home server, Raspberry Pi, or any VPS (Docker Compose)

Put your keys, `OMNIPILOT_PASSWORD` and `OMNIPILOT_PUBLIC_URL` in `server/.env`, then:

```bash
docker compose up -d
```

It listens on port 8080. Put it behind HTTPS (Caddy, Cloudflare Tunnel or Tailscale) before
using it over the internet; sign-in cookies are marked Secure when `OMNIPILOT_PUBLIC_URL` is https.
Free always-on options include Oracle Cloud's Always Free VM, or a Raspberry Pi at home with a
Cloudflare Tunnel.

## Security when hosted

- Requests from anywhere but the server itself need you signed in (a 30-day session cookie:
  HttpOnly, SameSite=Lax, Secure over https). Changing `OMNIPILOT_PASSWORD` signs every device out.
- Only OmniPilot's own address (`OMNIPILOT_PUBLIC_URL`) may make changes through your session, so
  other websites can't act as you. Wrong passwords are limited to 10 tries per 15 minutes.
- Everything that changes something outside OmniPilot still waits for your approval.
