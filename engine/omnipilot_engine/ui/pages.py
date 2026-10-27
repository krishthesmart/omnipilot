"""The workspace pages: Home, Projects, a project (Overview, Conversations, Files, Project DNA, Assumptions, and the
slice 3-9 tabs from work_pages.py), Activity & Approvals, Connections, Recipes, Settings. Anything not functional
is labelled as such; it's never shown as a button that does nothing."""
from __future__ import annotations

import asyncio
import html

from fastapi import Request
from fastapi.responses import RedirectResponse
from nicegui import events, ui

from .. import project_dna, projects, store
from . import work_pages as wp

_allowed = None

ACCENT = "#4f46e5"

# One cohesive look for the whole workspace: a clean modern SaaS style (Inter, soft neutrals, gentle shadows).
_STYLE = """
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
:root{
  --op-bg:#f6f7f9; --op-surface:#ffffff; --op-ink:#1f2328; --op-muted:#656d76; --op-faint:#8b949e;
  --op-line:#e6e8eb; --op-line-soft:#eef0f2; --op-accent:#4f46e5; --op-accent-soft:#eef0ff; --op-ai:#10a37f;
  --op-shadow:0 1px 2px rgba(16,24,40,.04),0 1px 3px rgba(16,24,40,.06); --op-shadow-lg:0 8px 24px rgba(16,24,40,.08);
}
html,body{background:var(--op-bg);color:var(--op-ink);
  font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;-webkit-font-smoothing:antialiased;}
.op-muted{color:var(--op-muted)}
/* header */
.op-header{background:rgba(255,255,255,.85);backdrop-filter:saturate(1.6) blur(10px);color:var(--op-ink);
  border-bottom:1px solid var(--op-line);box-shadow:none;min-height:56px}
.op-logo{padding:4px 8px;border-radius:10px;transition:background .12s} .op-logo:hover{background:var(--op-accent-soft)}
.op-mark{font-size:20px;filter:drop-shadow(0 1px 1px rgba(0,0,0,.12))}
/* sidebar nav */
.op-nav{background:var(--op-surface)!important}
.op-nav .q-item{border-radius:10px;margin:2px 8px;min-height:40px;color:var(--op-muted);font-weight:500;transition:background .12s,color .12s}
.op-nav .q-item:hover{background:var(--op-line-soft);color:var(--op-ink)}
.op-nav .q-item.active{background:var(--op-accent-soft);color:var(--op-accent);font-weight:600}
.op-nav .q-item.active .q-icon{color:var(--op-accent)}
/* cards + generic surfaces */
.op-card{border:1px solid var(--op-line);border-radius:16px;box-shadow:var(--op-shadow);background:var(--op-surface)}
.op-card:hover{box-shadow:var(--op-shadow-lg)} .op-card{transition:box-shadow .15s}
.q-field--outlined .q-field__control{border-radius:10px}
/* page heading */
h1[role=heading]{letter-spacing:-.02em}
/* markdown */
.nicegui-markdown{line-height:1.6}
.nicegui-markdown h1{font-size:1.25rem;font-weight:700;margin:.6rem 0;letter-spacing:-.01em}
.nicegui-markdown h2{font-size:1.1rem;font-weight:600;margin:.5rem 0}
.nicegui-markdown h3,.nicegui-markdown h4{font-size:1rem;font-weight:600;margin:.4rem 0}
.nicegui-markdown pre{overflow-x:auto;max-width:100%;background:#0d1117;color:#e6edf3;border-radius:10px;padding:.8rem 1rem;font-size:.85em}
.nicegui-markdown code{background:var(--op-line-soft);padding:.1em .35em;border-radius:6px;font-size:.88em}
.nicegui-markdown pre code{background:transparent;padding:0}
.nicegui-markdown a{color:var(--op-accent);text-decoration:none} .nicegui-markdown a:hover{text-decoration:underline}
.nicegui-markdown blockquote{border-left:3px solid var(--op-line);margin:.5rem 0;padding:.1rem .9rem;color:var(--op-muted)}
/* ChatGPT-style conversation */
.op-chat{height:calc(100vh - 272px);min-height:440px;border:1px solid var(--op-line);border-radius:16px;overflow:hidden;background:var(--op-surface);box-shadow:var(--op-shadow)}
.op-rail{background:#fbfbfc;border-right:1px solid var(--op-line);overflow-y:auto}
.op-rail .q-item{border-radius:9px;margin:2px 8px;min-height:38px;font-size:.9rem;color:var(--op-muted)}
.op-rail .q-item:hover{background:var(--op-line-soft);color:var(--op-ink)}
.op-rail .q-item.op-on{background:var(--op-accent-soft);color:var(--op-accent);font-weight:600}
.op-scroll{overflow-y:auto;scroll-behavior:smooth;background:var(--op-surface)}
.op-thread{max-width:46rem;margin:0 auto;padding:1.5rem 1.25rem 2rem}
.op-turn{padding:1.25rem 0;border-bottom:1px solid var(--op-line-soft)} .op-turn:last-child{border-bottom:none}
.op-row{display:flex;gap:.85rem;align-items:flex-start}
.op-av{width:30px;height:30px;border-radius:9px;display:flex;align-items:center;justify-content:center;font-size:15px;flex:0 0 auto;box-shadow:var(--op-shadow)}
.op-av-u{background:#eceef1} .op-av-a{background:linear-gradient(135deg,#10a37f,#0d8a6c);color:#fff}
.op-msg{flex:1;min-width:0;padding-top:3px;line-height:1.6} .op-msg .nicegui-markdown>*:first-child{margin-top:0} .op-msg .nicegui-markdown>*:last-child{margin-bottom:0}
.op-who{font-weight:600;font-size:.84rem;margin-bottom:.15rem}
.op-composer{max-width:46rem;margin:0 auto;width:100%;padding:.5rem 1.25rem 1rem}
.op-inputwrap{border:1px solid var(--op-line);border-radius:1.6rem;padding:.3rem .3rem .3rem 1.1rem;background:var(--op-surface);box-shadow:var(--op-shadow);transition:border-color .12s,box-shadow .12s}
.op-inputwrap:focus-within{border-color:var(--op-accent);box-shadow:0 0 0 3px var(--op-accent-soft)}
.op-inputwrap textarea{max-height:200px;font-size:.95rem}
.op-chat-send .q-btn__content{color:#fff}
.op-typing span{animation:opblink 1.2s infinite;opacity:.3} .op-typing span:nth-child(2){animation-delay:.2s} .op-typing span:nth-child(3){animation-delay:.4s}
@keyframes opblink{0%,80%,100%{opacity:.3}40%{opacity:1}}
/* chips / badges */
.q-badge{border-radius:999px;font-weight:500;letter-spacing:.01em}
.q-btn{text-transform:none;font-weight:500}
</style>
"""


def set_access_check(allowed) -> None:
    global _allowed
    _allowed = allowed


async def _guard(request: Request) -> bool:
    """Same rule as the API: OmniPilot's owner (this computer, or signed in)."""
    return _allowed is not None and await _allowed(request)


def _sign_in() -> RedirectResponse:
    """Visitors who aren't signed in go to the classic app, which asks for the password."""
    return RedirectResponse("/", status_code=303)


