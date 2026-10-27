#!/bin/sh
# Starts OmniPilot in its container: refuses to run on the internet without a password, seeds the
# workspace on first start, then runs the server (data lives in /data, which survives restarts).
set -e
if [ "${#OMNIPILOT_PASSWORD}" -lt 12 ]; then
  echo "OmniPilot: set OMNIPILOT_PASSWORD (12+ characters) so only you can sign in. Not starting." >&2
  exit 1
fi
if [ -z "$OMNIPILOT_PUBLIC_URL" ]; then
  echo "OmniPilot: warning: OMNIPILOT_PUBLIC_URL isn't set (e.g. https://my-omnipilot.fly.dev); sign-in protection works best with it." >&2
fi
if [ ! -d "$OMNIPILOT_WORKSPACE" ]; then
  mkdir -p "$OMNIPILOT_WORKSPACE"
  cp -R /app/server/workspace-seed/. "$OMNIPILOT_WORKSPACE/"
fi
cd /app/server
exec node dist/index.js
