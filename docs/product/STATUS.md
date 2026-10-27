# Implementation status

Statuses:
- **Not started**
- **Partial:** some of it exists.
- **Implemented:** built, but not fully verified.
- **Verified:** automated tests plus a live check.
- **Blocked**

"Implemented" and "verified" are different. Last updated: 2026-10-21 (slices 1–9).

## Slice 1: projects, access boundaries, files, conversations (this session)

| Feature | Status | Notes |
|---|---|---|
| Projects: create / rename / edit fields / archive / restore | **Verified** | `projects.py`, `api_projects.py`. Pytest, plus created live through the workspace dialog (keyboard only) |
| Persistence across restarts | **Verified** | Shared SQLite schema; checked by a test and by restarting the server live |
| Delete with scope preview + typed confirmation | **Verified** (API/tests) | UI dialog built; not yet driven live |
| Export (JSON, secrets scrubbed) | **Verified** (tests) | Markdown export comes with Handoff Capsules (slice 8) |
| Duplicate with preview (no history, grants or credentials) | **Verified** (tests) | UI dialog built |
| Cross-project file copy (preview + confirm) | **Verified** (tests) | UI dialog built |
| Project-scoped search | **Verified** (tests) | Fields, conversations, answers, file contents |
| Multiple conversations per project | **Verified** | Created and used live |
| Project chat: agents see only that project's files | **Verified** | Test, plus live: the Soil project answered from its file; the Website project could not see it |
| Files: upload / download / delete, validation, path-traversal protection | **Verified** (tests) | 5 MB per file, 500 per project, program files refused, downloads always attachments |
| Access checks in the backend (membership + role) | **Verified** (tests) | Single owner today, roles stored and enforced (see DECISIONS.md D3) |
| SDK tokens / signed-out devices get no project access | **Verified** (tests + live redirect) | |
| Activity history per project | **Implemented** | Feeds Home; Return Briefing builds on it later |
| Home (recent projects, activity, approvals, blocked runs, next steps) | **Implemented** | Next steps are derived only from recorded fields |
| NiceGUI workspace at `/app` (Home, Projects, project tabs, Activity, Connections) | **Implemented** | Inspected live with argent. Light theme only for now |
| Project Settings & Permissions (per-project connection grants) | **Verified** | Built in slice 9; see below |

## Slice 2: Project DNA, decisions, Assumption Inbox, personal preferences

| Feature | Status | Notes |
|---|---|---|
| Project DNA entries (goal, requirement, constraint, file ref, decision, open question, known problem, assumption) with basis, source, actor, version, timestamps | **Verified** | `project_dna.py`. Pytest, plus seen live in the DNA tab |
| Confirmed / observed / suggested kept distinct; only a person can confirm; agents can't edit | **Verified** (tests) | Enforced in the backend |
| Observations cite a project file + checksum and are flagged when it changes | **Verified** (tests) | |
| Decisions need a rationale; edit history; superseded, never overwritten | **Verified** (tests) | UI dialogs built; history dialog not yet clicked live |
| Assumption Inbox: confirm / correct / dismiss; confirmed or corrected ones can become DNA with provenance | **Verified** | Tests, plus confirmed and dismissed live in the browser |
| Suggested assumptions after a project run (consequential only, max 3, unverified) | **Verified** | Test with a labelled fake model, plus live with the local model (3 sensible suggestions; none became facts) |
| Runs receive confirmed facts and preferences, labelled separately; suggestions excluded | **Verified** (tests) | |
| Personal preferences (separate, never exported or copied) | **Verified** (tests) | Workspace Settings page built |
| DNA in export (with history), duplicate (active entries, marked as copies), search, Home, Overview counts | **Verified** (tests) | |
| Project tabs refresh with fresh data when opened | **Verified** (live) | Bug found live: tabs showed stale data. Fixed |

## Slice 3: tasks, Outcome Contracts, Router interface, persisted runs

| Feature | Status | Notes |
|---|---|---|
| Tasks with an Outcome Contract (goal, constraints, required approvals, out of scope, acceptance checks) | **Verified** | `work.py`. Tests, plus created and run live |
| Acceptance checks pass only with supporting evidence from the same project, set by a person | **Verified** | Enforced in the backend; agents get 403. Passed live with a real test result |
| Router decision-model interface; baseline labelled "not a trained decision model" | **Verified** | `brain/decision.py`. Label shown on every attempt (seen live) |
| Persisted attempts and steps (route, agent, action with idempotency key) | **Verified** | `task_runs`, `run_steps`. Seen live in Tasks & Runs |

## Slice 4: Evidence Receipts, Recovery Mode, approvals, Permission Preview

