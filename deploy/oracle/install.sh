#!/usr/bin/env bash
# Installs OmniPilot on a fresh Ubuntu server (Oracle Cloud Always Free, or any Linux VM) so it runs
# all the time at https://<name>.duckdns.org. Run from the OmniPilot folder on the server:
#   bash deploy/oracle/install.sh
# Safe to run again (to change settings or update after copying new code).
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(cd ../.. && pwd)"
say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
ask() { local prompt="$1" default="${2:-}" reply; read -r -p "$prompt${default:+ [$default]}: " reply; echo "${reply:-$default}"; }
asksecret() { local prompt="$1" reply; read -r -s -p "$prompt: " reply; echo >&2; echo "$reply"; }

if ! command -v sudo >/dev/null; then echo "Run this as a user with sudo." >&2; exit 1; fi

say "1/5  Docker"
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sudo sh
  sudo usermod -aG docker "$USER" || true
fi
DOCKER="docker"; docker info >/dev/null 2>&1 || DOCKER="sudo docker"

say "2/5  Opening ports 80 and 443 on this server's firewall"
# Oracle's Ubuntu images block everything but SSH in iptables, in addition to the cloud firewall.
if sudo iptables -L INPUT -n 2>/dev/null | grep -q "REJECT"; then
  for port in 80 443; do
    if ! sudo iptables -C INPUT -p tcp --dport "$port" -m state --state NEW -j ACCEPT 2>/dev/null; then
      # Just before the first REJECT rule, so it takes effect.
      at="$(sudo iptables -L INPUT --line-numbers -n | awk '/REJECT/ {print $1; exit}')"
      sudo iptables -I INPUT "${at:-1}" -p tcp --dport "$port" -m state --state NEW -j ACCEPT
    fi
  done
  command -v netfilter-persistent >/dev/null || sudo DEBIAN_FRONTEND=noninteractive apt-get install -y iptables-persistent >/dev/null
  sudo netfilter-persistent save >/dev/null
fi
echo "Done. (Also open ports 80 and 443 in Oracle's console: see README.md, step 3.)"

say "3/5  Your free address (DuckDNS)"
[ -f .env ] && set -a && . ./.env && set +a
SUB="$(ask "DuckDNS subdomain (the part before .duckdns.org)" "${DUCKDNS_SUBDOMAIN:-}")"
TOKEN="${DUCKDNS_TOKEN:-}"; [ -n "$TOKEN" ] || TOKEN="$(asksecret "DuckDNS token (from duckdns.org, shown at the top after you sign in)")"
TZ_="$(ask "Your timezone (routines run on it)" "${TZ:-$(cat /etc/timezone 2>/dev/null || echo America/New_York)}")"
umask 077
cat > .env <<ENV
OMNIPILOT_DOMAIN=${SUB}.duckdns.org
DUCKDNS_SUBDOMAIN=${SUB}
DUCKDNS_TOKEN=${TOKEN}
TZ=${TZ_}
ENV
curl -fsS "https://www.duckdns.org/update?domains=${SUB}&token=${TOKEN}&ip=" | grep -q OK && echo "${SUB}.duckdns.org now points to this server." || echo "DuckDNS didn't accept that subdomain/token; check them and run this again."

say "4/5  OmniPilot settings (server/.env)"
touch "$ROOT/server/.env"; chmod 600 "$ROOT/server/.env"
setkey() { # setkey NAME VALUE: add or replace a line in server/.env
  local name="$1" value="$2" file="$ROOT/server/.env"
  grep -v "^${name}=" "$file" > "$file.tmp" || true; printf '%s=%s\n' "$name" "$value" >> "$file.tmp"; mv "$file.tmp" "$file"; chmod 600 "$file"
}
if ! grep -q '^OMNIPILOT_PASSWORD=.\{12,\}' "$ROOT/server/.env"; then
  PW="$(asksecret "Choose a password for OmniPilot (12+ characters; blank = make one for me)")"
  if [ -z "$PW" ]; then PW="$(openssl rand -base64 18 | tr -d '/+=' )"; echo "Your OmniPilot password: $PW   (save it somewhere safe)"; fi
  [ "${#PW}" -ge 12 ] || { echo "That password is too short." >&2; exit 1; }
  setkey OMNIPILOT_PASSWORD "$PW"
fi
if ! grep -q '^GROQ_API_KEY=.\+' "$ROOT/server/.env"; then
  setkey GROQ_API_KEY "$(asksecret "Groq API key (free at console.groq.com/keys)")"
fi
echo "Optional keys (E2B, Browserbase, Browser Use, Langfuse...) can be added to server/.env later; then run this again."

say "5/5  Building and starting (the first build takes a few minutes)"
$DOCKER compose up -d --build
for i in $(seq 1 60); do
  $DOCKER compose exec -T omnipilot node -e "fetch('http://127.0.0.1:8080/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null && break
  sleep 3
done

say "OmniPilot is running at https://${SUB}.duckdns.org"
echo "Sign in with your OMNIPILOT_PASSWORD. It restarts by itself after crashes and reboots."
echo "(The HTTPS certificate can take a minute on first start. If the page won't load, check README.md, step 3.)"
echo "Logs: $DOCKER compose -f $PWD/docker-compose.yml logs -f omnipilot"