def _out_link(text: str, href: str, label: str, download: bool = False) -> None:
    """A link that leaves the workspace (NiceGUI would prefix "/..." with /app)."""
    attrs = f'href="{html.escape(href, quote=True)}" aria-label="{html.escape(label, quote=True)}"' + (" download" if download else "")
    ui.html(f'<a class="text-indigo-700 underline text-sm" {attrs}>{html.escape(text)}</a>', sanitize=False)


def _status_badge(text: str, color: str) -> None:
    ui.badge(text, color=color).props("outline").classes("text-xs")


def _frame(title: str, active: str) -> ui.column:
    """The shared layout: a left navigation (workspace sections) and the page body."""
    ui.colors(primary=ACCENT)
    ui.add_head_html(_STYLE)
    with ui.header().classes("op-header items-center px-4"):
        def _flip_reasoning():
            on = wp.toggle_reasoning()
            ui.notify("Reasoning shown — the model's own working now appears under answers." if on else "Reasoning hidden.", type="info")
            ui.run_javascript("setTimeout(() => location.reload(), 400)")

        # Clicking the logo shows or hides the model's reasoning across the workspace.
        with ui.row().classes("items-center gap-2 cursor-pointer op-logo").on("click", _flip_reasoning).tooltip("Click to show or hide the model's reasoning"):
            ui.html('<span class="op-mark">🧭</span>', sanitize=False)
            ui.label("OmniPilot").classes("text-lg font-semibold tracking-tight")
        if wp.reasoning_shown():
            ui.badge("reasoning on", color="indigo").props("outline rounded").classes("text-xs")
        ui.space()
        _out_link("Classic chat", "/", "Open the classic chat app")
    with ui.left_drawer(value=True, bordered=True).classes("bg-white op-nav").props("width=220 breakpoint=700"):
        with ui.list().classes("w-full"):
            for label, path, icon in [("Home", "/", "home"), ("Projects", "/projects", "folder"),
                                      ("Activity & Approvals", "/activity", "fact_check"), ("Connections", "/connections", "power"),
                                      ("Recipes", "/recipes", "menu_book"), ("Settings", "/settings", "settings")]:
                with ui.item(on_click=lambda p=path: ui.navigate.to(p)).classes("active" if label == active else ""):
                    with ui.item_section().props("avatar"):
                        ui.icon(icon)
                    ui.item_section(label)
    body = ui.column().classes("w-full max-w-6xl mx-auto p-4 gap-4")
    with body:
        ui.label(title).classes("text-2xl font-semibold").props('role="heading" aria-level="1"')
    return body


def _project_form(dialog: ui.dialog, on_saved, existing: dict | None = None) -> None:
    """Create or edit a project's main fields (lists are one item per line)."""
    e = existing or {}
    with dialog, ui.card().classes("w-[560px] max-w-full"):
        ui.label("Edit project" if existing else "New project").classes("text-lg font-semibold")
        name = ui.input("Name", value=e.get("name", "")).props("autofocus maxlength=120").classes("w-full")
        desc = ui.textarea("Goal / description", value=e.get("description", "")).classes("w-full").props("autogrow maxlength=4000")
        with ui.row().classes("w-full"):
            ptype = ui.select(list(projects.TYPES), value=e.get("type", "general"), label="Type").classes("w-40")
            deadline = ui.input("Deadline (optional, YYYY-MM-DD)", value=e.get("deadline") or "").classes("w-60")
        lists = {f: ui.textarea(f"{f.title()} (one per line)", value="\n".join(e.get(f, []))).classes("w-full").props("autogrow")
                 for f in projects.LIST_FIELDS}
        error = ui.label().classes("text-red-700 text-sm")

        def save():
            data = {"name": name.value, "description": desc.value, "type": ptype.value, "deadline": deadline.value or None,
                    **{f: [l for l in w.value.split("\n") if l.strip()] for f, w in lists.items()}}
            try:
                saved = projects.update(e["id"], data) if existing else projects.create(data)
            except projects.ProjectError as err:
                error.text = err.message
                return
            dialog.close()
            on_saved(saved)

        with ui.row().classes("justify-end w-full"):
            ui.button("Cancel", on_click=dialog.close).props("flat")
            ui.button("Save" if existing else "Create project", on_click=save)


# --- Home ---


@ui.page("/")
async def home_page(request: Request):
    if not await _guard(request):
        return _sign_in()
    body = _frame("Home", "Home")
    h = projects.home()
    with body:
        with ui.row().classes("w-full items-center"):
            ui.label("Your projects, what happened recently, and what needs you.").classes("op-muted")
            ui.space()
            dialog = ui.dialog()
            _project_form(dialog, lambda p: ui.navigate.to(f"/projects/{p['id']}"))
            ui.button("New project", icon="add", on_click=dialog.open)
        with ui.grid(columns="repeat(auto-fit, minmax(320px, 1fr))").classes("w-full gap-4"):
            with ui.card().classes("op-card"):
                ui.label("Recent projects").classes("font-semibold")
                if not h["projects"]:
                    ui.label("No projects yet. Create one to keep its files, conversations and decisions together.").classes("op-muted text-sm")
                for p in h["projects"]:
                    ui.link(p["name"], f"/projects/{p['id']}").classes("text-base")
            with ui.card().classes("op-card"):
                ui.label("Needs your approval").classes("font-semibold")
                if not h["pending_approvals"]:
                    ui.label("Nothing waiting.").classes("op-muted text-sm")
                for a in h["pending_approvals"][:6]:
                    with ui.row().classes("items-center gap-2"):
                        _status_badge(f"{a['risk_level']} risk", "red" if a["risk_level"] == "high" else "orange")
                        ui.label(a["description"][:110]).classes("text-sm")
                if h["pending_approvals"]:
                    ui.link("Review with Permission Preview", "/activity").classes("text-sm")
            with ui.card().classes("op-card"):
                ui.label("Blocked or failed work").classes("font-semibold")
                if not h["blocked"]:
                    ui.label("No failed runs recorded.").classes("op-muted text-sm")
                for r in h["blocked"]:
                    ui.label(f"Failed: {r['request'][:100]}").classes("text-sm text-red-700")
            with ui.card().classes("op-card"):
                ui.label("Useful next steps").classes("font-semibold")
                if not h["suggestions"]:
                    ui.label("Nothing to suggest from the recorded state.").classes("op-muted text-sm")
                for s in h["suggestions"]:
                    ui.link(f"{s['project']}: {s['text']}", f"/projects/{s['project_id']}").classes("text-sm")
        with ui.card().classes("op-card w-full"):
            ui.label("Recent activity").classes("font-semibold")
            _timeline(h["activity"], show_project=True)


def _timeline(items: list[dict], show_project: bool = False) -> None:
    if not items:
        ui.label("No activity recorded yet.").classes("op-muted text-sm")
        return
    with ui.timeline(side="right").classes("w-full"):
        for e in items:
            who = {"human": "You", "agent": e["actor"], "system": "OmniPilot"}.get(e["actor_type"], e["actor"])
            title = f"{e.get('project_name', '')} · {e['summary']}" if show_project else e["summary"]
            ui.timeline_entry(title=title, subtitle=f"{who} · {e['at'][:16].replace('T', ' ')} UTC")


# --- Projects list ---


