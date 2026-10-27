# A public OmniPilot link on Cloudflare's free plan

Cloudflare's free plan can't run OmniPilot itself (that needs Containers, on the $5 Workers Paid plan;
see `../cloudflare`). But two free Cloudflare tools give OmniPilot a public `https://` link:

1. **Cloudflare Tunnel** (free, no account needed): `npm run share` shares the OmniPilot on your
   computer at a `https://<random-words>.trycloudflare.com` address. Nothing is opened on your router.
2. **A free Worker** (optional, free Cloudflare account): a permanent
   `https://omnipilot-link.<your-subdomain>.workers.dev` address that always forwards to your latest
   tunnel, so the link you share never changes.

Visitors must sign in with your `OMNIPILOT_PASSWORD`. The link works while the computer running
OmniPilot is **on and awake**. For a link that never sleeps, run OmniPilot (and `npm run share`) on an
always-on machine: Oracle Cloud's Always Free VM, a Raspberry Pi, or an old laptop that stays plugged in.

## 1. Share it now (2 minutes)

```bash
brew install cloudflared          # once (Apple Silicon Macs: use /opt/homebrew's brew)
```

Add a password to `server/.env` (12+ characters):

```
OMNIPILOT_PASSWORD=pick-a-long-password-here
```

Then:

```bash
npm run share
```

It prints your link. If OmniPilot is already running (`npm start` or the background service), it shares
that one; restart it once after adding the password. Press Ctrl-C to stop sharing.

## 2. A permanent link (free Worker, 5 minutes, once)

```bash
cd deploy/cloudflare-free
npm install
npx wrangler login                          # free Cloudflare account
npx wrangler kv namespace create LINK       # prints an id
```

Put that id in `wrangler.jsonc` (replace `REPLACE_WITH_YOUR_KV_NAMESPACE_ID`), then:

```bash
npx wrangler deploy                         # prints https://omnipilot-link.<your-subdomain>.workers.dev
```

Optionally add `OMNIPILOT_SHARE_LINK=https://omnipilot-link.<your-subdomain>.workers.dev` to
`server/.env`, so `npm run share` prints it. From now on, every `npm run share` points your permanent
link at the new tunnel automatically. When OmniPilot isn't being shared, the link shows a friendly
"OmniPilot is offline" page.

## Sharing it with judges or classmates

Whoever has the password can use everything you've connected (Gmail, Drive...) and your API keys. For a
public demo, run a separate copy with no personal accounts connected and its own password (a different
folder with its own `server/.env`), and share that one.

## Good to know

- Free quick tunnels don't pass live streams, so answers appear all at once instead of word by word.
  Everything else works the same.
- Cloudflare's free quick tunnels are meant for testing and demos (no uptime guarantee, up to 200 requests
  at a time). For a stable, always-on setup, use a named tunnel on your own domain, or the paid
  Cloudflare Containers setup in `../cloudflare`.
- The free Worker allows 100,000 requests a day, far more than one person or a demo needs.
