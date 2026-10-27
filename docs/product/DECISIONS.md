# Architecture decisions (product work)

## D1. The new workspace is Python (NiceGUI), at `/app`, alongside the classic app (2026-10-21)

**Context:** the repo's standing decision (docs/PYTHON_PORT.md) is that all new work is in Python, including the
interface, with NiceGUI planned for Stage 4. The product plan needs a project-first interface that doesn't exist
in the React app.

**Decision:** build the project workspace in NiceGUI 3.17.1, mounted at `/app` on the existing FastAPI server.
- It uses the same project functions as the API, so the same access checks apply.
- The classic React chat at `/` keeps working until the workspace covers it.
- The workspace gets its own content-security rules (NiceGUI needs inline scripts and runtime templates). They
  still allow nothing from other origins and no framing, and model output is shown through NiceGUI's sanitizing
  markdown.
- Light theme only for now: following the system's dark mode produced unreadable mixed colours. Proper dark mode
  is follow-up work.

**Consequences:**
- Two UIs exist during the transition.
- The UI mounts once per process, so tests keep it off (`OMNIPILOT_UI=off`) and test the API and data layer.
- The UI is checked live with argent.

## D2. Thirteen agents exist; the plan names seven (resolved 2026-10-21, see D16)

**Context:** the plan specifies a router plus six specialists. OmniPilot currently has 13 working agents: the six
named, plus LearnPilot, WatcherPilot, HardwarePilot, MathPilot, PicturePilot, SchoolPilot and ModelPilot.

**Decision for now:** don't remove working capabilities (the plan also says to preserve working functionality).
They stay as they are until the owner decides whether to fold them into the six specialists or retire them.
- Teach-Back will be built inside CodePilot's Learn Mode as specified; LearnPilot is untouched.

**Resolved by the owner:** fold all seven into the six specialists (D16).

## D3. Single-owner access today; roles stored and enforced for later

**Context:** OmniPilot has one owner (whoever is on the computer, or signed in with the owner password) and a
separate SDK token. There are no user accounts.

**Decision:**
- Every project has a membership table, and every request goes through `projects.require()`, which checks
  membership and role (owner / approver / reviewer / task_owner / viewer) in the backend.
- Today the only member is "owner". SDK tokens get no project access.
- Collaboration is labelled as not functional in the UI, and no multi-user security is faked.

## D4. Project files live in a hidden folder inside the workspace

**Decision:** files go in `workspace/.omnipilot-projects/<project id>/`.
- Agents in a project run get that folder as their workspace, so they can't see other projects or the shared
  workspace.
- Being hidden (a leading dot), the folder is skipped by the workspace-wide search used outside projects.
- Approved CodePilot changes inside a project are stored with paths relative to the workspace root, where
  approvals apply them (`patches.to_workspace_rel`).
- Files that appear on disk through an approved change are picked up in the project's file list.

## D5. Additive database changes only

**Decision:**
- New tables were added to the existing shared SQLite schema (projects, project_members, project_conversations,
  project_files, project_events), with foreign keys and indexes.
- One nullable column was added to `runs` (`project_id`).
- Foreign keys are switched on, so a project's records are deleted with it.
- No existing table or data was changed. Verified on a copy of a real database.

## D6. Upload size limits per endpoint

**Context:** the front door limits request bodies to 256 KB.

**Decision:**
- Project file uploads (5 MB) and document attachments (10 MB) get their own limits. The attachment limit also
  fixes PDFs over 256 KB being refused.
- Voice recordings keep their deliberate 256 KB limit, which an existing test enforces.
- Everything else stays at 256 KB.

## D7. Deterministic fakes only in tests

The project-run test replaces the agents with a clearly labelled fake (no model is available in tests). The
production code paths always use the real agents and models.

## D8. Project DNA: three levels of certainty, people confirm (2026-10-21)

**Decision:** every entry has a basis.
- **Confirmed:** only a human actor can set this, and agents can't edit entries.
- **Observed:** must cite a project file, with its checksum at the time. It is flagged when that file changes or disappears.
- **Suggested:** the default for anything an agent adds.

Decisions need a rationale and are superseded rather than overwritten. Every change writes a history row.

**Project brief:** the requirements, constraints and goal entered with the project stay in the project record (the brief). They're shown in Project DNA as their own group rather than duplicated as entries.

## D9. Assumptions suggested after project runs (2026-10-21)

**Decision:** after a run inside a project completes, the model is asked for at most 3 *consequential* assumptions the answer relied on that aren't already confirmed.
- The answer is passed as data to analyse, never as instructions to follow.
- Suggestions enter the inbox as unverified and never become facts by themselves.
- No model available means no suggestions, never invented ones.

**Cost:** one extra model call per project run, on the local model first.

## D10. Personal preferences are not project data

**Decision:** stored in their own table, not tied to any project.
- Agents see them in a separately labelled block ("the person's own preferences… not project facts").
- They're never included in a project export or copied with a duplicate.

## D11. Tasks are runs with a contract; steps are derived from what happened (2026-10-21)