@ui.page("/projects")
async def projects_page(request: Request, show: str = "active"):
    if not await _guard(request):
        return _sign_in()
    body = _frame("Projects", "Projects")
    with body:
        with ui.row().classes("w-full items-center"):
            toggle = ui.toggle({"active": "Active", "archived": "Archived"}, value=show if show in ("active", "archived") else "active",
                               on_change=lambda e: ui.navigate.to(f"/projects?show={e.value}"))
            toggle.props('aria-label="Show active or archived projects"')
            ui.space()
            dialog = ui.dialog()
            _project_form(dialog, lambda p: ui.navigate.to(f"/projects/{p['id']}"))
            ui.button("New project", icon="add", on_click=dialog.open)
        rows = projects.list_projects(status=toggle.value)
        if not rows:
            ui.label("No archived projects." if toggle.value == "archived" else "No projects yet. Create one to get started.").classes("op-muted")
        with ui.grid(columns="repeat(auto-fill, minmax(280px, 1fr))").classes("w-full gap-4"):
            for p in rows:
                with ui.card().classes("op-card cursor-pointer").on("click", lambda p=p: ui.navigate.to(f"/projects/{p['id']}")):
                    with ui.row().classes("items-center w-full"):
                        ui.label(p["name"]).classes("font-semibold text-base")
                        ui.space()
                        _status_badge(p["type"], "indigo")
                    ui.label(p["description"][:160] or "No description yet.").classes("op-muted text-sm")
                    if p["deadline"]:
                        ui.label(f"Deadline {p['deadline']}").classes("text-xs")


# --- One project ---


@ui.page("/projects/{project_id}")
async def project_page(request: Request, project_id: str, tab: str = "overview"):
    if not await _guard(request):
        return _sign_in()
    try:
        p = projects.get(project_id)
    except projects.ProjectError as e:
        body = _frame("Project not found", "Projects")
        with body:
            ui.label(e.message).classes("op-muted")
            ui.link("Back to projects", "/projects")
        return
    body = _frame(p["name"], "Projects")
    with body:
        with ui.row().classes("w-full items-center gap-2"):
            if p["status"] == "archived":
                _status_badge("archived (read-only)", "grey")
            _status_badge(p["type"], "indigo")
            if p["deadline"]:
                ui.label(f"Deadline {p['deadline']}").classes("text-sm op-muted")
            ui.space()
            query = ui.input(placeholder="Search this project").props('dense outlined clearable aria-label="Search this project"').classes("w-72")
            results = ui.column().classes("w-full")

            def run_search():
                results.clear()
                with results:
                    if not (query.value or "").strip():
                        return
                    try:
                        hits = projects.search(project_id, query.value)
                    except projects.ProjectError as err:
                        ui.label(err.message).classes("text-red-700 text-sm")
                        return
                    if not hits:
                        ui.label("Nothing in this project matches.").classes("op-muted text-sm")
                    for hit in hits:
                        with ui.row().classes("items-baseline gap-2"):
                            _status_badge(hit["kind"], "indigo")
                            ui.label(hit["title"]).classes("text-sm font-medium")
                            ui.label(hit["snippet"][:160]).classes("op-muted text-xs")

            query.on("keydown.enter", run_search)
        tab_refs: dict = {}
        tab = {"runs": "tasks"}.get(tab, tab)
        with ui.tabs(value=tab).props("outside-arrows mobile-arrows").classes("w-full") as tabs:
            for key, label in [("overview", "Overview"), ("conversations", "Conversations"), ("files", "Files"), ("dna", "Project DNA"),
                               ("assumptions", f"Assumptions ({p['counts']['unverified_assumptions']})" if p["counts"]["unverified_assumptions"] else "Assumptions"),
                               ("tasks", "Tasks & Runs"), ("evidence", "Evidence"), ("changes", "Changes & Readiness"), ("compare", "Compare & Branches"),
                               ("learn", "Learn"), ("handoff", "Handoff"), ("settings", "Settings & Permissions")]:
                tab_refs[key] = ui.tab(key, label)
        builders = {"overview": _overview, "conversations": _conversations, "files": _files, "dna": _dna, "assumptions": _assumptions, "tasks": wp.tasks_tab,
                    "evidence": wp.evidence_tab, "changes": wp.changes_tab, "compare": wp.compare_tab, "learn": wp.learn_tab, "handoff": wp.handoff_tab, "settings": _settings}
        holders: dict = {}
        with ui.tab_panels(tabs, value=tab).classes("w-full bg-transparent"):
            for key in builders:
                with ui.tab_panel(key):
                    holders[key] = ui.column().classes("w-full")

        async def show(key: str) -> None:
            """Each tab is drawn from fresh data when it's opened (a change made in another tab shows up)."""
            try:
                fresh = projects.get(project_id)
            except projects.ProjectError:
                ui.navigate.to("/projects")
                return
            n = fresh["counts"]["unverified_assumptions"]
            tab_refs["assumptions"].props(f'label="{f"Assumptions ({n})" if n else "Assumptions"}"')
            holders[key].clear()
            with holders[key]:
                result = builders[key](fresh)
                if asyncio.iscoroutine(result):
                    await result

        async def on_tab(e) -> None:
            await show(e.value)

        tabs.on_value_change(on_tab)
        await show(tabs.value if tabs.value in builders else "overview")


def _overview(p: dict) -> None:
    wp.briefing_card(p)
    with ui.grid(columns="repeat(auto-fit, minmax(300px, 1fr))").classes("w-full gap-4"):
        with ui.card().classes("op-card"):
            ui.label("Goal").classes("font-semibold")
            ui.label(p["description"] or "No goal written yet (Settings → Edit project).").classes("text-sm" if p["description"] else "op-muted text-sm")
            ui.label("Current state").classes("font-semibold mt-2")
            c = p["counts"]
            ui.label(f"{c['conversations']} conversation(s) · {c['files']} file(s) · {c['runs']} run(s)").classes("text-sm")
        with ui.card().classes("op-card"):
            ui.label("Acceptance").classes("font-semibold")
            checks = store.q("SELECT c.state, c.text FROM acceptance_checks c JOIN project_tasks t ON t.id = c.task_id WHERE c.project_id = ? AND t.status != 'cancelled'", p["id"])
            if checks:
                ui.label(f"{sum(1 for c in checks if c['state'] == 'passed')} of {len(checks)} task check(s) passed with evidence.").classes("text-sm")
                ui.link("See Tasks & Runs", f"/projects/{p['id']}?tab=tasks").classes("text-sm")
            if p["acceptance"]:
                ui.label("Project-level criteria (add them to a task to check them against evidence):").classes("op-muted text-xs")
                for a in p["acceptance"]:
                    ui.label(f"• {a}").classes("text-sm")
            if not checks and not p["acceptance"]:
                ui.label("No acceptance criteria yet. Add checks to a task, or criteria in Settings → Edit project.").classes("op-muted text-sm")
        for field, empty in [("requirements", "No requirements recorded."), ("constraints", "No constraints recorded."), ("milestones", "No milestones recorded.")]:
            with ui.card().classes("op-card"):
                ui.label(field.title()).classes("font-semibold")
                if not p[field]:
                    ui.label(empty).classes("op-muted text-sm")
                for item in p[field]:
                    ui.label(f"• {item}").classes("text-sm")
        with ui.card().classes("op-card"):
            ui.label("Blockers & approvals").classes("font-semibold")
            failed = [r for r in projects.runs(p["id"]) if r["status"] == "failed"]
            pending = store.q("SELECT a.description FROM approvals a JOIN runs r ON r.id = a.run_id WHERE a.status = 'pending' AND r.project_id = ?", p["id"])
            if not failed and not pending:
                ui.label("No failed runs or pending approvals recorded.").classes("op-muted text-sm")
            for r in failed:
                ui.label(f"Failed: {r['request'][:100]}").classes("text-sm text-red-700")
            for a in pending:
                ui.label(f"Waiting for approval: {a['description'][:100]}").classes("text-sm")
        with ui.card().classes("op-card"):
            ui.label("Pending questions").classes("font-semibold")
            c = p["counts"]
            if not (c["unverified_assumptions"] or c["open_questions"] or c["known_problems"]):
                ui.label("No unverified assumptions, open questions or known problems recorded.").classes("op-muted text-sm")
            if c["unverified_assumptions"]:
                ui.link(f"{c['unverified_assumptions']} assumption(s) to check", f"/projects/{p['id']}?tab=assumptions").classes("text-sm")
            if c["open_questions"]:
                ui.link(f"{c['open_questions']} open question(s)", f"/projects/{p['id']}?tab=dna").classes("text-sm")
            if c["known_problems"]:
                ui.link(f"{c['known_problems']} known problem(s)", f"/projects/{p['id']}?tab=dna").classes("text-sm")
    with ui.card().classes("op-card w-full mt-2"):
        ui.label("Activity").classes("font-semibold")
        _timeline(projects.events(p["id"], 20))


