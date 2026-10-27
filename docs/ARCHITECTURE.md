# OmniPilot architecture

How OmniPilot works inside, for contributors. For installing and using it, see the [README](../README.md).

## Architecture

```text
server/
  src/
    index.ts                  Starts the server on 127.0.0.1, prints local-AI status, graceful shutdown
    app.ts                    Express app: security middleware, API routes, serves the built UI
    types.ts                  Agent/Router/Synthesizer/Event contracts
    db.ts                     SQLite: runs, audit log, approvals, connectors, conversations, Watcher policy/events
    pipeline.ts               One message: follow-up resolution -> router -> coordinator -> synthesizer -> review
    coordinator.ts            Per-agent sub-tasks, dependency waves, result hand-off, reflection, gap cover
    orchestrator.ts           Runs one agent with its own timeout/retry, isolated from the others
    router/
      decisionModel.ts        Deterministic keyword classifier (keywords come from the registry)
      localModel.ts           Local-model routing: schema-constrained, few-shot, 3-sample vote
      route.ts                Hybrid entry point combining both
      router.ts               Reviews the draft: gaps, failures, pending approvals, clarifying question
    synthesizer/
      synthesizer.ts          Merges agent findings into one answer (streamed via the AI model)
    agents/
      registry.ts             Each agent's "tool manifest": description, keywords, dependencies, budget
      base.ts                 Shared helpers: results, audit logging, prior results, previous turn
      helper.ts codePilot.ts learnPilot.ts promptPilot.ts infraPilot.ts
      scienceLab.ts scriptScholar.ts watcherPilot.ts hardwarePilot.ts
    routes/                   chat (SSE), approvals, connectors, audit, watcher
    lib/
      llm.ts                  AI model calls (Groq via groq.ts): structured output, few-shot, streaming, majority vote
      conversation.ts         Follow-up rewriting and stored conversation turns
      sandbox.ts              Runs CodePilot's generated Python/JS with a denylist, empty env, timeout
      watcher.ts              WatcherPilot rules engine, policy storage, parent PIN (scrypt)
      circuits.ts             HardwarePilot guides, module catalog, draft validation + electrical checks
      security.ts             Local-only access, security headers, rate limiting, error handler
      status.ts               Local-AI status for the UI banner and startup message
      eventBus.ts audit.ts integrations.ts
  workspace/                  The "approved folder" Helper/CodePilot operate on
  tests/                      vitest suites (routing, coordination, agents, techniques, security, API...)

web/src/
  hooks/useRun.ts             Turns the SSE event stream into live view state
  components/                 ChatTurn, AgentCard, WiringDiagram, WatcherPanel, StatusBanner,
                              IntegrationsPanel, ApprovalCard, SourcesPanel, AuditPanel, ChatInput

extension/                    OmniPilot Watcher browser extension (Manifest V3)
scripts/                      doctor, package-extension, make-icons
```

