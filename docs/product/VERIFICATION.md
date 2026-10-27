# Verification results

## 2026-10-21: slice 1 (projects foundation)

### Automated

| Command | Result |
|---|---|
| `cd engine && uv run pytest -q` | **172 passed**: 158 existing tests, plus 14 new ones in `tests/test_projects.py` |
| `cd engine && uv run pytest -q tests/test_projects.py` | 14 passed |

New tests cover:
- CRUD and persistence after a store reset.
- Validation.
- Isolation between projects: another project's file, conversation and message ids return 404; search is scoped;
  project files are hidden from workspace search.
- Devices that aren't signed in, and SDK tokens, get no access.
- Roles enforced in the backend (viewer can't edit; non-members get 404).
- File safety: traversal, folders, hidden files, programs, empty files, the size limit, no silent overwrite,
  downloads always attachments.
- Duplication copies settings and files only.
- Cross-project copy needs confirmation.
- Delete needs the exact name, and removes the folder.
- Export contains no secret values.
- Project runs are recorded in the project, and agents get only its folder and facts.
- CodePilot change paths inside a project resolve to the workspace root.
- Home is built from recorded state only.
- Per-endpoint upload limits.

### Live (OmniPilot started on a copy of the real database and workspace, real local model)

Driven in Chrome with argent:
1. **Migration:** the copy of the existing database gained the new tables and the `runs.project_id` column on
   start. Existing runs were untouched.
2. **Workspace:** Home loaded with real pending approvals, an empty project list and the empty-state text.
3. **Create a project by keyboard only:** "Soil moisture study", with a requirement and a constraint, created
   through the New project dialog. The record was saved correctly and survived a server restart.
4. **Second project (via API):** "Website redesign", with a different constraint, two acceptance criteria and
   its own file.
5. **Conversation in the Soil project:** asked "which soil kept the most moisture?". The local model answered
   "peat, 63%", citing `soil-readings.txt:1`, the project's own file.
6. **Same question in the Website project:** "I cannot access your files or soil readings". The run is recorded
   under "Website redesign", so isolation holds.
7. **Sign-in:** a visitor from another device who isn't signed in gets a 303 redirect from `/app/` to sign-in.
8. **Content-security rules:** the workspace's own rules were checked on `/app/` responses.

### Found by the live inspection and fixed

- **Mixed dark/light colours:** NiceGUI followed the system's dark mode. Fixed to light theme.
- **Every in-app link went to `/app/app/...`:** NiceGUI adds its mount prefix itself. Links are now relative,
  and outbound links (downloads, the classic chat) are plain escaped anchors.
- **Sign-in redirect could loop:** it is now a real HTTP 303.
- **Oversized headings in answers:** scaled down.

### Not verified yet

- The delete, duplicate and copy dialogs were built, and their logic is tested through the API, but they weren't
  clicked through live.
- File upload through the browser widget (tested through the API).
- Dark mode, narrow (phone) widths, screen-reader announcements.

## 2026-10-21: slice 2 (Project DNA, Assumption Inbox, preferences)

### Automated

| Command | Result |
|---|---|
| `cd engine && uv run pytest -q` | **183 passed** (11 new in `tests/test_project_dna.py`) |
| `uvx ruff@0.13.0 check --select E9,F,B …` on the new files | All checks passed |

New tests cover:
- Provenance on every entry.
- Agents can't confirm or edit.
- Observations need a file and go stale when it changes.
- Decisions need a rationale, keep history, and are superseded.
- Assumptions: corrected becomes a confirmed fact with its source; dismissed creates no fact; a correction needs its text.
- Isolation between projects (404s, empty search).
- Export includes DNA history and excludes preferences; duplicates are marked as copies.
- Runs get confirmed facts and preferences but not suggestions.
- Post-run suggestions are unverified only (with a labelled fake model), and no model means no suggestions.
- Preference limits.

### Live (same copies, real local model, argent)

1. Asked "how long will peat take to drop below 30%?" in the Soil project. The model then suggested three consequential assumptions (constant evaporation rate, stable greenhouse, the 63% reading being representative). All were unverified, and Project DNA stayed empty.
2. In the browser: confirmed one, which became "confirmed by you · from a confirmed assumption · v1" in Project DNA. Dismissed another, and the tab label updated to "Assumptions (1)".
3. **Bug found and fixed:** tabs were drawn once at page load, so a change in one tab didn't show in another. Each tab is now redrawn from fresh data when opened.

### Not verified live yet

The DNA edit, supersede and history dialogs, the observed-from-file flow in the UI, and the Settings → preferences page. All are covered by API tests.

## 2026-10-21: slices 3–9

### Automated

| Command | Result |
|---|---|
| `cd engine && uv run pytest -q` | **208 passed** (25 new in `tests/test_work.py`) |
| `npm test` (TypeScript) | **446 passed** (55 files) |
| `uvx ruff@0.13.0 check --select E9,F,B` on every changed or new Python file | All checks passed |

No test calls a real model or service; agents, models, Slack and the sandboxed interpreter are replaced by labelled fakes where needed.

### Live (copy of the real database and workspace, real local model, Groq for hard jobs; API plus argent in Chrome)

1. **Task with contract:** "Rank soils by moisture retention" ran as attempt 1.
   - The baseline router label was recorded.
   - Usage was captured: 1 local call, 1096+42 tokens, "no charge".
   - A person recorded supporting evidence, and the acceptance check was passed with it.
2. **Change Radar:** replacing `soil-readings.txt` raised an alert on the task that mentions it. It was resolved in the browser.
3. **Challenge My Plan:** the local model returned 5 specific weak assumptions.
4. **Comparison Bench (simulation):** peat ended at 47.35%, clay at 26.59%, over 7 days.
5. **Learn Mode:** "check my explanation" got feedback from the local model.
6. **Handoff Capsule:** a teammate capsule was made, with the AI disclosure.
7. **Code change end to end:** "Fix add() in calc.py".
   - CodePilot proposed a one-file change. The diff is correct.
   - The Permission Preview showed action, target, scope, what won't change, undo and binding.
   - Approving it in the workspace applied it. The task became completed.
   - An "applied" receipt was pinned to the new checksum.
   - Running `add(2, 3)` returned 5. That was recorded as test evidence, and the check was passed.
8. **Readiness Check** in the browser:
   - Tests passed.
   - Requirement coverage failed (a requirement without a check).
   - Handoff failed (older than the latest change).
   - Privacy passed, after the fix below.
   - The disclaimer was shown.
9. **Settings & Permissions** (grants grid, budget, usage totals) and the **Recipes** page rendered.

### Found by the live run and fixed (each with a regression test)

- Agents answering with `partial_success` or `needs_approval` were recorded as failed steps.
- The export-privacy check flagged ordinary words such as `task_attempt_finished` as secrets.
- Evidence recorded by a person about a file didn't pin the file's checksum, so changing the file raised only a "suspected" alert.
- Proposed-change evidence used the workspace path instead of the project's file name.
- CodePilot couldn't edit a project's own files; see D15. An acceptance check like `add(2, 3) == 5` in the request was also mistaken for pasted code.

### Not verified live

- Restart recovery (interrupted / uncertain), resume deduplication and step retry. Covered by tests.
- Branches, code and prompt comparisons, recipes being run, routines firing, and granting a connection by clicking. Covered by tests.
- A paid tool being stopped by the budget. Covered by tests.
## 2026-10-24: run status settled after approval

The run record kept status "needs approval" even after every approval on it was decided. Now `approvals.settle_run`
marks a run "completed" once nothing on it is still pending (on approve, deny, or when a task is stopped). Two new
tests in `tests/test_work.py` cover it, including that a run with another approval still pending is left waiting.
`uv run pytest -q`: **217 passed**.

## 2026-10-21: Router + six specialists (D16)

| Command | Result |
|---|---|
| `cd engine && uv run pytest -q` | **215 passed** (7 new in `tests/test_specialists.py`; the parity test lists the deliberate renames) |
| `npm test` | **446 passed** |
| `npx tsc --noEmit` (web), `npm run build` | Clean |

**Live** (database copy, local model): "Draw a rocket flying past Saturn" ran as Helper (pictures). "Quiz me on how soil holds water" ran as ScienceLab and Helper (lessons & quizzes). The activity log for those runs has only System, Router, Synthesizer, Helper and ScienceLab.

## 2026-10-24: conversation runs metered

`pipeline.execute_run` now sets a usage sink for any run that a task attempt isn't already metering, and persists the
summary on the run record; `project_usage` returns these under `conversationRuns` and folds them into the totals.
New test `test_conversation_runs_are_metered_too` (faked local model) confirms the run record and the usage view both
show it. `uv run pytest -q`: **218 passed**; `npm test`: **446 passed**.

## 2026-10-24: model reasoning captured and shown

The LLM layer captures a model's reasoning when asked (`reasoning=True`), apart from the answer: Groq gpt-oss's
`reasoning` field and (opt-in) Ollama's `thinking`. The run-level sink in `pipeline.execute_run` collects it onto
the run record; the final synthesis (`compose_answer`) is the only step that asks to reason. The workspace shows a
"Model reasoning" block on task attempts and conversation answers.

New tests in `tests/test_work.py`:
- `test_the_model_reasoning_is_captured_separately_from_the_answer`: with reasoning off nothing is captured; with
  it on, the reasoning is captured and never leaks into the answer.
- `test_a_run_collects_reasoning_onto_its_record`: the reasoning sink is active during a run and a composed
  answer's reasoning lands on the run record.

`uv run pytest -q`: **220 passed**; ruff clean.

**Not verified live:** Ollama has no model pulled in this environment and the installed background service holds
port 8899, so an end-to-end live run wasn't possible this session. Local reasoning is also off by default (see
D17), so a live check would exercise the Groq path (a real external call, which tests avoid).