async def _conversations(p: dict) -> None:
    """A ChatGPT-style chat for the project: a conversation rail, a centered message thread with user/assistant
    turns, and a rounded composer. The backend is unchanged — each message is a project-scoped run."""
    convs = projects.conversations(p["id"])
    active = p["status"] == "active"
    state: dict = {"conv": None}

    def new_conv() -> None:
        c = projects.create_conversation(p["id"], None)
        ui.navigate.to(f"/projects/{p['id']}?tab=conversations&c={c['id']}")

    with ui.row().classes("w-full gap-0 no-wrap items-stretch op-chat"):
        with ui.column().classes("w-60 shrink-0 op-rail py-2"):
            if active:
                ui.button("New chat", icon="add", on_click=new_conv).props("flat no-caps").classes("w-full justify-start px-3")
            rail = ui.list().classes("w-full")
            if not convs:
                with rail:
                    ui.label("No chats yet.").classes("op-muted text-sm px-3 py-2")
        with ui.column().classes("grow op-chat min-w-0 no-wrap gap-0"):
            thread = ui.element("div").classes("op-scroll grow")
            composer = ui.column().classes("w-full shrink-0")

    def draw_rail() -> None:
        rail.clear()
        with rail:
            for c in convs:
                it = ui.item(on_click=lambda cid=c["id"]: show(cid)).classes("op-on" if c["id"] == state["conv"] else "")
                with it, ui.item_section():
                    ui.label(c["title"]).classes("text-sm truncate")

    def turn_block(t: dict) -> None:
        with ui.element("div").classes("op-turn"):
            with ui.element("div").classes("op-row"):  # the person's message
                ui.html('<div class="op-av op-av-u">🧑</div>', sanitize=False)
                with ui.element("div").classes("op-msg"):
                    ui.label("You").classes("op-who")
                    ui.label(t["request"]).classes("whitespace-pre-wrap")
            with ui.element("div").classes("op-row").style("margin-top:.9rem"):  # OmniPilot's reply
                ui.html('<div class="op-av op-av-a">🧭</div>', sanitize=False)
                with ui.element("div").classes("op-msg"):
                    who = "OmniPilot" + (" · " + ", ".join(dict.fromkeys(t["agents"])) if t["agents"] else "")
                    ui.label(who).classes("op-who")
                    if t["status"] == "running":
                        ui.html('<div class="op-typing op-muted text-sm">Thinking<span>.</span><span>.</span><span>.</span></div>', sanitize=False)
                    elif t["answer"]:
                        ui.markdown(t["answer"])
                    else:
                        ui.label(f"No answer ({t['status']}).").classes("op-muted text-sm")
                    wp._reasoning_block(t.get("runId"))

    def show(conv_id: str) -> None:
        state["conv"] = conv_id
        draw_rail()
        thread.clear()
        c = projects.conversation(p["id"], conv_id)
        with thread:
            with ui.element("div").classes("op-thread"):
                if not c["turns"]:
                    with ui.element("div").classes("text-center op-muted").style("padding-top:3rem"):
                        ui.html('<div style="font-size:2rem">🧭</div>', sanitize=False)
                        ui.label(f"Ask anything about “{p['name']}”.").classes("text-base")
                        ui.label("Agents see only this project's files, facts and settings.").classes("text-xs")
                for t in c["turns"]:
                    turn_block(t)
        _scroll_bottom()
        draw_composer(conv_id)

    def draw_composer(conv_id: str) -> None:
        composer.clear()
        if not active:
            with composer:
                ui.label("This project is archived (read-only). Restore it to chat.").classes("op-muted text-sm text-center p-3")
            return
        with composer, ui.element("div").classes("op-composer"):
            with ui.row().classes("op-inputwrap items-end no-wrap w-full gap-1"):
                box = ui.textarea(placeholder="Message OmniPilot…").props('autogrow borderless maxlength=4000 aria-label="Message" input-class=op-chat-ta').classes("grow op-chat-input")
                send_btn = ui.button(icon="arrow_upward", on_click=lambda: send()).props('round dense aria-label="Send message"').classes("op-chat-send shrink-0")
            error = ui.label().classes("text-red-700 text-sm px-2")
            ui.label("OmniPilot can be wrong. It cites your project's files; check anything important.").classes("op-muted text-xs text-center w-full mt-1")

            async def send() -> None:
                text = (box.value or "").strip()
                if not text:
                    return
                box.value = ""
                send_btn.disable()
                from ..api_projects import start_project_run

                try:
                    run_id = start_project_run(p["id"], conv_id, text)
                except projects.ProjectError as err:
                    error.text = err.message
                    send_btn.enable()
                    return
                show(conv_id)  # the message and a thinking indicator appear at once
                for _ in range(600):  # refresh until the run finishes (up to 10 minutes)
                    await asyncio.sleep(1)
                    run = store.get_run(run_id)
                    if run and run["status"] != "running":
                        break
                show(conv_id)

            box.on("keydown.enter.prevent", send)  # Enter sends; Shift+Enter makes a newline (handled in JS below)
        _bind_enter()

    from nicegui import context

    wanted = context.client.request.query_params.get("c") if context.client.request else None
    first = next((c["id"] for c in convs if c["id"] == wanted), convs[0]["id"] if convs else None)
    if first:
        show(first)
    else:
        draw_rail()
        with composer:
            if active:
                ui.button("Start a chat", icon="add", on_click=new_conv).classes("mx-auto mt-6")


def _scroll_bottom() -> None:
    ui.run_javascript("setTimeout(() => {const e = document.querySelector('.op-scroll'); if (e) e.scrollTop = e.scrollHeight;}, 60)")