**Decision:** a task attempt is an ordinary project run whose request states the Outcome Contract.
- Steps are recorded from the run's actual result: the Router's decision, each specialist, and each proposed change.
- Steps that change something carry the approval id as their idempotency key, and the payload fingerprint.
- Resuming starts a new attempt. A change whose fingerprint matches one that already ran, is waiting, or is uncertain is set aside, never repeated.

## D12. Evidence: only a sandbox-passed test supports automatically (2026-10-21)

**Decision:**
- Agent-offered evidence is recorded as inconclusive.
- A test the sandbox actually passed is recorded as "supports / tested".
- Only a person can mark an acceptance check passed, and only with supporting evidence from the same project.
- Evidence about a file pins the file's checksum, so later changes are flagged.

## D13. Change Radar is deterministic (2026-10-21)

**Decision:** no model decides what a change affects.
- **Confirmed relations:** a recorded link (an observation citing the file, evidence pinned to an older checksum, an import, a trace link).
- **Suspected relations:** only a mention.

Mentions are noisy on purpose, and people dismiss what doesn't apply.

## D14. Usage is reported, never estimated (2026-10-21)

**Decision:**
- Token counts come from Ollama / Groq replies; missing counts show "unavailable".
- The local model costs nothing.
- Groq's free tier isn't priced.
- Paid tools show the router's estimate.
- A project's per-run budget is checked before each paid tool call.

## D15. Inside a project, CodePilot treats the project folder as the codebase (2026-10-21)

**Context:** the live run showed that CodePilot couldn't change a project's own files. It only edited sub-folder "projects", and "fix the bug" went to the security scanner.

**Decision:**
- A change request inside a project that names one of its files (or "the project/app") goes through the existing multi-file edit flow: plan, change, check, propose for approval.
- Security reviews still go to the scanner.
- Paths stay inside the project folder.

## D16. Router + six specialists; the other seven agents are skills (2026-10-21)

**Owner's decision:** fold all seven extra agents into the plan's six specialists, keeping every ability.

| Former agent | Now | Skill name shown |
|---|---|---|
| LearnPilot | Helper | lessons & quizzes |
| SchoolPilot | Helper | school planner |
| PicturePilot | Helper | pictures |
| MathPilot | ScienceLab | math checks |
| ModelPilot | ScienceLab | 3D models |
| HardwarePilot | CodePilot | wiring guides |
| WatcherPilot | InfraPilot | focus control |

**How it works:**
- The keyword rules still score the 13 abilities, so the TypeScript routing-parity tests stay valid.
- The coordinator still plans per ability, so sequencing between abilities (for example, lessons building on a wiring guide) is unchanged.
- Everything people see or that is recorded uses only the six names: the Router's plan, steps, live events, the activity log, results, approvals and tasks. The skill is shown alongside the specialist.
- A specialist's own result and its skills' results are merged into one.
- User-visible text inside the skills (safety messages, model personas) names the specialist.
- The JS-parity fixtures list exactly those renamed phrases as a deliberate change.

**Not changed:**
- The skills' code modules keep their file names (`learn_pilot.py`, etc.) as internal implementation.
- The TypeScript fallback engine and the shared routing prompt still use the internal ability names.

## D17. Show the model's reasoning, kept apart from the answer (2026-10-24)

**Request:** surface the model's reasoning, not just the answer.

**Decision:**
- The LLM layer can capture a model's reasoning when a call opts in (`reasoning=True`). It's stored on the run
  record under `reasoning` (which model, where, the text) and shown in a collapsible "Model reasoning" block in
  the workspace (task attempts and conversation answers), clearly labelled as the model's own reasoning, which
  can be imperfect.
- Only the final-answer synthesis asks to reason, so routing and the specialists stay fast.
- The reasoning is never streamed to the reader or mixed into the answer — only the answer is.
- **Groq's reasoning model** (gpt-oss) returns its reasoning in a separate field, captured cleanly.
- **The local model**'s thinking stays OFF by default: the small "instruct" build is fast precisely because it
  doesn't think, and turning thinking on risks it folding reasoning into the answer. It's opt-in via
  `OMNIPILOT_LOCAL_REASONING=on` for anyone who wants local reasoning and accepts it's slower.
- When nothing was captured (e.g. a local answer with reasoning off), the UI shows nothing — never invented
  reasoning.

**Consequence:** reasoning appears today when Groq's reasoning model composes the final answer (hard jobs, or
when the local model is unavailable). Local reasoning is available behind the opt-in flag.

**Showing it:** clicking the OmniPilot logo in the workspace header toggles reasoning on or off across the
workspace (a "reasoning on" badge shows the state). It's off by default; when on, each answer that has captured
reasoning shows a "Model reasoning" block. Stored as the `ui_show_reasoning` setting.

## D18. The project chat is a ChatGPT-style view (2026-10-24)

**Request:** make the chat feel like ChatGPT, keeping the existing backend.

**Decision:** the project Conversations tab is now a familiar chat view, over the unchanged backend (each message
is still a project-scoped run via `start_project_run`):
- A left rail of chats with a "New chat" button; the open chat is highlighted.
- A centered thread (max ~48rem) of turns: the person ("You", 🧑) above OmniPilot's reply ("OmniPilot" + the
  specialists that answered, 🧭), the answer as sanitised markdown, with light separators between turns.
