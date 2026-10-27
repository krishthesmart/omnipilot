# OmniPilot online, free, with no time limit

**Oracle Cloud Always Free** gives you a small server that runs all the time at no cost, with no time
limit: up to 4 CPU cores, 24 GB of memory and 200 GB of disk (Ampere Arm). With a free **DuckDNS**
name and free **HTTPS** (Caddy + Let's Encrypt), OmniPilot gets a permanent address like
`https://myomnipilot.duckdns.org` that works even when your laptop is off.

Total cost: **$0**. (The AI uses Groq's free tier: free with a daily limit.)

Good to know first:
- **A card for verification:** Oracle asks for a card when you sign up to check you're a real person.
  Always Free resources aren't charged.
- **Idle reclaiming:** Oracle may reclaim an Always Free server that stays almost idle for 7 days.
  To prevent that, upgrade the account to **Pay As You Go** (Billing > Upgrade). It still costs $0 as
  long as you only use Always Free resources; set a $1 budget alert to be sure.
- **Capacity:** popular regions sometimes say "out of capacity" for Arm servers. Try again later or
  pick another availability domain; your home region can't be changed after sign-up.

## 1. Get a free Oracle Cloud server (15 minutes)

1. Sign up at **https://www.oracle.com/cloud/free/** (pick a home region near you).
2. In the console: **Compute > Instances > Create instance**.
   - **Image:** Canonical **Ubuntu 24.04**.
   - **Shape:** Ampere **VM.Standard.A1.Flex**, 2 OCPUs and 12 GB memory (plenty; still free).
   - **Networking:** keep the default VCN, with "Assign a public IPv4 address" on.
   - **SSH keys:** "Generate a key pair for me" and **download the private key**.
   - Create it, then copy its **Public IP address**.

## 2. Get a free address (2 minutes)

1. Go to **https://www.duckdns.org**, sign in (GitHub or Google).
2. Add a subdomain, e.g. `myomnipilot` (you'll get `myomnipilot.duckdns.org`).
3. Copy your **token** (shown at the top of the page).

## 3. Open the web ports in Oracle's firewall (2 minutes)

Instance page > **Subnet** link > **Security Lists** > Default Security List > **Add Ingress Rules**:
- Source CIDR `0.0.0.0/0`, IP protocol TCP, destination port **80**
- Source CIDR `0.0.0.0/0`, IP protocol TCP, destination port **443**

(The install script opens the same ports on the server itself.)

## 4. Copy OmniPilot to the server

On your Mac, from the OmniPilot folder (replace the key file and IP):

```bash
chmod 600 ~/Downloads/ssh-key-*.key
rsync -av -e "ssh -i ~/Downloads/ssh-key-XXXX.key" \
  --exclude node_modules --exclude training --exclude 'server/data' --exclude 'engine/.venv' \
  --exclude dist --exclude '.env' --exclude '.env.bak' --exclude 'server/workspace/projects' \
  ./ ubuntu@YOUR.SERVER.IP:~/omnipilot/
```

Your keys aren't copied; the installer asks for them. (Or put the code in a private GitHub repository
and `git clone` it on the server.)

## 5. Install (5–10 minutes)

```bash
ssh -i ~/Downloads/ssh-key-XXXX.key ubuntu@YOUR.SERVER.IP
cd ~/omnipilot
bash deploy/oracle/install.sh
```

It installs Docker, opens the ports, asks for your DuckDNS subdomain and token, an OmniPilot password
(or makes one), your Groq key and timezone, then builds and starts everything. When it finishes, open
**https://myomnipilot.duckdns.org** and sign in.

OmniPilot restarts by itself after crashes and server reboots, routines run on time, and the HTTPS
certificate renews automatically.

## Afterwards

- **Add optional keys** (E2B, Browserbase, Browser Use, Langfuse): `nano ~/omnipilot/server/.env`, then
  `bash deploy/oracle/install.sh` again.
- **Update:** copy the new code with the same `rsync` command, then run `bash deploy/oracle/install.sh`.
- **Logs:** `cd ~/omnipilot/deploy/oracle && sudo docker compose logs -f omnipilot`
- **Back up your data:**
  ```bash
  sudo docker run --rm -v oracle_omnipilot-data:/data -v ~/:/backup alpine tar czf /backup/omnipilot-backup.tgz -C /data .
  ```
- **Google Drive** on a server needs a **Web application** OAuth client in Google Cloud with the redirect
  URI `https://myomnipilot.duckdns.org/api/oauth/google/callback`.

## If the page doesn't load

- Check step 3 (both ports 80 and 443 in the Security List).
- `nslookup myomnipilot.duckdns.org` should show your server's IP.
- `cd ~/omnipilot/deploy/oracle && sudo docker compose logs caddy` shows certificate problems.

## Sharing with judges or classmates

Whoever has the password can use your connected accounts and keys. For a public demo, set up a second
free server (Oracle allows several within the free limits) with no personal accounts connected and its
own password.

## Other free options

- **A computer you already have** (Raspberry Pi, old laptop kept plugged in): run `npm run service:install`
  and `npm run share` (free Cloudflare Tunnel), plus the free permanent Worker link in
  `deploy/cloudflare-free`. Free, but only while that computer is on.
- **Google Cloud's free e2-micro** (1 GB memory) also never expires, but it's tight for OmniPilot.