def _bind_enter() -> None:
    # Enter sends, Shift+Enter inserts a newline. Re-bound after each render; the data flag avoids double binding.
    ui.run_javascript('''setTimeout(() => {
      const ta = document.querySelector('.op-chat-input textarea');
      if (!ta || ta.dataset.opEnter) return;
      ta.dataset.opEnter = '1';
      ta.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && e.shiftKey) { e.stopPropagation(); }
      }, true);
    }, 60)''')


def _files(p: dict) -> None:
    container = ui.column().classes("w-full")

    def render() -> None:
        container.clear()
        with container:
            rows = projects.files(p["id"])
            if p["status"] == "active":
                async def uploaded(e: events.UploadEventArguments):
                    try:
                        projects.add_file(p["id"], e.file.name, await e.file.read())
                        ui.notify(f"Added {e.file.name}", type="positive")
                    except projects.ProjectError as err:
                        ui.notify(err.message, type="negative")
                    render()

                ui.upload(label=f"Add files (up to {projects.MAX_FILE_BYTES // (1024 * 1024)} MB each)", multiple=True, auto_upload=True,
                          max_file_size=projects.MAX_FILE_BYTES, on_upload=uploaded,
                          on_rejected=lambda: ui.notify("That file is too large.", type="negative")).classes("w-full")
            if not rows:
                ui.label("No files in this project yet.").classes("op-muted text-sm")
                return
            ui.label("Only agents working in this project can read these files.").classes("op-muted text-xs")
            for f in rows:
                with ui.row().classes("w-full items-center border-b border-gray-100 py-1"):
                    ui.icon("description").classes("op-muted")
                    _out_link(f["name"], f"/api/projects/{p['id']}/files/{f['id']}", f"Download {f['name']}", download=True)
                    ui.label(f"{f['size']:,} bytes · {f['source']}").classes("op-muted text-xs")
                    ui.space()
                    if p["status"] == "active":
                        ui.button(icon="content_copy", on_click=lambda f=f: _copy_dialog(p, f)).props('flat dense aria-label="Copy to another project"').tooltip("Copy to another project")
                        ui.button(icon="delete", on_click=lambda f=f: _confirm_delete_file(p, f, render)).props('flat dense color=negative aria-label="Delete file"').tooltip("Delete")

    render()


def _confirm_delete_file(p: dict, f: dict, after) -> None:
    with ui.dialog() as d, ui.card():
        ui.label(f"Delete {f['name']}?").classes("font-semibold")
        ui.label("The file is removed from this project's folder. This can't be undone.").classes("text-sm")

        def go():
            projects.delete_file(p["id"], f["id"])
            d.close()
            after()

        with ui.row().classes("justify-end w-full"):
            ui.button("Cancel", on_click=d.close).props("flat")
            ui.button("Delete", on_click=go).props("color=negative")
    d.open()


def _copy_dialog(p: dict, f: dict) -> None:
    others = {x["id"]: x["name"] for x in projects.list_projects() if x["id"] != p["id"]}
    with ui.dialog() as d, ui.card().classes("w-[480px]"):
        ui.label(f"Copy {f['name']} to another project").classes("font-semibold")
        if not others:
            ui.label("There's no other active project to copy to.").classes("op-muted text-sm")
            ui.button("Close", on_click=d.close).props("flat")
            d.open()
            return
        target = ui.select(others, label="Copy to").classes("w-full")
        preview = ui.column()
        confirm_btn = ui.button("Copy", on_click=lambda: go()).props("disable")

        def show_preview():
            preview.clear()
            if not target.value:
                return
            pv = projects.copy_file_preview(p["id"], f["id"], target.value)
            with preview:
                ui.label(f"From “{pv['from']}” to “{pv['to']}”: copies {', '.join(pv['copies'])}.").classes("text-sm")
                ui.label("Does not copy: " + ", ".join(pv["does_not_copy"]) + ".").classes("op-muted text-xs")
                if pv["conflict"]:
                    ui.label("The other project already has a file with this name; nothing will be overwritten.").classes("text-red-700 text-sm")
            confirm_btn.props(remove="disable") if not pv["conflict"] else confirm_btn.props("disable")

        def go():
            try:
                projects.copy_file(p["id"], f["id"], target.value, confirm=True)
                ui.notify("Copied.", type="positive")
                d.close()
            except projects.ProjectError as err:
                ui.notify(err.message, type="negative")

        target.on_value_change(show_preview)
        ui.button("Cancel", on_click=d.close).props("flat")
    d.open()


def _settings(p: dict) -> None:
    pid = p["id"]
    with ui.column().classes("gap-4 w-full max-w-2xl"):
        with ui.card().classes("op-card w-full"):
            ui.label("Project details").classes("font-semibold")
            if p["status"] == "active":
                d = ui.dialog()
                _project_form(d, lambda saved: ui.navigate.to(f"/projects/{pid}?tab=settings"), existing=p)
                ui.button("Edit project", icon="edit", on_click=d.open).props("outline")
            else:
                ui.label("Restore the project to edit it.").classes("op-muted text-sm")
        with ui.card().classes("op-card w-full"):
            ui.label("Export & copies").classes("font-semibold")
            _out_link("Export this project (JSON, no credentials or tokens)", f"/api/projects/{pid}/export", "Download the project export", download=True)
            ui.button("Duplicate…", icon="copy_all", on_click=lambda: _duplicate_dialog(p)).props("outline")
        with ui.card().classes("op-card w-full"):
            ui.label("Access").classes("font-semibold")
            ui.label(f"Your role: {p['role']}. Collaboration isn't functional yet: OmniPilot has one user account, so sharing a project with "
                     "other people (reviewers, approvers, read-only) needs user accounts, which aren't built. Task owner and reviewer are labels only.").classes("text-sm op-muted")
        wp.permissions_cards(p)
        with ui.card().classes("op-card w-full border-red-200"):
            ui.label("Archive or delete").classes("font-semibold")
            if p["status"] == "active":
                ui.button("Archive (read-only, reversible)", icon="archive", on_click=lambda: (projects.set_archived(pid, True), ui.navigate.to(f"/projects/{pid}?tab=settings"))).props("outline")
            else:
                ui.button("Restore", icon="unarchive", on_click=lambda: (projects.set_archived(pid, False), ui.navigate.to(f"/projects/{pid}?tab=settings"))).props("outline")
            ui.button("Delete project…", icon="delete_forever", on_click=lambda: _delete_dialog(p)).props("outline color=negative")


def _duplicate_dialog(p: dict) -> None:
    with ui.dialog() as d, ui.card().classes("w-[520px]"):
        ui.label(f"Duplicate “{p['name']}”").classes("font-semibold")
        include = ui.checkbox("Include files", value=True)
        preview = ui.column()

        def render():
            preview.clear()
            pv = projects.duplicate_preview(p["id"], include.value)
            with preview:
                ui.label(f"New project: “{pv['new_name']}”").classes("text-sm")
                ui.label("Copies: " + ", ".join(pv["copies"]) + ".").classes("text-sm")
                ui.label("Never copies: " + ", ".join(pv["does_not_copy"]) + ".").classes("op-muted text-xs")

        include.on_value_change(render)
        render()

        def go():
            new = projects.duplicate(p["id"], include.value)
            ui.navigate.to(f"/projects/{new['id']}")

        with ui.row().classes("justify-end w-full"):
            ui.button("Cancel", on_click=d.close).props("flat")
            ui.button("Duplicate", on_click=go)
    d.open()