- A running turn shows a "Thinking…" indicator.
- A rounded composer pinned at the bottom ("Message OmniPilot…") with a circular send button, auto-growing input,
  Enter to send and Shift+Enter for a newline, and a short "OmniPilot can be wrong" footer.
- The view auto-scrolls to the newest message.
- The model-reasoning block (D17) appears under an answer when reasoning is on (toggled from the logo).

Verified live in Chrome against a seeded conversation: layout, the logo reasoning toggle + badge, and the
expandable "Model reasoning" block all render correctly.

## D19. Blender (and other servers) added as one-click MCP connections (2026-10-25)

**Request:** add Blender.

**Decision:** Blender is added as a one-click MCP server preset, reusing the existing connection, approval and
grant machinery rather than a bespoke integration.
- `integrations/mcp_servers.PRESETS` holds known servers; Blender runs `uvx blender-mcp` (stdio), which talks to
  the BlenderMCP add-on inside Blender (localhost:9876).
- The Connections page shows an "MCP servers" section: servers already added (removable) and one-click presets
  with an "Add" button, the exact command, and the setup note + docs link.
- "Add" proposes the existing `mcp_add_server` action (`actions.propose_connection`), so it goes through the
  normal approval with Permission Preview — adding one starts a program, so it's never silent.
- Using a Blender tool inside a project still needs that project's "MCP servers" write grant (unchanged).
- The registry is extensible: more presets are just more entries.

Verified live: the preset shows in Connections, "Add" routes to Activity & Approvals with the full Permission
Preview; and a test covers propose -> approve -> installed, plus the per-project grant gate on calling a tool.

## D20. NVIDIA added as a smart model provider; MCP servers added from the UI (2026-10-25)

**Requests:** "add NVIDIA", "it is not smart", and the MCP section "only adds with chat, no place to give a link,
and it should not need a server".

**Model provider (smarter):** NVIDIA NIM (build.nvidia.com, OpenAI-compatible) is now a provider alongside local
and Groq, with big models (Llama-3.1-405B, Nemotron-70B, DeepSeek-R1). The two cloud providers share one
OpenAI-compatible code path (`llm.CLOUD` + `_cloud`/`_cloud_stream`). Ordering:
- **local first** for ordinary jobs (free, private — the standing preference), cloud only as fallback;
- **NVIDIA then Groq then local** for hard jobs, so hard work gets the strongest model.
Needs `NVIDIA_API_KEY`; with no key nothing changes. Usage and reasoning are captured for whichever provider
answers (`reasoning` for gpt-oss, `reasoning_content` for NVIDIA/DeepSeek).

**MCP from the UI:** the Connections page now has, besides one-click presets, an "Add your own MCP server" form:
a remote URL (connects to a web service — **no program runs on this computer**) or a local command. Both go
through the normal approval + Permission Preview; using one in a project still needs the "MCP servers" grant. So
MCP no longer needs chat, there is a place to paste a link, and the remote option needs no local server.

## D21. "Smart answers" mode; most-powerful NVIDIA model (2026-10-25)

Normal chat answered local-first (the small 4B model), so even with a cloud key answers stayed weak. Added an
**answer-quality setting** (`answer_mode` = smart/fast), surfaced in Settings:
- **Smart**: the primary answer uses the powerful cloud model first (NVIDIA → Groq → local).
- **Fast** (default, unchanged for everyone): local first, free and private.
NVIDIA's default is now the most powerful free model first (`meta/llama-3.1-405b-instruct`, then DeepSeek-R1,
then Nemotron-70B). The shipped default stays Fast to honour the local-first preference; a person turns Smart on
once they've added a key.

## D22. functiongemma picks the tool an agent calls (2026-10-25)

Tool selection (which MCP tool/function to call next) now uses a dedicated tool model, `functiongemma` by default
(override with `OMNIPILOT_TOOL_MODEL`), via `llm.choose_tool_json`. If that model isn't installed it falls back to
the normal model, so nothing breaks when it's absent. Pull it in Ollama (or set the env to your function-calling
model) to use it. MCP servers can be added from the UI by remote URL or local command (the "Add your own MCP
server" form), as well as in chat.

## D23. 3D games route to CodePilot, not the 3D-model skill (2026-10-25)

"Create a 3D horror game" failed because "3d" sent it to ScienceLab's single-object 3D-model skill, which then
couldn't return a model. Two routing rules combined wrongly (the build-software rule didn't drop ModelPilot; the
"it's a 3D model" rule then dropped CodePilot). Fixed in `routing.py`: when both CodePilot and the model skill
match, a request with clear model intent (`MODEL_INTENT`: "3d model", "model of", molecule, exploded view, STL…)
goes to the model skill and CodePilot is dropped; otherwise it's a software/game build and the model skill is
dropped. Game genres (platformer, shooter, rpg, roguelike, arcade) were added to the software detection. A 3D
game is built by CodePilot (e.g. Three.js); a single explorable 3D object/molecule stays with the model skill.
Covered by `tests/test_routing.py`.