## 2026-10-24: ChatGPT-style chat, verified live

The project Conversations tab was rebuilt as a ChatGPT-style chat (rail + centered thread + rounded composer),
over the unchanged `start_project_run` backend. Verified live by running just the Python engine (uvicorn) on a
temp database on port 8901 — so the installed service on 8899 and real data were untouched — seeding a two-turn
conversation (one with reasoning), and driving Chrome with argent:
- The chat renders with You/OmniPilot turns, avatars, separators, and the pinned composer.
- Clicking the OmniPilot logo turns on a "reasoning on" badge.
- The "Model reasoning" block under the first answer expands to show the disclaimer, the model ("qwen3:4b on this
  computer") and the reasoning text — separate from the answer.

`uv run pytest -q`: **221 passed**; ruff clean; UI modules import. (The brief blip when the shared uvicorn pattern
was matched during cleanup self-healed via the service's KeepAlive.)

## 2026-10-25: workspace visual refresh

The whole workspace was restyled into one cohesive modern look (a single `_STYLE` block in `ui/pages.py`): Inter
font, soft neutral palette with design tokens, gentle card shadows and rounded corners, a polished sidebar
(hover + indigo active pill), a cleaner header with a logo mark, dark code blocks and better markdown typography,
and a refined chat (bordered card holding the rail + thread, nicer avatars, a focus-ring composer). No backend or
data changes. Verified live in Chrome (Python engine on a temp DB, port 8902, real service untouched): the chat,
the logo reasoning toggle, and the Home page all render cleanly. `pytest`: **221 passed**; ruff clean.

## 2026-10-25: Blender as a one-click MCP connection

Added a Blender MCP preset (`uvx blender-mcp`) surfaced in Connections, added via the existing approval + grant
flow. New tests in `tests/test_connections.py`:
- the Blender preset exists with the right command/args;
- propose -> Permission Preview -> approve installs it (the actual `uvx` run is mocked);
- calling a Blender MCP tool inside a project is blocked until the project is granted "MCP servers" write.

Verified live (Python engine on a temp DB, port 8903; real service on 8899 untouched): the Blender preset shows
on Connections, and clicking "Add" routes to Activity & Approvals with the full Permission Preview
(Action/Target/Scope/undo/fingerprint). `uv run pytest -q`: **224 passed**; ruff clean on changed files.

## 2026-10-25: NVIDIA provider + MCP added from the UI

NVIDIA NIM added as an OpenAI-compatible provider (shared `_cloud` path with Groq). New tests in
`tests/test_llm_providers.py`: reasoning-field handling (`reasoning` / `reasoning_content`); hard jobs try NVIDIA
first; ordinary jobs stay local and never touch cloud; usage + reasoning recorded for the cloud provider that
answers. Conftest sets `NVIDIA_API_KEY=""` so tests never call it.

Connections now has an "Add your own MCP server" form (remote URL — no local program — or local command),
proposing the existing `mcp_add_server` action. New test in `tests/test_connections.py` covers adding a remote
server by URL through approval with no local program. Verified live (temp DB, port 8904; real service untouched):
the form renders with the URL/command toggle; the Blender preset and its Add→approval flow still work.

`uv run pytest -q`: **230 passed**; ruff clean on changed files.

## 2026-10-25: .env keys are case-forgiving

A key written as `Nvidia_API_Key` in the root `.env` wasn't found because env var names are case-sensitive and the
code reads `NVIDIA_API_KEY`. `envfiles.load` now also registers the UPPER_CASE name for any `.env` key, so any
casing works. Confirmed the real root `.env` now resolves `NVIDIA_API_KEY` (valid `nvapi-` key). New test
`test_env_keys_are_case_forgiving`. `uv run pytest -q`: **231 passed**.

## 2026-10-25: Smart mode + most-powerful NVIDIA model

Added `llm.smart_mode()`/`set_smart_mode` and an Answer-quality card in Settings. Smart routes ordinary answers
cloud-first; default stays local-first (existing `test_answers_on_this_computer_first` still passes). NVIDIA
default model set to `meta/llama-3.1-405b-instruct` first. New tests: smart mode sends ordinary jobs cloud-first;
smart mode is off by default and toggles. `uv run pytest -q`: **233 passed**; ruff clean.

## 2026-10-25: functiongemma tool model

Added `llm.tool_model()` (default `functiongemma`, env `OMNIPILOT_TOOL_MODEL`) and `llm.choose_tool_json` (tool
model first, normal model as fallback), wired into MCP tool selection. A local-model override flows through
`chat`/`generate_json`/`_local`. New tests: tool choice uses functiongemma then falls back; a specific local model
can be requested. `uv run pytest -q`: **235 passed**; ruff clean.

## 2026-10-25: background service fixed (uv PATH + bootstrap)

The service wouldn't start: (1) macOS returned "Bootstrap failed: 5: Input/output error" when bootstrapping before
the old job finished unloading; (2) a `npm run share` had started its own OmniPilot holding port 8899; (3) the
service PATH lacked `~/.local/bin`, so `uv` wasn't found and only the legacy engine ran (no Python workspace,
NVIDIA or smart answers). Fixes in `scripts/service.mjs`: wait for full unload + retry bootstrap + `kickstart`; and
`servicePath()` now always includes `~/.local/bin`, `~/.cargo/bin`, homebrew and node@22 so uv/cloudflared are
found. Reinstalled and verified: service Running, `/api/engine/health` → `{engine: python}`, `/app/` → 200, keys
loaded (Infisical + root `.env`). Added `npm run service:share` (restart the service, then share publicly). No
engine/Python code changed this step, so the test suite is unchanged (235 passed).

## 2026-10-25: share no longer spawns a duplicate server

`npm run service:share` restarted the service then ran `share` immediately, so `share` hit the still-booting
service, decided nothing was running, and started its own copy — which collided on port 8898 and died (and left a
stale URL in the worker KV). Fixes: added `node scripts/service.mjs wait` (polls the health endpoint up to 90s) and
put it between restart and share in the `service:share` script. Verified: after wait, `share` prints "Using the
OmniPilot already running on port 8899" (one `start.mjs`, no duplicate); direct trycloudflare link and the
permanent workers.dev link both return 200.

## 2026-10-25: routing — games vs 3D models

`routing.route_request` now sends 3D/2D games and game genres to CodePilot and single 3D models/molecules to the
model skill. New `tests/test_routing.py` (18 cases) covers games→CodePilot, models→model skill, and a spectrum of
common requests to the right specialist. Service restarted to load the fix (health ok; public link 200).
`uv run pytest -q`: **253 passed**; ruff clean.