def _delete_dialog(p: dict) -> None:
    pv = projects.delete_preview(p["id"])
    with ui.dialog() as d, ui.card().classes("w-[520px]"):
        ui.label(f"Delete “{p['name']}” permanently?").classes("font-semibold text-red-700")
        r = pv["removes"]
        ui.label(f"Removes {r['conversations']} conversation(s), {r['runs']} run(s), {r['files']} file(s) and {r['activity_entries']} activity entries"
                 + (f"; {r['pending_approvals_discarded']} pending approval(s) will be discarded" if r["pending_approvals_discarded"] else "") + ".").classes("text-sm")
        ui.label("Keeps: " + ", ".join(pv["keeps"]) + ". This can't be undone. Consider exporting or archiving instead.").classes("op-muted text-xs")
        typed = ui.input(f"Type the project's name ({pv['confirm_with']}) to confirm").classes("w-full")
        error = ui.label().classes("text-red-700 text-sm")

        def go():
            try:
                projects.delete(p["id"], typed.value or "")
            except projects.ProjectError as err:
                error.text = err.message
                return
            ui.navigate.to("/projects")

        with ui.row().classes("justify-end w-full"):
            ui.button("Cancel", on_click=d.close).props("flat")
            ui.button("Delete permanently", on_click=go).props("color=negative")
    d.open()


# --- Activity & Approvals, Connections ---


@ui.page("/activity")
async def activity_page(request: Request):
    if not await _guard(request):
        return _sign_in()
    body = _frame("Activity & Approvals", "Activity & Approvals")
    h = projects.home()
    with body:
        with ui.card().classes("op-card w-full"):
            ui.label("Waiting for approval").classes("font-semibold")
            ui.label("Each shows exactly what approving does (Permission Preview). Approval runs only what's shown.").classes("op-muted text-xs")
            approvals_box = ui.column().classes("w-full gap-2")

            def draw_approvals():
                approvals_box.clear()
                with approvals_box:
                    wp.approvals_list(None, draw_approvals)

            draw_approvals()
        with ui.card().classes("op-card w-full"):
            ui.label("Project activity").classes("font-semibold")
            _timeline(h["activity"], show_project=True)


@ui.page("/connections")
async def connections_page(request: Request):
    if not await _guard(request):
        return _sign_in()
    body = _frame("Connections", "Connections")
    with body:
        ui.label("Connections are defined once here. Each project chooses which it may use, with read / write / delete access, in its "
                 "Settings & Permissions tab. Connect or disconnect services in the classic app's Integrations page.").classes("op-muted text-sm")
        with ui.card().classes("op-card w-full"):
            ui.label("Accounts & services").classes("font-semibold")
            for c in store.list_connectors():
                with ui.row().classes("items-center gap-2"):
                    ui.label(c["name"]).classes("font-medium w-40")
                    ui.label(c["kind"].replace("_", " ")).classes("op-muted text-sm w-32")
                    _status_badge(c["status"].replace("_", " "), "green" if c["status"] == "connected" else "orange")
        _mcp_connections()


def _mcp_connections() -> None:
    """MCP servers: one-click presets (like Blender) and whatever's already added. Adding one is an approved
    action (it starts a program); using it inside a project needs that project's "MCP servers" grant."""
    from ..integrations import mcp_servers

    box = ui.column().classes("w-full gap-3")

    def render() -> None:
        box.clear()
        with box:
            with ui.card().classes("op-card w-full"):
                with ui.row().classes("items-center gap-2"):
                    ui.icon("extension").classes("text-indigo-600")
                    ui.label("MCP servers").classes("font-semibold")
                ui.label("Tools from an MCP server (a program on this computer or a web service). Adding one needs your approval; "
                         "a project can use it only once you grant “MCP servers” in its Settings & Permissions.").classes("op-muted text-sm")
                installed = mcp_servers.list_public()
                if installed:
                    ui.label("Added").classes("font-medium text-sm mt-1")
                for srv in installed:
                    with ui.row().classes("items-center gap-2 w-full"):
                        ui.label(srv["name"]).classes("font-medium")
                        ui.label(f"{srv['transport']} · {len(srv['tools'])} tool(s)").classes("op-muted text-xs grow")
                        ui.button(icon="delete", on_click=lambda s=srv: (mcp_servers.remove(s["name"]), render())).props('flat dense color=negative aria-label="Remove server"')
                _add_own()
                ui.label("One-click servers").classes("font-medium text-sm mt-2")
                for pr in mcp_servers.presets():
                    with ui.card().classes("op-card w-full"):
                        with ui.row().classes("items-center gap-2 w-full"):
                            ui.label(pr["name"]).classes("font-medium")
                            if pr["risk"] == "high":
                                _status_badge("runs a program", "orange")
                            ui.space()
                            if pr["installed"]:
                                _status_badge("added", "green")
                            else:
                                ui.button("Add", icon="add", on_click=lambda k=pr["key"], n=pr["name"]: _add_preset(k, n)).props("outline dense")
                        ui.label(pr["description"]).classes("text-sm")
                        ui.label(f"Runs: {pr['target']}").classes("op-muted text-xs")
                        ui.label(pr["note"]).classes("op-muted text-xs")
                        _out_link("Setup guide", pr["docs"], f"{pr['name']} setup guide")

    def _add_own() -> None:
        import shlex

        from .. import actions

        with ui.expansion("Add your own MCP server", icon="add_link").classes("w-full op-card"):
            ui.label("Connect any MCP server. A remote URL runs nothing on this computer; a local command starts a "
                     "program (approve only commands you trust). Either way you approve it before it connects.").classes("op-muted text-xs")
            name = ui.input("Name").props("dense").classes("w-full")
            kind = ui.toggle({"http": "Remote URL (no program runs here)", "stdio": "Local command"}, value="http").props("no-caps")
            url = ui.input("Server URL", placeholder="https://example.com/mcp").props("dense").classes("w-full")
            cmd = ui.input("Command", placeholder="npx -y @modelcontextprotocol/server-filesystem ~/Documents").props("dense").classes("w-full")

            def sync():
                url.visible = kind.value == "http"
                cmd.visible = kind.value == "stdio"

            kind.on_value_change(sync)
            sync()

            def add():
                nm = (name.value or "").strip()
                if not nm:
                    ui.notify("Give the server a name.", type="warning")
                    return
                if kind.value == "http":
                    target = (url.value or "").strip()
                    if not target.startswith(("http://", "https://")):
                        ui.notify("Enter an https:// URL.", type="warning")
                        return
                    cfg, risk, desc = {"name": nm, "transport": "http", "url": target}, "medium", f'Add the MCP server "{nm}" (remote URL)'
                else:
                    parts = shlex.split((cmd.value or "").strip())
                    if not parts:
                        ui.notify("Enter the command that starts the server.", type="warning")
                        return
                    cfg, risk, desc = {"name": nm, "transport": "stdio", "command": parts[0], "args": parts[1:]}, "high", f'Add the MCP server "{nm}"'
                actions.propose_connection("mcp_add_server", cfg, desc, risk=risk)
                ui.notify(f"“{nm}” is ready to approve in Activity & Approvals.", type="info", multi_line=True)
                ui.navigate.to("/activity")

            ui.button("Add server", icon="add", on_click=add).props("unelevated")

    def _add_preset(key: str, name: str = "") -> None:
        try:
            out = mcp_servers.propose_preset(key)
        except Exception as e:  # noqa: BLE001 -- surfaced to the user
            ui.notify(str(e)[:200], type="negative")
            return
        if not out:
            ui.notify("Unknown server.", type="negative")
            return
        ui.notify(f"Added {name} for approval — review and approve it in Activity & Approvals.", type="info", multi_line=True)
        ui.navigate.to("/activity")

    render()