| Feature | Status | Notes |
|---|---|---|
| Evidence Receipts (kind, claim, source, artifact + checksum, change stage, result, limitations, actor) | **Verified** | Only a sandbox-passed test supports automatically; agent claims are inconclusive. "Proposed" and "applied" receipts recorded live |
| Recovery: restart marks attempts interrupted and in-flight actions uncertain; resume never repeats a change (payload fingerprint); retry failed read-only steps; reconcile uncertain actions; cancel withdraws waiting approvals | **Verified** (tests) | Restart interruption not reproduced live |
| Approvals bound to the exact payload and target; project write grant re-checked at approval; approve role checked inside projects | **Verified** (tests) | Code changes stay checksum-bound |
| Permission Preview (action, target, changes/diff, scope, won't change, recoverability, binding) | **Verified** | Approved a real CodePilot change from the workspace live |
| CodePilot edits a project's own files (project folder as the codebase) | **Verified** | New in this slice: before, CodePilot could only scan files inside a project. Live: a real fix to `calc.py` was proposed, approved and applied |

## Slice 5: Change Radar, Research-to-Build links, Readiness Check

| Feature | Status | Notes |
|---|---|---|
| Change Radar: deterministic alerts on file / requirement / decision / fact changes; confirmed (citation, import, pinned evidence, trace link) vs suspected (mention); resolve / not affected / later | **Verified** | `radar.py`. Tests, plus alerts raised and resolved live |
| Research-to-Build trace links, trace view; notes are only what people write | **Verified** (tests) | Link form built; auto links (evidence → check) seen live |
| Readiness Check: requirement coverage, configured tests, research sourcing, configuration, handoff documentation, export privacy (plus alerts, assumptions, waiting work) | **Verified** | Run live; disclaimer shown. A false positive in the privacy scan was found live and fixed |

## Slice 6: Comparison Bench, Project Branches, Challenge My Plan

| Feature | Status | Notes |
|---|---|---|
| Comparison Bench: prompts (real timing; tokens/cost "unavailable" unless reported), code (sandboxed tests; unsafe code refused), simulations (ScienceLab) | **Verified** | Simulation comparison run live; prompt and code comparisons tested with labelled fakes |
| A person picks the winner (recorded as human evidence and linked) | **Verified** (tests) | |
| Branches: proposed changes, comparison with main, merge preview, selective merge, conflict when the entry moved on | **Verified** (tests) | UI built; not clicked live |
| Challenge My Plan: weak assumption, why it matters, missing evidence, smallest test, result that would change the plan; labelled with its model; send to Assumption Inbox | **Verified** | Run live with the local model (5 sensible points) |

## Slice 7: Learn, collaboration, Return Briefings

| Feature | Status | Notes |
|---|---|---|
| Teach-Back in CodePilot Learn Mode (opt-in per project): explain with depth, hint, question, check my explanation, prepare to present | **Verified** | `learn.py`. "Check my explanation" run live with the local model |
| Learning notes kept apart from Project DNA; not exported | **Verified** (tests) | |
| Return Briefing from recorded events, plus what's waiting | **Verified** | Tests; card shown on Overview |
| Collaboration & ownership | **Blocked** (needs user accounts) | Owner/reviewer are labels, stated as such in the UI |

## Slice 8: Handoff Capsules, recipes, routines

| Feature | Status | Notes |
|---|---|---|
| Handoff Capsules: 4 presets, preview, remove items, JSON + Markdown, secrets scrubbed, AI disclosure | **Verified** | `handoff.py`. Made live (teammate preset) |
| Portable Recipes: inputs, steps, acceptance, outputs; from a task; export/import; no project data or grants | **Verified** (tests) | Recipes page renders live; empty |
| Run a recipe in a project as a task; daily routines (once per day, scheduler off in tests) | **Verified** (tests) | Scheduler not observed firing live |

## Slice 9: usage and cost, budgets, per-project connection grants

| Feature | Status | Notes |
|---|---|---|
| Model usage per task run (calls, local/Groq, time, tokens as reported; cost known only for the local model) | **Verified** | Live: "3 model calls (1 local, 2 Groq) · 1949+385 tokens" |
| Paid-tool estimates per run | **Implemented** | Captured from the tool router; no paid tool was used live |
| Per-project budget per run, enforced before paid tools are called | **Verified** (tests) | |
| Per-project connection grants (read / write / delete): reads need read, actions need write at approval | **Verified** | Tests; grants grid seen live |
| Conversation messages metered | **Verified** (tests) | `pipeline.execute_run` meters any run not already metered by a task; shown in the usage view alongside task runs |

## Open decisions

| Item | Status |
|---|---|
| Router + six specialists | **Verified**: the seven extra agents are skills of the specialists (DECISIONS.md D16). Tests (`tests/test_specialists.py`), plus live runs recorded only specialist names |