**Stack**: Express + TypeScript + SQLite (Node's built-in `node:sqlite`, so nothing is compiled at install) on the server,
Server-Sent Events for live streaming, React + Vite on the client. Every
specialist is a deterministic, real implementation (static analysis rules, a
curated reference dataset, closed-form physics equations, a workspace-scoped
grep search, etc.), so the full pipeline works offline and deterministically
for tests even with no model or network available. The Router layers the AI
model (Groq) on top of that same deterministic classifier rather
than replacing it — see "The Router" below.

## The Router

Routing is **hybrid** (`router/route.ts`): the deterministic keyword
classifier (`router/decisionModel.ts`) and the AI model (Groq,
`router/routerModel.ts`) both run. The keyword classifier is precise but
brittle, and the model understands paraphrases but can over-select, so
they are combined like this:

- If keywords matched, the keyword picks are the plan. The model can confirm
  them but cannot add unrelated specialists (e.g. ScriptScholar for a
  "linked list" request).
- If no keywords matched, the model's picks replace the Helper default. This
  is where paraphrased requests benefit.
- The model alone never adds PromptPilot; it's added automatically for
  compound requests.

When keywords match, the plan is the keyword plan and the model isn't asked.
Otherwise, if the model is unavailable, times out, or returns something
unparseable or made up, `callRouterModel` returns `null` and the plan is
exactly the heuristic's. Either way the Router only selects specialists and
does none of their work. The UI shows which mode produced each plan (🧠
AI model / ⚡ heuristic) and, for each agent, why it was selected or
rejected.

If 3+ specialists are triggered, PromptPilot is added automatically to
decompose the compound request into per-specialist prompts. If nothing
matches, Helper (read-only) is the safe default rather than running
nothing.

`orchestrator.ts` then launches every selected agent **simultaneously**
(`Promise.all`), where each agent is wrapped so it can **never** reject the
overall call: it gets its own `AbortController`-based timeout, up to one
retry on timeout/unreachable failures, and always resolves to a terminal
`AgentResult`. A crash, timeout, or disconnect in one agent is caught,
logged, and reported as that agent's own terminal status — it cannot affect
or block any other agent (see `tests/orchestrator.test.ts`).

After the Synthesizer drafts a response, `router/router.ts` reviews it:
checks every planned agent is represented, flags findings with no attached
evidence, carries forward the Synthesizer's disclosed disagreements/gaps,
confirms no write/external action was auto-executed (only ever *proposed*,
gated behind the approvals flow), and assembles the final summary +
limitations. If **every** selected agent came back blocked/unusable, the
Router asks one focused clarifying question instead of answering; otherwise
it returns the final response.

## Getting more out of the model

Every model call goes to Groq (`lib/groq.ts`): `openai/gpt-oss-120b` with medium
reasoning, moving to `qwen/qwen3.8-27b` and `openai/gpt-oss-20b` when it's rate-limited.
On top of that, OmniPilot uses techniques that make model output more reliable
(several date from when it ran small local models, and still catch mistakes):

| Technique | Where | What it fixes |
|---|---|---|
| **Structured outputs** (JSON Schema via `response_format`) | Router, LearnPilot, Helper, CodePilot tests | Malformed/missing fields; invented agent names (enum) |
| **Few-shot examples** | Router, LearnPilot, Helper, CodePilot | Format and depth drift |
| **Self-consistency voting** | LearnPilot quiz key (re-checked per question), CodePilot tests (3 samples) | One-off mistakes, e.g. a wrong quiz answer key or a wrong expected value |
| **Hidden reasoning** (think, then answer) | Helper general questions | Arithmetic and multi-step slips |
| **Retrieval grounding** with `file:line` citations | Helper when your files match | Answers not based on your actual files |
| **Execute → repair → resample** (best-of-N) | CodePilot | Code that doesn't run or fails tests |
| **Sanity filters** | CodePilot tests | Misspelled function names (`ninth_prime` → `nth_prime`); tests with no clear expected result |

CodePilot runs generated Python/JavaScript in a throwaway temp directory
with an empty environment, a 5-second timeout, and a static denylist that
refuses code touching files, the network, processes or input. It's a guard
rail, not a security boundary; set `CODE_VERIFY=off` to never execute
generated code.

## How a message flows

OmniPilot works like an assistant with tools. The specialists are its
tools, and a lead plans, delegates, checks the results and answers:

1. **Understand.** Follow-ups ("now do it in javascript", "how do I fix the
   first one?") are rewritten into a standalone request using the previous
   turn (`lib/conversation.ts`). The UI shows "Understood as: ...", and every
   agent also sees the previous exchange.
2. **Choose tools.** Each specialist declares what it does, when to use it,
   whose results it builds on, and its time budget in one manifest
   (`agents/registry.ts`). The keyword router, the local-model router
   prompt, the dependency graph and the timeouts are all derived from it.
3. **Delegate and coordinate.** See *The Coordinator* below: per-agent
   sub-tasks, dependency waves, and results handed from agent to agent.
4. **Check results and re-plan.** After the planned work, the Coordinator
   checks whether the results point to a next step (Helper found code you
   asked to have checked → CodePilot). It runs at most one extra round, and
   none after a safety block. If no agent had a task, Helper answers
   directly.
5. **Answer.** Findings are merged into one reply, streamed to the UI as it
   is written.

Conversations are grouped by a `conversationId` (the UI's **New chat**
button starts a new one) and stored in the local database (the last 10
turns each; conversations older than 30 days are deleted).

## The Coordinator

The Router decides *who* is needed; `coordinator.ts` decides *what each agent
does and in what order*, the way a lead hands out work:

1. **Plan.** The request is split into clauses and each agent gets only its
   part ("Explain recursion" → LearnPilot, "write a factorial function" →
   CodePilot). "Summarize the findings" is left to the Synthesizer.
2. **Order.** Agents that build on another's output wait for it:
   LearnPilot teaches what CodePilot / ScienceLab / ScriptScholar produced, and
   CodePilot scans the files Helper located when asked to review code.
   A single-agent request never waits.
3. **Execute in waves.** Everything whose inputs are ready runs in
   parallel; upstream results are passed in as `context.priorResults`.
4. **Cover gaps.** A clause no selected agent claims, or a part an agent
   couldn't handle ("Not implemented"), goes to Helper, after the others.
   If any agent blocked the request on safety grounds, nothing else runs:
   splitting a request never lets part of a blocked request through.
5. **Combine.** The Synthesizer merges every answering agent's findings
   into one reply (via the AI model when several contributed).

The UI shows each agent's task, which agents it used ("used CodePilot") or
is waiting for, and the full coordination plan under the routing pill.

## Agents (all real, scoped functionality — nothing fabricated)

| Agent | What it actually does | Explicit limits |
|---|---|---|
| **InfraPilot** | Real connections to Slack, GitHub, Notion, Google Calendar, Gmail (read-only IMAP), Google Drive (Google sign-in) and MCP servers; reads (email, calendar, Drive files, read-only MCP tools) directly; anything that writes (Slack post, GitHub issue, Notion text, Gmail draft, new Drive doc, MCP tool, adding an MCP server) is stored with its exact parameters and runs only when approved. Skills, custom agents, daily routines. | Nothing is pre-connected. Never sends email; never changes or deletes existing Drive files. |
| **Helper** | Greps the approved `server/workspace/` folder for request keywords, returns `file:line` evidence. | Local-only; no external search. |
| **CodePilot** | Static scan (regex/pattern rule set: SQL/command injection, XSS, hardcoded secrets, `eval`, insecure cookies, unhandled errors) over a submitted snippet or the approved workspace; severity + confidence + concrete fix per finding; Learn Mode only on explicit request. | Pattern-based, not a full SAST/compiler-aware tool. |
| **PromptPilot** | Splits a compound request into clauses, routes each to the right specialist, preserves stated constraints (grade level, beginner, offline-only), emits a tool-specific prompt per clause. | Heuristic clause-splitting, not a full semantic parse. |
| **ScienceLab** | Runs closed-form simulations: projectile motion, logistic population growth, a single-layer soil-moisture bucket model — with adjustable inputs parsed from the request and all defaults disclosed. | Only these three simulation types; anything else returns "Not implemented." |
| **ScriptScholar** | Compares ancient scripts (Egyptian Hieroglyphs, Sumerian Cuneiform, Phoenician, Greek, Linear A/B, Brahmi) from a curated reference set; explicitly flags undeciphered/disputed scripts with lower confidence. | Fixed reference set only; says "Not implemented" for scripts outside it. |
| **LearnPilot** | Grade-aware explanations/practice/flashcards/quizzes from a curated content bank per concept area; infers concept/grade when unstated and discloses the assumption; hard safety gate blocks cheating requests ("do my homework for me") and unsafe content. | Content bank, not open-ended generation; blocked requests return `failed_safe` with the reason stated. |
| **WatcherPilot** | Parent-set focus sessions, like GoGuardian. "Learn math for 1 hour, no AI" becomes a session that blocks AI tools and answer solvers (ChatGPT, Gemini, Photomath, Brainly…), switches off AI browser extensions, and allows only on-task sites. Enforced by the **OmniPilot Watcher** browser extension (`extension/`). | Rules only change with the parent PIN (Watcher panel), never from chat. Covers browsers with the extension installed; locking down private windows or other browsers needs Chrome policies or a child account. |
| **MathPilot** | Two jobs. (1) Checks identities you give it with a safe expression parser (no `eval`): constant identities to ~13 digits, variable identities at 40 points (simple values first for readable counterexamples, then random ones), infinite sums/products by Richardson extrapolation. The verdict is computed; the model only explains it, and an explanation that contradicts the verdict is dropped. (2) An always-on background search (`lib/math/discovery.ts`) over polynomial continued fractions, Ramanujan-Machine style: a double-precision pass matches each value against (p + q·c)/(r + s·c) for 8 constants, then hits are recomputed with 60-digit BigInt fixed-point arithmetic (`lib/math/precise.ts`, constants computed from series, not typed in) and kept only at ≥ 20 matching digits. Shifted copies of a fraction are grouped as one family. Progress and results persist in SQLite. | Results are numerical conjectures, not proofs; novelty isn't checked against the literature. No complex numbers in the checker. The search runs in 15 ms slices with 60 ms rests (about 20% of one core); pause in the UI or `MATHPILOT=off`. |
| **PicturePilot** | The model plans a scene (scene type + objects from a fixed 31-shape vocabulary, positions, sizes, colours) under a JSON schema; `lib/picture.ts` validates it (known kinds only, numbers clamped, colours limited to hex/named), repairs layout (frame bounds, sky vs ground, spreading stacked objects, minimum sizes) and draws an SVG. Without a model, a keyword planner does the same. | The model never writes SVG/markup, so its output can't inject anything. Illustrations are simple shapes. No video. Unsafe requests and realistic pictures of real people are refused (`failed_safe`). |
| **HardwarePilot** | Shows how to connect hardware with an interactive, step-by-step wiring diagram that plays like a video, plus safety notes, starter code and links to real videos. Covers 11 hand-checked Arduino/Pi/PC guides and 11 generated module guides (joystick, PIR, I2C LCD/OLED, relay…); LearnPilot builds on it to explain the concepts. | Parts outside the library get a model draft only if it passes electrical checks (no shorts, no rail-to-signal wiring, steps match the wires); otherwise it says so rather than guessing. |

Every agent returns the full contract from the spec: `agent`, `status`
(`success | partial_success | needs_connection | missing_permissions |
timeout | unreachable | failed_safe | needs_approval`), `findings`,
`evidence`, `confidence`, `limitations`, `proposedActions` (each tagged with
`riskLevel` and `requiresApproval`).

## Security model

- **What leaves the machine.** Model calls go to Groq (requests, and web pages
  agents read); voice recordings are transcribed locally by Whisper and chats
  stay in the local database. Agents read files under
  `server/workspace/` and the local SQLite database. Two exceptions, both
  bounded: CodePilot runs the Python/JavaScript it writes in a throwaway
  sandbox (`CODE_VERIFY=off` disables this), and WatcherPilot stores the
  parent's focus rules, PIN-protected and with the PIN stored only as a
  salted scrypt hash.
- **SDK access is opt-in and narrow.** By default the server listens on
  127.0.0.1 and rejects other hosts and web origins. Setting `HOST=0.0.0.0`
  requires `OMNIPILOT_API_TOKEN` (16+ characters; the server refuses to start
  without it). A bearer token is compared in constant time and only opens
  `/api/ask`, `/api/chat`, `/api/runs/*`, `/api/status` and the read/check
  MathPilot endpoints, and only for non-browser clients (requests with an
  `Origin` are refused), so a web page can't use a token and a token can't
  reach integrations, approvals or Watcher settings.
- **Voice stays in the browser.** Speech recognition and synthesis are the
  browser's own (Web Speech API); the server only ever receives text. The UI
  requests on-device recognition where supported and says when it isn't.
- **Least privilege.** InfraPilot can only *read* connector status and
  *propose* actions — it has no code path that performs a write or calls an
  external API.
- **Explicit approval for writes.** Any `proposedAction` with
  `requiresApproval: true` is recorded in the `approvals` table as `pending`
  and rendered as an Approval Card; nothing executes until
  `POST /api/approvals/:id/decision` is called, and a decision can only be
  made once (subsequent attempts 409).
- **No secrets in chat/logs/frontend.** `lib/audit.ts` redacts any parameter
  key matching `/key|token|secret|password|authorization/i` before it is
  persisted or broadcast to the UI.
- **Full audit trail.** Every tool call (agent start/complete/retry, Router
  decisions, Synthesizer runs, approval decisions, connector changes) is
  logged with timestamp, agent, action, parameters, and outcome, queryable
  via `GET /api/audit` and shown live in the Activity/Audit tab.
- **No fabrication.** Agents either return real findings sourced from code
  they examined/data they hold, or an explicit `"Not implemented"` /
  `"Not connected"` / blocked status — never a placeholder dressed up as a
  result.

## Known limitations

- The model router and agent generation need a Groq key and an internet
  connection. Without them, routing is exactly as flexible as the keyword
  classifier alone, and agents use only their deterministic paths. Requests
  are sent to Groq. Groq's free tier limits tokens per minute; busy periods
  fall back to its smaller models. Model output is always labelled as unverified.
- CodePilot and ScriptScholar operate over fixed rule/reference sets; they
  are explicit about their boundaries rather than attempting fuzzy,
  unverifiable judgments outside them.
- Every integration is real. Slack, GitHub and Notion are verified with a pasted token; Google
  Calendar with its secret iCal address; Gmail with an app password over read-only IMAP; Google
  Drive with Google's own sign-in (OAuth 2.0 for desktop apps with PKCE, using the user's free client
  ID; refresh tokens are rotated automatically); MCP servers over stdio or Streamable HTTP after the
  user approves the exact command or address. Anything that changes something outside OmniPilot is
  stored with its exact parameters and runs only when approved. Tokens are stored locally in SQLite
  (never logged, never returned by the API); for a production deployment they should be encrypted at rest.
- Voice input depends on the browser: Chrome/Edge/Safari support it, Firefox
  doesn't; Chrome uses Google's speech service unless on-device recognition
  is available.
- PicturePilot's illustrations are built from a fixed set of shapes; it doesn't
  make photo-style pictures.
- The AI model is chosen in `server/.env` (`GROQ_MODEL`, `GROQ_FALLBACK_MODELS`,
  `GROQ_REASONING`; see `lib/groq.ts`). The only model that runs locally is
  Whisper, for voice input (`engine/omnipilot_engine/speech.py`).
- Chat history: `conversation_runs` maps runs to conversations; a run that's no
  longer in the in-memory event bus is replayed from its saved record, so old
  chats render after a restart.
- Stop: `lib/runControl.ts` holds one AbortController per run; agents, the
  streamed answer and the coordinator's follow-up steps all watch it.
- The SSE stream is per-process, in-memory (with history replay for late
  subscribers); it isn't designed to survive a server restart mid-run.

## Trying the full workflow

### Via the UI
Send exactly:

> Research how to improve my project, check my code for issues, create a
> study plan for the relevant concept, and summarize the findings.

You'll see: a plan selecting **Helper, CodePilot, LearnPilot, PromptPilot**;
four agent cards transition queued → running → success in parallel with live
elapsed timers; a "Synthesizer combining…" status; a "Router reviewing…"
status; approval cards for CodePilot's proposed fixes (it finds real
SQL‑injection / command‑injection / XSS / hardcoded‑secret / insecure‑cookie
issues in the seeded `server/workspace/code/legacy-login.js`); and a final
tabbed answer (Final Answer / Agent Findings / Sources‑Evidence /
Activity‑Audit).