BASIS_STYLE = {"confirmed": ("confirmed by you", "green"), "observed": ("observed in a file", "blue"), "suggested": ("suggestion", "orange")}


def _dna(p: dict) -> None:
    pid, editable = p["id"], p["status"] == "active"
    box = ui.column().classes("w-full gap-3")

    def render() -> None:
        box.clear()
        d = project_dna.dna(pid)
        with box:
            c = d["counts"]
            ui.label(f"{c['confirmed']} confirmed · {c['observed']} observed in files · {c['suggested']} suggestion(s). "
                     "Agents in this project treat only confirmed entries as facts.").classes("op-muted text-sm")
            if editable:
                _add_fact_form(pid, render)
            if any(d["brief"].values()):
                with ui.card().classes("op-card w-full"):
                    ui.label("From the project brief (edit in Settings)").classes("font-semibold")
                    for kind, items in d["brief"].items():
                        for item in items:
                            with ui.row().classes("items-center gap-2"):
                                _status_badge(d["labels"][kind][:-1].lower() if kind != "goal" else "goal", "indigo")
                                ui.label(item).classes("text-sm")
            empty = True
            for kind, items in d["groups"].items():
                if not items:
                    continue
                empty = False
                with ui.card().classes("op-card w-full"):
                    ui.label(d["labels"][kind]).classes("font-semibold")
                    for f in items:
                        _fact_row(p, f, render)
            if empty:
                ui.label("No Project DNA entries yet. Add goals, decisions (with why), open questions or known problems above; "
                         "confirmed assumptions from the Assumption Inbox also land here.").classes("op-muted text-sm")

    render()


def _add_fact_form(pid: str, after) -> None:
    with ui.expansion("Add an entry", icon="add").classes("w-full op-card"):
        kinds = {k: v[:-1] if k not in ("file_ref",) else "Important file / reference" for k, v in project_dna.KIND_LABEL.items()}
        kind = ui.select(kinds, value="decision", label="Type").classes("w-64")
        content = ui.textarea("What is it?").props("autogrow maxlength=2000").classes("w-full")
        rationale = ui.textarea("Why (required for decisions)").props("autogrow maxlength=2000").classes("w-full")
        error = ui.label().classes("text-red-700 text-sm")

        def save():
            try:
                project_dna.add_fact(pid, {"kind": kind.value, "content": content.value, "rationale": rationale.value})
            except projects.ProjectError as err:
                error.text = err.message
                return
            content.value = rationale.value = ""
            error.text = ""
            ui.notify("Added (confirmed by you).", type="positive")
            after()

        ui.button("Add", on_click=save)


def _fact_row(p: dict, f: dict, after) -> None:
    pid, editable = p["id"], p["status"] == "active"
    label, color = BASIS_STYLE[f["basis"]]
    with ui.column().classes("w-full border-b border-gray-100 py-2 gap-1"):
        with ui.row().classes("items-center gap-2 w-full"):
            _status_badge(label, color)
            if f.get("source_changed"):
                _status_badge("source file changed since" if not f.get("source_missing") else "source file removed", "red")
            ui.label(f["content"]).classes("text-sm font-medium")
        if f["rationale"]:
            ui.label(f"Why: {f['rationale']}").classes("text-sm")
        who = "You" if f["actor_type"] == "human" else f"{f['actor']} (agent)"
        src = {"user": "entered by hand", "file": "read from a project file", "run": f"from run {f['source_ref'][:8]}", "assumption": "from a confirmed assumption",
               "copy": f"copied from {f['source_ref'][:16]}"}.get(f["source_kind"], f["source_kind"])
        ui.label(f"{who} · {src} · v{f['version']} · updated {f['updated_at'][:16].replace('T', ' ')} UTC").classes("op-muted text-xs")
        with ui.row().classes("gap-1"):
            if editable and f["basis"] != "confirmed":
                ui.button("Confirm", icon="check", on_click=lambda: (project_dna.confirm_fact(pid, f["id"]), after())).props("flat dense color=positive")
            if editable:
                ui.button("Edit", icon="edit", on_click=lambda: _edit_fact_dialog(pid, f, after)).props("flat dense")
                if f["kind"] == "decision":
                    ui.button("Change decision…", icon="swap_horiz", on_click=lambda: _supersede_dialog(pid, f, after)).props("flat dense")
                ui.button("Retire", icon="archive", on_click=lambda: (project_dna.retire_fact(pid, f["id"]), after())).props("flat dense color=grey")
            ui.button("History", icon="history", on_click=lambda: _history_dialog(pid, f)).props("flat dense")


def _edit_fact_dialog(pid: str, f: dict, after) -> None:
    with ui.dialog() as d, ui.card().classes("w-[560px]"):
        ui.label("Edit entry").classes("font-semibold")
        content = ui.textarea("What is it?", value=f["content"]).props("autogrow").classes("w-full")
        rationale = ui.textarea("Why", value=f["rationale"]).props("autogrow").classes("w-full")
        note = ui.input("Note for the history (optional)").classes("w-full")
        error = ui.label().classes("text-red-700 text-sm")

        def save():
            try:
                project_dna.edit_fact(pid, f["id"], {"content": content.value, "rationale": rationale.value, "note": note.value})
            except projects.ProjectError as err:
                error.text = err.message
                return
            d.close()
            after()

        with ui.row().classes("justify-end w-full"):
            ui.button("Cancel", on_click=d.close).props("flat")
            ui.button("Save", on_click=save)
    d.open()


def _supersede_dialog(pid: str, f: dict, after) -> None:
    with ui.dialog() as d, ui.card().classes("w-[560px]"):
        ui.label("Change this decision").classes("font-semibold")
        ui.label(f"Current: {f['content']}").classes("text-sm op-muted")
        ui.label("The current decision is kept in the history, marked as replaced.").classes("text-xs op-muted")
        content = ui.textarea("New decision").props("autogrow").classes("w-full")
        rationale = ui.textarea("Why (required)").props("autogrow").classes("w-full")
        error = ui.label().classes("text-red-700 text-sm")

        def save():
            try:
                project_dna.supersede_decision(pid, f["id"], {"content": content.value, "rationale": rationale.value})
            except projects.ProjectError as err:
                error.text = err.message
                return
            d.close()
            after()

        with ui.row().classes("justify-end w-full"):
            ui.button("Cancel", on_click=d.close).props("flat")
            ui.button("Replace decision", on_click=save)
    d.open()


