# Moving OmniPilot to Python

Decision (2026-10-18): every part of OmniPilot is to be Python, including the interface, and all new
work is written in Python.

## How

The Python front door (`engine/`) already receives every request. Features move to it one at a time:
when a feature is implemented in Python, the front door answers it itself instead of passing it to the
TypeScript engine (`server/`). OmniPilot keeps working at every step, and each step brings its tests
along (pytest).

## Stages

| Stage | What moves to Python | Status |
|---|---|---|
| 1 | Tool services (Exa, Tavily, SerpApi, You.com, Tabstack, LlamaParse, Mem0, Zep, Resend, Browserbase, Stagehand, Browser Use, Apify, E2B, Daytona, Context7, Composio, Trigger.dev, Langfuse checks), the tool router with shared budgets, caching, retries and cleanup; the local-first AI model service (Ollama + Groq fallback); service status and live checks | **Done** |
| 2 | Storage (database schema and access), sign-in and security, approvals and change sets, integrations (Slack, GitHub, Notion, Calendar, Gmail, Drive, MCP) | **Done**: `store.py`, `auth.py`, `patches.py`, `actions.py`, `integrations/`, routes in `api_stage2.py` and `brain/api.py` |
| 3 | The agents (Helper, CodePilot with the project builder, LearnPilot, ScienceLab, MathPilot, ScriptScholar, HardwarePilot, PicturePilot, SchoolPilot, WatcherPilot, InfraPilot, ModelPilot, PromptPilot), the router, coordinator, synthesizer, governance and learning | **Done**: the whole run engine is Python (`brain/`: pipeline, router, coordinator, orchestrator, synthesizer and review, governance, follow-ups, lessons, live events, Stop); identical to the TypeScript rules on 3,520 test requests (`tests/fixtures/routing_parity.json.gz`). All 13 agents run in Python (`brain/agents/`), each proven against the TypeScript agent's own answers (`tests/fixtures/agents/*.json.gz`, deliberate improvements listed in each fixture). CodePilot brings the snippet sandbox (`brain/sandbox.py`), the project checker (`brain/project_check.py`), E2B commands (`brain/cloud_run.py`), code alerts (`brain/code_watch.py`) and the `/api/code/*` routes (`brain/api_code.py`). Still in TypeScript: the background code-folder watcher and MathPilot's formula-search worker (CPU-heavy); the bridge (`brain/agents/bridge.py`) stays only as a fallback |
| 4 | The interface, rebuilt in Python with NiceGUI (chat, pages, 3D viewer via `ui.scene`, previews) | **Started**: the project workspace at `/app` (`engine/omnipilot_engine/ui/`: Home, Projects, project Overview / Conversations / Files / Runs / Settings, Activity, Connections). The classic React app at `/` remains until the workspace covers it; see docs/product/ |
| 5 | Remove `server/` and `web/`; launcher, background service, Docker and deploy files run the Python app only | |

## Parts that can't be Python

- The Chrome extension (WatcherPilot's blocker): browsers only run JavaScript extensions.
- The VS Code extension: VS Code extensions run JavaScript.
- Cloudflare Workers (`deploy/cloudflare*`): Python Workers are in beta; port once they're stable.

## How runs work while both engines run

- The Python engine owns every run (chat, `/api/ask`, skills and daily routines started by the TypeScript
  engine are handed to it through `/api/internal/run`).
- Agents that aren't ported yet run in the TypeScript engine via `/api/internal/agent/<name>`; their
  activity entries are forwarded to the Python live stream, and Stop or a timeout closes the call.
- `OMNIPILOT_RUNS=node` switches runs back to the TypeScript engine (a safety valve during the move).
- Agent time budgets are doubled while the model on this computer answers (`OMNIPILOT_BUDGET_SCALE`).

## Temporary bridges (removed in stage 5)

The TypeScript engine sends its AI calls to `/api/internal/llm` and its web search/page reads to
`/api/internal/tools/*` on the Python front door, so the local-first model and the tool router already
apply everywhere.
