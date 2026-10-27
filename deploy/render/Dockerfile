# OmniPilot on Render's free plan (512 MB memory, a tenth of a CPU): the Python front door and engine, the
# TypeScript engine and the web app in one container. The plan is too small for the local AI model and
# Whisper, so answers come from Groq and speech from Deepgram. Render's disk is wiped on every restart, so
# the data lives in a private Hugging Face dataset (deploy/cloud/datasync.py). See deploy/render/README.md.

# --- build the TypeScript engine and the web app ---
FROM node:22.13-bookworm-slim AS web
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --include=dev --no-audit --no-fund
COPY shared shared
COPY server server
COPY web web
RUN npm run build --workspace server && npm run build --workspace web \
 && npm prune --omit=dev --workspaces --no-audit --no-fund

# --- run ---
FROM node:22.13-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates tini && rm -rf /var/lib/apt/lists/*
COPY --from=ghcr.io/astral-sh/uv:0.9.18 /uv /uvx /usr/local/bin/
WORKDIR /app
ENV HOME=/home/node \
    UV_PYTHON_INSTALL_DIR=/opt/uv-python \
    UV_PROJECT_ENVIRONMENT=/app/engine/.venv \
    UV_PYTHON=3.12 \
    UV_LINK_MODE=copy \
    NODE_ENV=production \
    NODE_OPTIONS=--max-old-space-size=192 \
    MALLOC_ARENA_MAX=2 \
    OMNIPILOT_DATA_DIR=/data \
    PORT=10000
COPY engine/pyproject.toml engine/uv.lock engine/
RUN uv sync --frozen --no-dev --project engine && chown -R 1000:1000 /opt/uv-python
COPY --from=web /app/package.json ./
COPY --from=web /app/node_modules node_modules
COPY --from=web /app/server/package.json server/
COPY --from=web /app/server/dist server/dist
COPY --from=web /app/web/dist web/dist
COPY shared shared
COPY engine/omnipilot_engine engine/omnipilot_engine
COPY server/workspace server/workspace-seed
COPY deploy/cloud/launch.py deploy/cloud/datasync.py deploy/cloud/
RUN mkdir -p /data /app/server/data && chown -R 1000:1000 /app /data
USER 1000
EXPOSE 10000
ENTRYPOINT ["tini", "--", "/app/engine/.venv/bin/python", "/app/deploy/cloud/launch.py"]