def _history_dialog(pid: str, f: dict) -> None:
    rows = project_dna.history(pid, f["id"])
    with ui.dialog() as d, ui.card().classes("w-[640px]"):
        ui.label("History").classes("font-semibold")
        for h in rows:
            with ui.column().classes("border-b border-gray-100 py-1 gap-0"):
                ui.label(f"v{h['version']} · {h['note']} · {('You' if h['actor_type'] == 'human' else h['actor'])} · {h['at'][:16].replace('T', ' ')} UTC").classes("op-muted text-xs")
                ui.label(f"{h['content']}" + (f" (why: {h['rationale']})" if h["rationale"] else "") + f" [{h['basis']}, {h['status']}]").classes("text-sm")
        ui.button("Close", on_click=d.close).props("flat")
    d.open()


def _assumptions(p: dict) -> None:
    pid, editable = p["id"], p["status"] == "active"
    box = ui.column().classes("w-full gap-3")

    def render() -> None:
        box.clear()
        rows = project_dna.assumptions(pid)
        with box:
            ui.label("Things the work relies on that nobody has confirmed. OmniPilot suggests consequential ones after answering in this project; "
                     "you confirm, correct or dismiss them. Only you can turn one into a project fact.").classes("op-muted text-sm")
            if editable:
                with ui.row().classes("w-full items-end no-wrap"):
                    statement = ui.input("Add an assumption to check").props("maxlength=1000").classes("grow")
                    ui.button("Add", on_click=lambda: (project_dna.add_assumption(pid, {"statement": statement.value}) if (statement.value or "").strip() else None, render()))
            if not rows:
                ui.label("No assumptions recorded.").classes("op-muted text-sm")
            for a in rows:
                with ui.card().classes("op-card w-full"):
                    with ui.row().classes("items-center gap-2"):
                        _status_badge(a["status"], {"unverified": "orange", "confirmed": "green", "corrected": "blue", "dismissed": "grey"}[a["status"]])
                        ui.label(a["statement"]).classes("text-sm font-medium")
                    if a["reason"]:
                        ui.label(f"Why it came up: {a['reason']}").classes("text-sm")
                    if a["affected"]:
                        ui.label(f"Affects: {a['affected']}").classes("text-sm")
                    src = "suggested by OmniPilot after run " + a["source_ref"][:8] if a["source_kind"] == "run" else "added by you" if a["actor_type"] == "human" else a["source_kind"]
                    ui.label(f"{src} · {a['created_at'][:16].replace('T', ' ')} UTC").classes("op-muted text-xs")
                    if a["correction"]:
                        ui.label(f"Correct version: {a['correction']}").classes("text-sm text-blue-800")
                    if editable and a["status"] == "unverified":
                        with ui.row().classes("gap-1 items-center"):
                            save_as = ui.select({"": "don't save to DNA", "constraint": "save as constraint", "requirement": "save as requirement", "assumption": "save as confirmed assumption",
                                                 "goal": "save as goal", "known_problem": "save as known problem", "open_question": "save as open question"}, value="assumption").classes("w-56").props("dense")
                            ui.button("Confirm", icon="check", on_click=lambda a=a, s=save_as: (project_dna.resolve_assumption(pid, a["id"], "confirmed", save_as=s.value or None), render())).props("flat dense color=positive")
                            ui.button("Correct…", icon="edit", on_click=lambda a=a, s=save_as: _correct_dialog(pid, a, s.value or None, render)).props("flat dense")
                            ui.button("Dismiss", icon="close", on_click=lambda a=a: (project_dna.resolve_assumption(pid, a["id"], "dismissed"), render())).props("flat dense color=grey")

    render()


def _correct_dialog(pid: str, a: dict, save_as, after) -> None:
    with ui.dialog() as d, ui.card().classes("w-[520px]"):
        ui.label("Correct this assumption").classes("font-semibold")
        ui.label(a["statement"]).classes("text-sm op-muted")
        correction = ui.textarea("What's actually true?").props("autogrow").classes("w-full")
        error = ui.label().classes("text-red-700 text-sm")

        def save():
            try:
                project_dna.resolve_assumption(pid, a["id"], "corrected", correction.value or "", save_as)
            except projects.ProjectError as err:
                error.text = err.message
                return
            d.close()
            after()

        with ui.row().classes("justify-end w-full"):
            ui.button("Cancel", on_click=d.close).props("flat")
            ui.button("Save correction", on_click=save)
    d.open()


@ui.page("/settings")
def _answer_quality_card() -> None:
    """Choose Smart (powerful cloud model first) or Fast (local first). Shows which providers are available."""
    from .. import llm
    from ..llm import CLOUD, envfiles

    with ui.card().classes("op-card w-full max-w-2xl"):
        ui.label("Answer quality").classes("font-semibold")
        clouds = [name.upper() for name, spec in CLOUD.items() if envfiles.secret(spec["env"])]
        smart = llm.smart_mode()
        if clouds:
            ui.label(f"Connected smart models: {', '.join(clouds)}. Smart answers use the most powerful model first "
                     "(for NVIDIA: Llama-3.1-405B); Fast answers on this computer's model and is quicker/free.").classes("op-muted text-sm")
        else:
            ui.label("No cloud model key found. Add NVIDIA_API_KEY (free at build.nvidia.com) or GROQ_API_KEY to your .env, "
                     "then restart, to unlock Smart answers. Right now everything runs on this computer's model.").classes("op-muted text-sm")

        def flip(e):
            llm.set_smart_mode(bool(e.value))
            ui.notify("Smart: answers now use the powerful cloud model first." if e.value else "Fast: answers use this computer's model first.", type="info", multi_line=True)

        sw = ui.switch("Smart answers (use the powerful model)", value=smart, on_change=flip)
        if not clouds:
            sw.disable()
        ui.label("Tip: in a chat, click the 🧭 logo to see the model's reasoning under each answer.").classes("op-muted text-xs")


async def settings_page(request: Request):
    if not await _guard(request):
        return _sign_in()
    body = _frame("Settings", "Settings")
    with body:
        _answer_quality_card()
        with ui.card().classes("op-card w-full max-w-2xl"):
            ui.label("Personal preferences").classes("font-semibold")
            ui.label("About you, not any project (for example “explanations: short, with examples”). Agents see them labelled as your preferences, "
                     "never as project facts. They're never exported or copied with a project.").classes("op-muted text-sm")
            box = ui.column().classes("w-full")

            def render():
                box.clear()
                with box:
                    rows = project_dna.preferences()
                    if not rows:
                        ui.label("No preferences yet.").classes("op-muted text-sm")
                    for r in rows:
                        with ui.row().classes("items-center w-full"):
                            ui.label(r["key"]).classes("font-medium w-48")
                            ui.label(r["value"]).classes("text-sm grow")
                            ui.button(icon="delete", on_click=lambda r=r: (project_dna.delete_preference(r["key"]), render())).props('flat dense aria-label="Remove preference"')

            render()
            with ui.row().classes("w-full items-end"):
                key = ui.input("Name (e.g. explanations)").props("maxlength=60")
                value = ui.input("Preference").props("maxlength=500").classes("grow")
                error = ui.label().classes("text-red-700 text-sm")

                def add():
                    try:
                        project_dna.set_preference(key.value or "", value.value or "")
                    except projects.ProjectError as err:
                        error.text = err.message
                        return
                    key.value = value.value = ""
                    error.text = ""
                    render()

                ui.button("Save", on_click=add)
