# OmniPilot on a free Hugging Face Space (Docker): the whole stack in one container, the same way it runs on
# your computer -- the Python front door and engine, the TypeScript engine, the web app, and the local AI
# model (Ollama, qwen3:4b-instruct) with Groq for hard jobs. Free "CPU basic" hardware: 2 vCPUs, 16 GB RAM.
# Data (database, workspace, encyclopedia) is kept in a private Hugging Face dataset (see deploy/cloud/datasync.py).
# Note: Hugging Face now requires a PRO subscription for Docker Spaces.
# Deployed by scripts/deploy_hf.py, which uploads this file as the Space's Dockerfile. See README.md here.

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

# --- the local AI model runtime, with the models built in (no download on every start) ---
FROM debian:bookworm-slim AS models
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl zstd && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://github.com/ollama/ollama/releases/download/v0.34.2/ollama-linux-amd64.tar.zst | tar --zstd -x -C /usr \
 && rm -rf /usr/lib/ollama/cuda_* /usr/lib/ollama/rocm* /usr/lib/ollama/vulkan*
ENV OLLAMA_MODELS=/opt/ollama/models
RUN mkdir -p $OLLAMA_MODELS && (ollama serve >/tmp/ollama.log 2>&1 &) \
 && for i in $(seq 1 30); do curl -sf http://127.0.0.1:11434/api/tags >/dev/null && break; sleep 1; done \
 && ollama pull qwen3:4b-instruct && ollama pull nomic-embed-text

# --- run ---
FROM node:22.13-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl tini sqlite3 && rm -rf /var/lib/apt/lists/*
COPY --from=ghcr.io/astral-sh/uv:0.9.18 /uv /uvx /usr/local/bin/
COPY --from=models /usr/bin/ollama /usr/bin/ollama
COPY --from=models /usr/lib/ollama /usr/lib/ollama
COPY --from=models /opt/ollama /opt/ollama
# Hugging Face runs the container as user 1000 (the node image's "node" user).
WORKDIR /app
ENV HOME=/home/node \
    UV_PYTHON_INSTALL_DIR=/opt/uv-python \
    UV_PROJECT_ENVIRONMENT=/app/engine/.venv \
    UV_PYTHON=3.12 \
    UV_LINK_MODE=copy \
    OLLAMA_MODELS=/opt/ollama/models \
    NODE_ENV=production \
    PORT=7860
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
RUN mkdir -p /data /app/server/data && chown -R 1000:1000 /app /data /opt/ollama
USER 1000
EXPOSE 7860
ENTRYPOINT ["tini", "--", "/app/engine/.venv/bin/python", "/app/deploy/cloud/launch.py"]
