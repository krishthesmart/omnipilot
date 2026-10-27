#!/bin/sh
# Starts OmniPilot in a Cloudflare Container. The disk is wiped whenever the container sleeps, so:
#   1. the database and workspace are restored from R2 (if this fails, it stops: starting empty and
#      then syncing would overwrite your saved data);
#   2. OmniPilot runs under Litestream, which streams every database change to R2 within a second;
#   3. the workspace is synced to R2 every minute and once more when the container is stopped.
set -eu

if [ "${#OMNIPILOT_PASSWORD}" -lt 12 ]; then
  echo "OmniPilot: set the OMNIPILOT_PASSWORD secret (12+ characters). Not starting." >&2
  exit 1
fi

DB="$OMNIPILOT_DATA_DIR/omnipilot.sqlite"
mkdir -p "$OMNIPILOT_DATA_DIR"

if { [ -z "${R2_ACCOUNT_ID:-}" ] && [ -z "${R2_ENDPOINT:-}" ]; } || [ -z "${R2_ACCESS_KEY_ID:-}" ] || [ -z "${R2_SECRET_ACCESS_KEY:-}" ] || [ -z "${R2_BUCKET:-}" ]; then
  echo "OmniPilot: warning: R2 isn't configured, so everything is lost each time the container sleeps. See deploy/cloudflare/README.md." >&2
  [ -d "$OMNIPILOT_WORKSPACE" ] || { mkdir -p "$OMNIPILOT_WORKSPACE"; cp -R /app/server/workspace-seed/. "$OMNIPILOT_WORKSPACE/"; }
  cd /app/server && exec node dist/index.js
fi

# R2_ENDPOINT overrides the address (any S3-compatible storage, or a local stand-in for testing).
ENDPOINT="${R2_ENDPOINT:-https://${R2_ACCOUNT_ID:-}.r2.cloudflarestorage.com}"
cat > /tmp/litestream.yml <<YAML
dbs:
  - path: $DB
    replicas:
      - type: s3
        bucket: $R2_BUCKET
        path: db
        endpoint: $ENDPOINT
        region: auto
        force-path-style: true
        sync-interval: 1s
YAML
export LITESTREAM_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" LITESTREAM_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
export RCLONE_CONFIG_R2_TYPE=s3 RCLONE_CONFIG_R2_PROVIDER=Cloudflare RCLONE_CONFIG_R2_ENDPOINT="$ENDPOINT" \
  RCLONE_CONFIG_R2_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" RCLONE_CONFIG_R2_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY" \
  RCLONE_CONFIG_R2_NO_CHECK_BUCKET=true

echo "OmniPilot: restoring data from R2…"
litestream restore -config /tmp/litestream.yml -if-replica-exists -if-db-not-exists "$DB"
mkdir -p "$OMNIPILOT_WORKSPACE"
rclone copy "r2:$R2_BUCKET/workspace" "$OMNIPILOT_WORKSPACE" --quiet
# First start (nothing saved yet): the starter workspace.
[ -n "$(ls -A "$OMNIPILOT_WORKSPACE")" ] || cp -R /app/server/workspace-seed/. "$OMNIPILOT_WORKSPACE/"

sync_workspace() { rclone sync "$OMNIPILOT_WORKSPACE" "r2:$R2_BUCKET/workspace" --quiet --exclude ".omnipilot-tmp" || echo "OmniPilot: workspace sync failed (will retry)" >&2; }

(while sleep 60; do sync_workspace; done) &
SYNC_PID=$!

cd /app/server
litestream replicate -config /tmp/litestream.yml -exec "node dist/index.js" &
APP_PID=$!

stop() {
  kill -TERM "$APP_PID" 2>/dev/null || true   # Litestream stops OmniPilot and sends its last changes
  wait "$APP_PID" 2>/dev/null || true
  kill "$SYNC_PID" 2>/dev/null || true
  sync_workspace
  exit 0
}
trap stop TERM INT

wait "$APP_PID"
STATUS=$?
kill "$SYNC_PID" 2>/dev/null || true
sync_workspace
exit "$STATUS"
