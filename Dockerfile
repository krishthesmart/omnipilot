# OmniPilot on an always-on server (so routines and the app keep working while your computer is off).
# Build:  docker build -t omnipilot .
# Run:    docker run -p 8080:8080 -v omnipilot-data:/data --env-file server/.env \
#           -e OMNIPILOT_PASSWORD='a long password' -e OMNIPILOT_PUBLIC_URL=https://your-address omnipilot
# See docs/DEPLOY.md (Fly.io, a home server, any VPS).

# --- build: install everything, compile the server and the web app ---
FROM node:22.13-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --include=dev --no-audit --no-fund
COPY server server
COPY web web
RUN npm run build --workspace server && npm run build --workspace web \
 && npm prune --omit=dev --workspaces --no-audit --no-fund

# --- run: Node + Python (CodePilot checks and tests Python code) ---
FROM node:22.13-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    OMNIPILOT_DATA_DIR=/data \
    OMNIPILOT_WORKSPACE=/data/workspace \
    PYTHON=python3
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/server/package.json server/
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/web/dist web/dist
# The starter workspace, copied to /data/workspace on first start.
COPY server/workspace/code server/workspace-seed/code
COPY server/workspace/docs server/workspace-seed/docs
COPY server/workspace/notes server/workspace-seed/notes
COPY server/workspace/robotics-arm server/workspace-seed/robotics-arm
COPY scripts/docker-entrypoint.sh /usr/local/bin/omnipilot-start
RUN chmod +x /usr/local/bin/omnipilot-start && mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["tini", "--", "omnipilot-start"]
