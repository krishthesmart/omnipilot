# Contributing

Thanks for helping! A few things to know:

## Setup

Node.js 22.13+ (`nvm use` picks it up from `.nvmrc`).

```bash
npm install
npm run doctor
npm run dev:server   # terminal 1
npm run dev:web      # terminal 2
```

## Before you open a pull request

- `npm test` passes. Tests don't need Ollama: model calls are switched off
  (`AGENT_LLM=off`, `ROUTER_MODE=heuristic`) or mocked.
- `npm run build` passes (it type-checks the server and the UI).
- New behavior comes with a test.

## Adding a specialist

1. Implement it in `server/src/agents/<name>.ts` (an `AgentFn` returning an
   `AgentResult`).
2. Add its name to `AGENT_NAMES` in `server/src/types.ts`.
3. Describe it in `server/src/agents/registry.ts`: description, routing
   keywords, which agents it builds on, time budget. Routing, the local-model
   prompt and coordination all read from there.
4. Register it in `server/src/agents/index.ts`, and add its icon and tagline in
   `web/src/agentMeta.ts`.

## Ground rules

- Keep it local and free: no paid APIs, no sending user data anywhere.
- Model output must have a deterministic fallback and be labeled as
  unverified.
- Anything that writes, connects or blocks must be gated (approval, PIN), never
  automatic.

How it fits together: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