### Via curl
```bash
curl -s -X POST http://localhost:8899/api/chat -H 'Content-Type: application/json' \
  -d '{"message":"Research how to improve my project, check my code for issues, create a study plan for the relevant concept, and summarize the findings."}'
# -> {"runId":"..."}

curl -s http://localhost:8899/api/runs/<runId> | jq .
curl -N http://localhost:8899/api/runs/<runId>/events   # live SSE stream (replays history + live)
curl -s "http://localhost:8899/api/approvals?runId=<runId>" | jq .
curl -s "http://localhost:8899/api/audit?runId=<runId>" | jq .
```

### Other scenarios worth trying
- `"Can you do my homework for me and submit it?"` → LearnPilot's safety gate
  blocks it; since no usable agent result exists, the Router asks one
  clarifying question instead of fabricating an answer.
- `"Connect Slack and schedule a daily status update"` → InfraPilot honestly
  reports `needs_connection` and renders a connector card; open
  **Integrations** to actually verify a real Slack bot token against
  Slack's own API.
- `"Simulate a projectile launched at 30 m/s at 60 degrees"` → ScienceLab
  runs a real deterministic physics calculation.
- `"Compare Linear A and Linear B"` → ScriptScholar compares them using its
  curated reference set and explicitly flags that Linear A is undeciphered.
