"""Workspace tabs and pages for slices 3-9: Tasks & Runs (with recovery), Evidence, Changes & Readiness,
Compare & Branches (with Challenge My Plan), Learn, Handoff, Settings & Permissions, approvals with Permission
Preview, the Return Briefing and the Recipes page. They call the same functions as the API."""
from __future__ import annotations

import asyncio
import json

from fastapi import Request
from nicegui import ui

from .. import approvals, bench, grants, handoff, learn, project_dna, projects, radar, recipes, store, work
from ..api_work import project_usage

STATUS_COLOR = {"pending": "grey", "running": "blue", "awaiting_approval": "orange", "blocked": "orange", "completed": "green", "failed": "red",
                "cancelled": "grey", "interrupted": "red", "uncertain": "purple", "passed": "green", "not_applicable": "grey",
                "supports": "green", "contradicts": "red", "inconclusive": "grey", "confirmed": "red", "suspected": "orange", "not_checked": "grey"}


def _badge(text: str, key: str | None = None) -> None:
    ui.badge(text.replace("_", " "), color=STATUS_COLOR.get(key or text, "grey")).props("outline").classes("text-xs")


def reasoning_shown() -> bool:
    """Whether the model's reasoning is on show (toggled by clicking the OmniPilot logo). Off by default."""
    try:
        return store.get_setting("ui_show_reasoning") == "on"
    except Exception:  # noqa: BLE001 -- a missing setting just means off
        return False


def toggle_reasoning() -> bool:
    on = not reasoning_shown()
    store.set_setting("ui_show_reasoning", "on" if on else None)
    return on


def _reasoning_block(run_id: str | None) -> None:
    """The model's own reasoning for a run, shown apart from the answer and labelled as what it is.
    Only drawn when reasoning is on show (click the logo); hidden otherwise."""
    if not run_id or not reasoning_shown():
        return
    run = store.get_run(run_id)
    entries = ((run or {}).get("data") or {}).get("reasoning") or []
    if not entries:
        return
    with ui.expansion(f"Model reasoning ({len(entries)})", icon="psychology").classes("w-full").props("default-opened"):
        _note("The model's own reasoning behind the answer. It can be imperfect, and it isn't part of the answer.")
        for e in entries:
            where = f"{e.get('model', '?')} on {'this computer' if e.get('where') == 'local' else 'Groq'}"
            ui.label(where).classes("text-xs op-muted")
            ui.markdown(e.get("text", "")).classes("text-sm")


def _note(text: str) -> None:
    ui.label(text).classes("op-muted text-xs")


async def _try(fn, *args, ok: str | None = None, **kw):
    """Runs an action; a refusal is shown, not raised."""
    try:
        out = fn(*args, **kw)
        if asyncio.iscoroutine(out):
            out = await out
    except projects.ProjectError as e:
        ui.notify(e.message, type="negative", multi_line=True)
        return None
    except approvals.ApprovalError as e:
        ui.notify(e.message, type="negative", multi_line=True)
        return None
    if ok:
        ui.notify(ok, type="positive")
    return out


def _lines(text: str | None) -> list[str]:
    return [x.strip() for x in (text or "").splitlines() if x.strip()]


# --- approvals with Permission Preview ---


def approval_card(approval_id: str, after) -> None:
    """Shows exactly what approving does, then decides with the fingerprint that was shown."""
    pv = approvals.preview(approval_id)
    if not pv:
        return
    with ui.card().classes("op-card w-full"):
        with ui.row().classes("items-center gap-2"):
            _badge(f"{pv['risk']} risk", "failed" if pv["risk"] == "high" else "awaiting_approval")
            ui.label(pv["description"][:200]).classes("text-sm font-medium")
        with ui.grid(columns="max-content 1fr").classes("gap-x-3 gap-y-1 text-sm"):
            for label, value in (("Action", pv["action"]), ("Target", ", ".join(pv["target"]) if isinstance(pv["target"], list) else pv["target"]),
                                 ("Scope", pv["scope"]), ("Won't change", pv["will_not_change"]), ("Can it be undone?", pv["recoverability"]),
                                 ("Bound to", pv.get("binding", ""))):
                ui.label(label).classes("op-muted")
                ui.label(str(value))
        if pv["kind"] == "code_change":
            for ch in pv["changes"]:
                with ui.expansion(f"{'New file' if ch['isNew'] else 'Change'}: {ch['file']}").classes("w-full"):
                    ui.code(ch["diff"][:20000]).classes("w-full text-xs")
        elif pv.get("payload") is not None:
            with ui.expansion("Exactly what will be sent (secrets hidden)").classes("w-full"):
                ui.code(json.dumps(pv["payload"], indent=2, ensure_ascii=False)[:8000], language="json").classes("w-full text-xs")
            if pv.get("payload_sha256"):
                _note(f"Payload fingerprint {pv['payload_sha256'][:16]}… — approval runs only this exact payload.")
        if pv["status"] == "pending":
            async def decide(decision: str):
                if await _try(approvals.decide, approval_id, decision, pv.get("payload_sha256"), ok="Approved and carried out." if decision == "approved" else "Denied."):
                    after()

            with ui.row().classes("gap-2"):
                ui.button("Approve", icon="check", on_click=lambda: decide("approved")).props("color=positive")
                ui.button("Deny", icon="close", on_click=lambda: decide("denied")).props("flat color=negative")
        else:
            _badge(pv["status"])


def approvals_list(project_id: str | None, after) -> None:
    rows = store.q("SELECT a.id FROM approvals a JOIN runs r ON r.id = a.run_id WHERE a.status = 'pending' AND (? IS NULL OR r.project_id = ?) ORDER BY a.created_at DESC LIMIT 30",
                   project_id, project_id)
    if not rows:
        ui.label("Nothing waiting for approval.").classes("op-muted text-sm")
    for r in rows:
        approval_card(r["id"], after)


# --- Return Briefing (top of Overview) ---


def briefing_card(p: dict) -> None:
    b = learn.briefing(p["id"])
    w = b["waiting"]
    waiting = [(len(w["approvals"]), "approval(s) waiting", "tasks"), (len(w["uncertain"]), "action(s) with an uncertain outcome", "tasks"),
               (len(w["interrupted_or_failed"]), "task(s) interrupted, failed or blocked", "tasks"), (len(w["alerts"]), "change alert(s) to review", "changes"),
               (len(w["assumptions"]), "assumption(s) to check", "assumptions")]
    if not b["changes"] and not any(n for n, _, _ in waiting):
        return
    with ui.card().classes("op-card w-full").style("border-color:#c7d2fe;background:#eef2ff"):
        ui.label("Since your last visit" if not b["first_visit"] else "Return Briefing").classes("font-semibold")
        if b["changes"]:
            for group, items in b["groups"].items():
                ui.label(f"{group}: {len(items)}").classes("text-sm font-medium mt-1")
                for it in items[-5:]:
                    ui.label(f"• {it['summary']}" + (" (agent)" if it["actor_type"] == "agent" else " (OmniPilot)" if it["actor_type"] == "system" else "")).classes("text-sm")
        for n, label, tab in waiting:
            if n:
                ui.link(f"{n} {label}", f"/projects/{p['id']}?tab={tab}").classes("text-sm")
        with ui.row().classes("items-center"):
            _note(b["note"])
            ui.button("Mark as seen", on_click=lambda: (learn.seen(p["id"]), ui.navigate.to(f"/projects/{p['id']}"))).props("flat dense")


# --- Tasks & Runs ---


def tasks_tab(p: dict) -> None:
    pid, editable = p["id"], p["status"] == "active"
    box = ui.column().classes("w-full gap-3")

    def render() -> None:
        box.clear()
        with box:
            ui.label("A task is work with an Outcome Contract: goal, constraints, what's out of scope, the approvals it needs, and the checks that say it's done. "
                     "Each run of it is an attempt, made of recorded steps.").classes("op-muted text-sm")
            if editable:
                ui.button("New task", icon="add_task", on_click=lambda: _task_dialog(pid, render))
            ts = work.tasks(pid)
            if not ts:
                ui.label("No tasks yet.").classes("op-muted text-sm")
            for t in ts:
                with ui.card().classes("op-card w-full"):
                    with ui.row().classes("items-center gap-2 w-full"):
                        _badge(t["status"])
                        ui.label(t["title"]).classes("font-medium")
                        ui.space()
                        c = t["checks"]
                        ui.label(f"checks {c['passed']}/{sum(c.values())} passed · {t['attempts']} attempt(s)").classes("op-muted text-xs")
                    _task_detail(pid, t["id"], editable, render)
            ui.separator()
            ui.label("Conversation runs in this project").classes("font-semibold")
            rows = projects.runs(pid)
            if not rows:
                ui.label("None yet.").classes("op-muted text-sm")
            for r in rows[:30]:
                with ui.row().classes("w-full items-center border-b border-gray-100 py-1"):
                    _badge(r["status"], {"needs_approval": "awaiting_approval", "needs_clarification": "blocked"}.get(r["status"], r["status"]))
                    ui.label(r["request"][:140]).classes("text-sm")
                    ui.space()
                    ui.label(r["created_at"][:16].replace("T", " ")).classes("op-muted text-xs")

    render()


def _task_detail(pid: str, tid: str, editable: bool, refresh) -> None:
    t = work.get_task(pid, tid)
    with ui.expansion("Contract, checks and attempts").classes("w-full"):
        if t["goal"]:
            ui.label(f"Goal: {t['goal']}").classes("text-sm")
        for label, items in (("Constraints", t["constraints"]), ("Out of scope", t["out_of_scope"]), ("Needs approval before", t["required_approvals"])):
            if items:
                ui.label(f"{label}: " + "; ".join(items)).classes("text-sm")
        ui.label(f"Owner: {t['owner']}" + (f" · Reviewer: {t['reviewer']}" if t["reviewer"] else "") + " — labels only (one user account; they don't grant access)").classes("op-muted text-xs")
        ui.label("Acceptance checks").classes("font-medium text-sm mt-2")
        if not t["acceptance"]:
            _note("No checks; this task can't be shown to be done.")
        ev_options = {e["id"]: f"{e['result']} · {e['claim'][:70]}" for e in work.evidence(pid)}
        for c in t["acceptance"]:
            with ui.row().classes("items-center gap-2 w-full"):
                _badge(c["state"])
                ui.label(c["text"]).classes("text-sm grow")
                if editable:
                    ev = ui.select(ev_options, label="evidence", value=c["evidence_id"]).props("dense clearable").classes("w-64")
                    state = ui.select(list(work.CHECK_STATES), value=c["state"]).props("dense").classes("w-36")

                    async def save(c=c, ev=ev, state=state):
                        if await _try(work.set_check, pid, c["id"], state.value, ev.value, ok="Check updated."):
                            refresh()

                    ui.button("Save", on_click=save).props("flat dense")
        _note("A check passes only with evidence from this project that supports it, and only you can pass it.")
        with ui.row().classes("gap-2 mt-2"):
            if editable and t["status"] in ("pending", "completed", "cancelled"):
                ui.button("Start" if t["status"] == "pending" else "Run again", icon="play_arrow",
                          on_click=lambda: _start(pid, tid, refresh, work.start_task)).props("outline")
            if editable and t["status"] in ("interrupted", "failed", "blocked", "cancelled"):
                ui.button("Resume (won't repeat changes)", icon="restart_alt", on_click=lambda: _start(pid, tid, refresh, work.resume_task)).props("outline")
            if editable and t["status"] in ("running", "awaiting_approval", "blocked", "interrupted"):
                ui.button("Stop", icon="stop", on_click=lambda: _sync(work.cancel_task, pid, tid, then=refresh, ok="Stopped; waiting changes withdrawn.")).props("outline color=negative")
            if editable:
                ui.button("Challenge this plan", icon="psychology_alt", on_click=lambda: ui.navigate.to(f"/projects/{pid}?tab=compare")).props("flat")
                ui.button("Save as recipe", icon="bookmark_add", on_click=lambda: _save_recipe_dialog(pid, tid)).props("flat")
        for a in t["attempts"]:
            with ui.card().classes("op-card w-full mt-2"):
                with ui.row().classes("items-center gap-2"):
                    _badge(a["status"])
                    ui.label(f"Attempt {a['attempt']} · {a['started_at'][:16].replace('T', ' ')} UTC").classes("text-sm font-medium")
                if a["router"]:
                    _note(a["router"])
                u = a["usage"]
                if u:
                    tok = f"{u.get('promptTokens')}+{u.get('completionTokens')} tokens" if u.get("promptTokens") is not None else f"tokens {u.get('tokensNote', 'unavailable')}"
                    _note(f"{u.get('modelCalls', 0)} model call(s) ({u.get('local', 0)} local, {u.get('groq', 0)} Groq) · {tok} · {u.get('costNote', '')}"
                          + (f" · paid tools ≈ ${u.get('paidToolsEstUsd', 0):.3f}" if u.get("paidTools") else ""))
                if a["error"]:
                    ui.label(a["error"]).classes("text-sm text-red-700")
                _reasoning_block(a.get("run_id"))
                for s in a["steps"]:
                    with ui.row().classes("items-center gap-2 w-full"):
                        ui.label(f"{s['seq']}.").classes("op-muted text-xs w-5")
                        _badge(s["status"])
                        ui.label(f"{s['kind']}: {s['name'][:120]}").classes("text-sm")
                        if s["writes"]:
                            _badge("changes something", "awaiting_approval")
                        if s["output"].get("duplicateOf"):
                            _note("set aside: the same change was already handled in an earlier attempt")
                        ui.space()
                        if editable and s["status"] == "failed" and s["kind"] == "agent":
                            ui.button("Retry", on_click=lambda s=s: _retry(pid, s["id"], refresh)).props("flat dense")
                        if editable and s["status"] == "uncertain":
                            ui.button("It happened", on_click=lambda s=s: _sync(work.reconcile_step, pid, s["id"], "succeeded", then=refresh)).props("flat dense")
                            ui.button("It didn't happen", on_click=lambda s=s: _sync(work.reconcile_step, pid, s["id"], "failed", then=refresh)).props("flat dense")
                    if s["error"]:
                        ui.label(s["error"][:300]).classes("text-xs text-red-700 ml-8")
                    if s["status"] == "awaiting_approval" and s["idempotency_key"]:
                        approval_card(s["idempotency_key"], refresh)


def _sync(fn, *args, then=None, ok=None):
    async def go():
        if await _try(fn, *args, ok=ok) is not None and then:
            then()

    asyncio.ensure_future(go())


def _start(pid, tid, refresh, fn) -> None:
    async def go():
        if await _try(fn, pid, tid, ok="Started. This page refreshes when it finishes."):
            refresh()
            for _ in range(240):
                await asyncio.sleep(1)
                if store.q1("SELECT status FROM project_tasks WHERE id = ?", tid)["status"] != "running":
                    break
            refresh()

    asyncio.ensure_future(go())


def _retry(pid, sid, refresh) -> None:
    async def go():
        if await _try(work.retry_step, pid, sid, ok="Retried."):
            refresh()

    asyncio.ensure_future(go())


def _task_dialog(pid: str, after) -> None:
    with ui.dialog() as d, ui.card().classes("w-[620px]"):
        ui.label("New task").classes("font-semibold")
        title = ui.input("Title").props("maxlength=200 autofocus").classes("w-full")
        goal = ui.textarea("Goal (what done looks like)").props("autogrow maxlength=2000").classes("w-full")
        request = ui.textarea("Request for the agents (optional; the goal is used otherwise)").props("autogrow maxlength=4000").classes("w-full")
        constraints = ui.textarea("Constraints, one per line").props("autogrow").classes("w-full")
        out_scope = ui.textarea("Out of scope, one per line").props("autogrow").classes("w-full")
        needs = ui.textarea("Needs approval before…, one per line").props("autogrow").classes("w-full")
        checks = ui.textarea("Acceptance checks, one per line").props("autogrow").classes("w-full")
        with ui.row().classes("w-full"):
            owner = ui.input("Owner (label)").classes("grow")
            reviewer = ui.input("Reviewer (label)").classes("grow")
        _note("Owner and reviewer are labels for your tracking; OmniPilot has one user account, so they don't give anyone access.")

        async def save():
            if await _try(work.create_task, pid, {"title": title.value, "goal": goal.value, "request": request.value, "constraints": _lines(constraints.value),
                                                  "outOfScope": _lines(out_scope.value), "requiredApprovals": _lines(needs.value), "acceptance": _lines(checks.value),
                                                  "owner": owner.value, "reviewer": reviewer.value}, ok="Task created."):
                d.close()
                after()

        with ui.row().classes("justify-end w-full"):
            ui.button("Cancel", on_click=d.close).props("flat")
            ui.button("Create", on_click=save)
    d.open()


def _save_recipe_dialog(pid: str, tid: str) -> None:
    with ui.dialog() as d, ui.card().classes("w-[460px]"):
        ui.label("Save this task as a recipe").classes("font-semibold")
        _note("Only the task's wording is kept: no files, facts, runs, approvals or connection grants.")
        name = ui.input("Recipe name").props("maxlength=80").classes("w-full")

        async def save():
            if await _try(recipes.from_task, pid, tid, name.value, ok="Recipe saved (see Recipes)."):
                d.close()

        with ui.row().classes("justify-end w-full"):
            ui.button("Cancel", on_click=d.close).props("flat")
            ui.button("Save", on_click=save)
    d.open()


# --- Evidence ---


def evidence_tab(p: dict) -> None:
    pid, editable = p["id"], p["status"] == "active"
    box = ui.column().classes("w-full gap-2")

    def render() -> None:
        box.clear()
        with box:
            ui.label("Evidence Receipts: what supports or contradicts a claim, which version of a file it's about, and its limits. "
                     "Only tests that passed in the sandbox count as supporting automatically; anything else an agent reports is inconclusive until you check it.").classes("op-muted text-sm")
            if editable:
                with ui.expansion("Record evidence yourself", icon="add").classes("w-full op-card"):
                    claim = ui.input("Claim").classes("w-full")
                    with ui.row().classes("w-full"):
                        kind = ui.select(list(work.EVIDENCE_KINDS), value="human", label="kind").classes("w-40")
                        result = ui.select(list(work.RESULTS), value="supports", label="result").classes("w-40")
                        artifact = ui.select({"": "(no file)", **{f["name"]: f["name"] for f in projects.files(pid)}}, value="", label="about file").classes("w-56")
                    source = ui.input("Source (link, reference, how you checked)").classes("w-full")
                    lim = ui.input("Limitations").classes("w-full")

                    async def add():
                        if await _try(work.add_evidence, pid, {"kind": kind.value, "result": result.value, "claim": claim.value, "source": source.value,
                                                                "artifact": artifact.value or "", "limitations": lim.value}, ok="Evidence recorded."):
                            render()

                    ui.button("Save", on_click=add)
            rows = work.evidence(pid)
            if not rows:
                ui.label("No evidence recorded yet.").classes("op-muted text-sm")
            for e in rows:
                with ui.card().classes("op-card w-full"):
                    with ui.row().classes("items-center gap-2"):
                        _badge(e["result"])
                        _badge(e["kind"], "pending")
                        if e["change_stage"] != "none":
                            _badge(e["change_stage"], "running")
                        ui.label(e["claim"][:200]).classes("text-sm font-medium")
                    meta = [f"by {e['actor']} ({e['actor_type']})", e["created_at"][:16].replace("T", " ") + " UTC"]
                    if e["source"]:
                        meta.insert(0, f"source: {e['source'][:80]}")
                    if e["artifact"]:
                        meta.insert(0, f"file: {e['artifact']}" + (f" @ {e['artifact_sha256'][:10]}" if e["artifact_sha256"] else ""))
                    _note(" · ".join(meta))
                    if e["artifact_changed"]:
                        ui.label("The file has changed since this evidence was recorded.").classes("text-xs text-orange-700")
                    if e["limitations"]:
                        ui.label(f"Limits: {e['limitations']}").classes("text-xs")

    render()


# --- Changes & Readiness ---


def changes_tab(p: dict) -> None:
    pid, editable = p["id"], p["status"] == "active"
    box = ui.column().classes("w-full gap-3")

    def render() -> None:
        box.clear()
        with box:
            ui.label("Change Radar").classes("font-semibold")
            _note("Raised automatically when a file, requirement, decision or fact changes. “Confirmed” means a recorded link (citation, import, pinned evidence, trace); "
                  "“suspected” means only a mention. No AI model decides these.")
            rows = radar.alerts(pid, "open") + radar.alerts(pid, "postponed")
            if not rows:
                ui.label("No open alerts.").classes("op-muted text-sm")
            for a in rows:
                with ui.card().classes("op-card w-full"):
                    with ui.row().classes("items-center gap-2"):
                        _badge(a["relation"])
                        if a["status"] == "postponed":
                            _badge("postponed", "pending")
                        ui.label(f"{a['affected_kind']}: {a['affected_summary'][:150]}").classes("text-sm font-medium")
                    ui.label(f"Because: {a['trigger_summary']}").classes("text-sm")
                    ui.label(a["explanation"]).classes("text-sm")
                    ui.label(f"Next: {a['next_step']}").classes("text-sm text-indigo-800")
                    if editable:
                        with ui.row().classes("gap-1"):
                            for st, label in (("resolved", "Resolved"), ("dismissed", "Not affected"), ("postponed", "Later")):
                                ui.button(label, on_click=lambda a=a, st=st: _sync(radar.set_alert, pid, a["id"], st, then=render)).props("flat dense")
            ui.separator()
            ui.label("Readiness Check").classes("font-semibold")
            out = ui.column().classes("w-full")

            def run_check():
                out.clear()
                r = radar.readiness(pid)
                with out:
                    for d in r["dimensions"]:
                        with ui.row().classes("items-start gap-2 w-full"):
                            _badge(d["state"].replace("_", " "), d["state"])
                            with ui.column().classes("gap-0"):
                                ui.label(d["label"]).classes("text-sm font-medium")
                                ui.label(d["detail"]).classes("text-xs op-muted")
                                for it in d["items"][:6]:
                                    ui.label(f"• {it}").classes("text-xs")
                    ui.label(r["disclaimer"]).classes("text-xs text-orange-800")

            ui.button("Run readiness check", icon="checklist", on_click=run_check).props("outline")
            ui.separator()
            ui.label("Research-to-Build links").classes("font-semibold")
            _note("Link a source or finding to a decision, a decision to a task, a task's change to its evidence. A link's note is what you write; OmniPilot never invents a rationale.")
            if editable:
                _link_form(pid, render)
            for l in radar.links(pid)[:40]:
                with ui.row().classes("items-center gap-2 w-full text-sm"):
                    ui.label(f"{l['from_kind']}: {l['from_summary'][:60]}")
                    ui.icon("arrow_forward").classes("op-muted")
                    ui.label(f"{l['to_kind']}: {l['to_summary'][:60]}")
                    if l["note"]:
                        ui.label(f"— {l['note']}").classes("op-muted")
                    ui.space()
                    ui.button(icon="account_tree", on_click=lambda l=l: _trace_dialog(pid, l["from_kind"], l["from_id"])).props('flat dense aria-label="Show trace"')
                    if editable:
                        ui.button(icon="link_off", on_click=lambda l=l: (radar.unlink(pid, l["id"]), render())).props('flat dense aria-label="Remove link"')

    render()


def _items_for(pid: str) -> dict:
    p = projects.get(pid)
    opts = {}
    for r in p["requirements"]:
        opts[f"requirement|{r}"] = f"Requirement: {r[:60]}"
    for f in project_dna.facts(pid):
        opts[f"fact|{f['id']}"] = f"{f['kind'].replace('_', ' ').title()}: {f['content'][:60]}"
    for t in work.tasks(pid):
        opts[f"task|{t['id']}"] = f"Task: {t['title'][:60]}"
    for e in work.evidence(pid)[:50]:
        opts[f"evidence|{e['id']}"] = f"Evidence: {e['claim'][:60]}"
    for f in projects.files(pid):
        opts[f"file|{f['name']}"] = f"File: {f['name']}"
    for r in projects.runs(pid)[:30]:
        opts[f"run|{r['id']}"] = f"Run: {r['request'][:60]}"
    for c in bench.comparisons(pid)[:20]:
        opts[f"comparison|{c['id']}"] = f"Comparison: {c['title'][:60]}"
    return opts


def _link_form(pid: str, after) -> None:
    opts = _items_for(pid)
    with ui.row().classes("w-full items-end"):
        a = ui.select(opts, label="from", with_input=True).classes("w-72")
        b = ui.select(opts, label="to", with_input=True).classes("w-72")
        note = ui.input("note (optional)").classes("grow")

        async def add():
            if not a.value or not b.value:
                return
            fk, fi = a.value.split("|", 1)
            tk, ti = b.value.split("|", 1)
            if await _try(radar.link, pid, fk, fi, tk, ti, note.value or "", ok="Linked."):
                after()

        ui.button("Link", on_click=add)


def _trace_dialog(pid: str, kind: str, ref: str) -> None:
    t = radar.trace(pid, kind, ref)
    with ui.dialog() as d, ui.card().classes("w-[640px]"):
        ui.label(f"Trace: {t['root']['kind']} — {t['root']['summary'][:80]}").classes("font-semibold")
        if not t["edges"]:
            _note("Nothing is linked to this yet.")
        for e in t["edges"]:
            ui.label(f"{e['from']['kind']} → {e['to']['kind']}: {next((n['summary'] for n in t['nodes'] if n['id'] == e['to']['id']), '')[:80]}  ({e['note']})").classes("text-sm")
        ui.button("Close", on_click=d.close).props("flat")
    d.open()


# --- Compare & Branches, Challenge My Plan ---


def compare_tab(p: dict) -> None:
    pid, editable = p["id"], p["status"] == "active"
    box = ui.column().classes("w-full gap-3")

    def render() -> None:
        box.clear()
        with box:
            ui.label("Challenge My Plan").classes("font-semibold")
            _note("The model looks for weak assumptions: why each matters, the missing evidence, the smallest useful test, and the result that would change the plan. "
                  "These are suggestions, not facts.")
            if editable:
                plan = ui.textarea("Plan to challenge (leave empty to use the project's brief and confirmed DNA)").props("autogrow maxlength=4000").classes("w-full")
                tasks = {"": "(no task)", **{t["id"]: t["title"] for t in work.tasks(pid)}}
                task = ui.select(tasks, value="", label="or a task's contract").classes("w-72")

                async def go():
                    ui.notify("Asking the model…")
                    if await _try(bench.challenge, pid, plan.value or "", task.value or None):
                        render()

                ui.button("Challenge", icon="psychology_alt", on_click=go).props("outline")
            for c in bench.challenges(pid)[:5]:
                with ui.card().classes("op-card w-full"):
                    _note(f"{c['label']} · {c['created_at'][:16].replace('T', ' ')} UTC")
                    if not c["items"]:
                        ui.label("The model didn't return usable points.").classes("op-muted text-sm")
                    for i, it in enumerate(c["items"]):
                        with ui.column().classes("gap-0 w-full border-b border-gray-100 pb-1"):
                            with ui.row().classes("items-center gap-2"):
                                _badge(it["severity"], {"high": "failed", "medium": "awaiting_approval", "low": "pending"}[it["severity"]])
                                ui.label(it["assumption"]).classes("text-sm font-medium")
                            for label, key in (("Why it matters", "why_it_matters"), ("Missing evidence", "missing_evidence"), ("Smallest useful test", "smallest_test"),
                                               ("Would change the plan if", "would_change_plan")):
                                if it[key]:
                                    ui.label(f"{label}: {it[key]}").classes("text-xs")
                            if editable and not it.get("sentToInbox"):
                                ui.button("Send to Assumption Inbox", on_click=lambda c=c, i=i: _sync(bench.send_to_inbox, pid, c["id"], i, then=render, ok="Added as unverified.")).props("flat dense")
                            elif it.get("sentToInbox"):
                                _note("In the Assumption Inbox")
            ui.separator()
            ui.label("Comparison Bench").classes("font-semibold")
            _note("Two to four variants, same inputs and criteria. Measurements are what actually happened; quality isn't scored for you.")
            if editable:
                _bench_form(pid, render)
            for c in bench.comparisons(pid)[:10]:
                _comparison_card(pid, c, editable, render)
            ui.separator()
            ui.label("Branches").classes("font-semibold")
            _note("Try changes to Project DNA, tasks and evidence without touching the main project, compare, then merge what you want. "
                  "If an entry changed in the main project since, that change is a conflict and isn't applied.")
            if editable:
                with ui.row().classes("items-end"):
                    name = ui.input("New branch name").props("maxlength=120")
                    purpose = ui.input("Purpose").classes("w-72")
                    ui.button("Create", on_click=lambda: _sync(bench.create_branch, pid, name.value, purpose.value or "", then=render))
            for b in bench.branches(pid):
                _branch_card(pid, b, editable, render)

    render()


def _bench_form(pid: str, after) -> None:
    with ui.expansion("New comparison", icon="compare").classes("w-full op-card"):
        kind = ui.toggle({"prompt": "Prompts", "code": "Code", "simulation": "Simulations"}, value="prompt")
        title = ui.input("Title").classes("w-full")
        shared = ui.textarea("Prompts: the test input · Code: tests, one expression per line").props("autogrow").classes("w-full")
        lang = ui.select(["python", "javascript"], value="python", label="language (code)").classes("w-48")
        criteria = ui.input("Criteria (comma-separated)").classes("w-full")
        a = ui.textarea("Variant A (prompt, code or scenario)").props("autogrow").classes("w-full")
        b = ui.textarea("Variant B").props("autogrow").classes("w-full")

        async def run():
            crit = [x.strip() for x in (criteria.value or "").split(",") if x.strip()]
            field = {"prompt": "prompt", "code": "code", "simulation": "scenario"}[kind.value]
            data = {"title": title.value, "criteria": crit, "variants": [{"label": "A", field: a.value}, {"label": "B", field: b.value}]}
            if kind.value == "prompt":
                data["input"] = shared.value
                fn = bench.compare_prompts
            elif kind.value == "code":
                data.update(language=lang.value, tests=_lines(shared.value))
                fn = bench.compare_code
            else:
                fn = bench.compare_simulations
            ui.notify("Running…")
            if await _try(fn, pid, data, ok="Compared."):
                after()

        ui.button("Run comparison", on_click=run)


def _comparison_card(pid: str, c: dict, editable: bool, after) -> None:
    with ui.card().classes("op-card w-full"):
        ui.label(f"{c['title']} ({c['kind']})").classes("font-medium text-sm")
        if c["criteria"]:
            _note("Criteria: " + ", ".join(c["criteria"]))
        with ui.grid(columns=f"repeat({len(c['results'])}, minmax(0, 1fr))").classes("w-full gap-2"):
            for r in c["results"]:
                with ui.column().classes("gap-1 border border-gray-200 rounded p-2"):
                    ui.label(r["label"]).classes("font-medium text-sm")
                    if r.get("error"):
                        ui.label(r["error"][:300]).classes("text-xs text-red-700")
                    if c["kind"] == "prompt":
                        _note(f"{r.get('model') or 'no model'} · {r['ms']} ms · tokens {r['promptTokens'] if r.get('promptTokens') is not None else 'unavailable'}"
                              f"+{r['completionTokens'] if r.get('completionTokens') is not None else '?'} · cost {('$%.4f' % r['costUsd']) if r.get('costUsd') is not None else 'unavailable'}")
                        ui.markdown(r["output"][:3000]).classes("text-sm")
                    elif c["kind"] == "code":
                        _note(f"{r['passed']}/{r['total']} tests passed · {r['ms']} ms" if r.get("ran") else "not run")
                        for f in r.get("failures") or []:
                            ui.label(f).classes("text-xs text-red-700")
                    else:
                        _note(f"{r.get('kind')} · inputs {json.dumps(r.get('inputs', {}))}")
                        ui.label(json.dumps(r.get("outputs", {}))[:500]).classes("text-xs")
                        if r.get("inferred"):
                            _note("defaults used for: " + ", ".join(r["inferred"]))
                    if editable:
                        ui.button("Choose this one", on_click=lambda r=r: _sync(bench.choose_winner, pid, c["id"], r["label"], then=after, ok="Recorded as evidence.")).props("flat dense")
        for lim in c["limitations"]:
            ui.label(f"Limit: {lim}").classes("text-xs op-muted")


def _branch_card(pid: str, b: dict, editable: bool, after) -> None:
    full = bench.get_branch(pid, b["id"])
    with ui.card().classes("op-card w-full"):
        with ui.row().classes("items-center gap-2"):
            _badge(b["status"], {"open": "running", "merged": "completed", "abandoned": "cancelled"}[b["status"]])
            ui.label(b["name"]).classes("font-medium text-sm")
            if b["purpose"]:
                _note(b["purpose"])
        for c in full["comparison"]:
            with ui.row().classes("items-center gap-2 w-full text-sm"):
                _badge(c["status"] if not c["conflict"] else "conflict", "failed" if c["conflict"] else c["status"])
                ui.label(c["op"].replace("_", " "))
                if c["main"]:
                    ui.label(f"main: {c['main']['content'][:60]}").classes("op-muted")
                    ui.icon("arrow_forward").classes("op-muted")
                ui.label(json.dumps(c["payload"], ensure_ascii=False)[:100])
        if editable and b["status"] == "open":
            facts = {f["id"]: f"{f['kind']}: {f['content'][:50]}" for f in project_dna.facts(pid)}
            with ui.row().classes("items-end w-full"):
                op = ui.select(list(bench.BRANCH_OPS), value="add_fact", label="change").classes("w-36")
                target = ui.select(facts, label="entry (edit/retire)").props("clearable").classes("w-60")
                kind = ui.select(list(project_dna.KINDS), value="decision", label="kind (add fact)").classes("w-40")
                text = ui.input("text / title / claim").classes("grow")
                why = ui.input("rationale").classes("w-48")

                async def add():
                    payload = {"add_fact": {"kind": kind.value, "content": text.value, "rationale": why.value}, "edit_fact": {"content": text.value, "rationale": why.value},
                               "retire_fact": {"reason": text.value}, "add_task": {"title": text.value}, "add_evidence": {"claim": text.value}}[op.value]
                    if await _try(bench.propose, pid, b["id"], op.value, payload, target.value):
                        after()

                ui.button("Add to branch", on_click=add).props("flat")
            with ui.row().classes("gap-2"):
                ui.button("Merge…", on_click=lambda: _merge_dialog(pid, b, after)).props("outline")
                ui.button("Abandon", on_click=lambda: _sync(bench.abandon, pid, b["id"], then=after)).props("flat color=negative")


def _merge_dialog(pid: str, b: dict, after) -> None:
    pv = bench.merge_preview(pid, b["id"])
    with ui.dialog() as d, ui.card().classes("w-[560px]"):
        ui.label(f"Merge “{b['name']}”").classes("font-semibold")
        ui.label(f"Will apply {len(pv['will_apply'])} change(s).").classes("text-sm")
        for c in pv["will_apply"]:
            ui.label(f"• {c['op'].replace('_', ' ')}: {json.dumps(c['payload'], ensure_ascii=False)[:100]}").classes("text-sm")
        if pv["conflicts"]:
            ui.label(f"{len(pv['conflicts'])} conflict(s) won't be applied.").classes("text-sm text-red-700")
            _note(pv["note"])

        async def go():
            if await _try(bench.merge, pid, b["id"], True, ok="Merged."):
                d.close()
                after()

        with ui.row().classes("justify-end w-full"):
            ui.button("Cancel", on_click=d.close).props("flat")
            ui.button("Merge", on_click=go)
    d.open()


# --- Learn ---


def learn_tab(p: dict) -> None:
    pid, editable = p["id"], p["status"] == "active"
    box = ui.column().classes("w-full gap-3")

    def render() -> None:
        box.clear()
        on = learn.learn_mode(pid)
        with box:
            ui.label("Teach-Back (CodePilot Learn Mode)").classes("font-semibold")
            _note("Opt-in. Learning notes are yours: kept apart from Project DNA, never used as project facts, never exported.")
            if editable:
                ui.switch("Learn Mode", value=on, on_change=lambda e: (learn.set_learn_mode(pid, bool(e.value)), render()))
            if not on:
                return
            with ui.card().classes("op-card w-full"):
                subject = ui.input("Subject (e.g. recursion, the soil moisture model)").classes("w-full")
                with ui.row().classes("w-full"):
                    mode = ui.select({"explain": "Explain this", "hint": "Give me a hint", "question": "Ask me a question", "check": "Check my explanation",
                                      "present": "Prepare me to present"}, value="explain", label="what").classes("w-56")
                    depth = ui.select(list(learn.DEPTHS), value="normal", label="depth").classes("w-32")
                    files = {"": "(no file)", **{f["id"]: f["name"] for f in projects.files(pid)}}
                    file = ui.select(files, value="", label="use a project file").classes("w-56")
                mine = ui.textarea("Your explanation (for “Check my explanation”)").props("autogrow maxlength=4000").classes("w-full")

                async def go():
                    ui.notify("Thinking…")
                    if await _try(learn.teach, pid, mode.value, subject.value, depth.value, mine.value or "", file.value or None):
                        render()

                ui.button("Go", on_click=go)
            for n in learn.notes(pid)[:20]:
                with ui.card().classes("op-card w-full"):
                    with ui.row().classes("items-center gap-2"):
                        _badge(n["mode"], "pending")
                        ui.label(f"{n['subject']} ({n['depth']})").classes("text-sm font-medium")
                        ui.space()
                        ui.button(icon="delete", on_click=lambda n=n: (learn.delete_note(pid, n["id"]), render())).props('flat dense aria-label="Delete note"')
                    if n["user_input"]:
                        ui.label(f"You wrote: {n['user_input'][:400]}").classes("text-xs op-muted")
                    ui.markdown(n["content"]).classes("text-sm")
                    _note(f"From {n['model']} · {n['created_at'][:16].replace('T', ' ')} UTC")

    render()


# --- Handoff ---


def handoff_tab(p: dict) -> None:
    pid = p["id"]
    box = ui.column().classes("w-full gap-3")
    state = {"preset": "quick_summary", "remove": set()}

    def render() -> None:
        box.clear()
        with box:
            ui.label("Handoff Capsules").classes("font-semibold")
            _note("A previewable export for someone else, or for later. Untick anything you don't want included. Credentials and secrets are never included.")
            ui.toggle({k: v["label"] for k, v in handoff.PRESETS.items()}, value=state["preset"],
                      on_change=lambda e: (state.update(preset=e.value, remove=set()), render()))
            pv = handoff.preview(pid, state["preset"])
            for s in pv["sections"]:
                ui.label(s["title"]).classes("text-sm font-medium mt-1")
                if not s["items"]:
                    _note("(nothing recorded)")
                for it in s["items"]:
                    ui.checkbox(it["text"][:200] + ("  · AI" if it["ai"] else ""), value=it["id"] not in state["remove"],
                                on_change=lambda e, i=it["id"]: state["remove"].discard(i) if e.value else state["remove"].add(i)).classes("text-sm")
            _note("Not included: " + ", ".join(pv["excluded"]))

            async def make():
                out = await _try(handoff.build, pid, state["preset"], sorted(state["remove"]), ok="Capsule made.")
                if out:
                    render()

            ui.button("Make capsule", icon="inventory_2", on_click=make)
            ui.separator()
            from .pages import _out_link

            for h in handoff.handoffs(pid)[:10]:
                with ui.row().classes("items-center gap-3"):
                    ui.label(f"{handoff.PRESETS[h['preset']]['label']} · {h['created_at'][:16].replace('T', ' ')} UTC").classes("text-sm")
                    _out_link("Markdown", f"/api/projects/{pid}/handoffs/{h['id']}/download?format=md", "Download as Markdown", download=True)
                    _out_link("JSON", f"/api/projects/{pid}/handoffs/{h['id']}/download?format=json", "Download as JSON", download=True)

    render()


# --- Settings & Permissions additions ---


def permissions_cards(p: dict) -> None:
    pid, editable = p["id"], p["status"] == "active"
    with ui.card().classes("op-card w-full"):
        ui.label("Connections this project may use").classes("font-semibold")
        _note("Connections are set up once (Connections page). A project can only use what's ticked here; it's checked again when an action is approved.")
        have = {(g["connector"], g["capability"]) for g in grants.grants_for(pid)}
        connected = {c["name"]: c["status"] for c in store.list_connectors()}
        with ui.grid(columns="max-content repeat(3, max-content) 1fr").classes("gap-x-4 gap-y-1 items-center"):
            ui.label("")
            for cap in grants.CAPABILITIES:
                ui.label(cap).classes("text-xs op-muted")
            ui.label("")
            for conn in grants.CONNECTORS:
                ui.label(conn).classes("text-sm")
                for cap in grants.CAPABILITIES:
                    ui.checkbox(value=(conn, cap) in have, on_change=lambda e, conn=conn, cap=cap: _sync(grants.grant if e.value else grants.revoke, pid, conn, cap)).props(
                        f'dense aria-label="{cap} access to {conn}"' + ("" if editable else " disable"))
                st = connected.get(conn)
                ui.label(st.replace("_", " ") if st else "").classes("text-xs op-muted")
    with ui.card().classes("op-card w-full"):
        ui.label("Budget and usage").classes("font-semibold")
        u = project_usage(pid)
        with ui.row().classes("items-end"):
            budget = ui.number("Budget per run (USD)", value=u["runBudgetUsd"], min=0, max=100, step=0.01, format="%.2f").classes("w-72")

            async def save():
                await _try(projects.set_run_budget, pid, float(budget.value) if budget.value not in (None, "") else None, ok="Budget saved.")

            ui.button("Save", on_click=save).props("flat")
        _note("The most paid services (search, browsers, cloud sandboxes) may cost in one run of this project; empty means the app-wide limit per request only.")
        t = u["totals"]
        ui.label(f"Task runs: {len(u['runs'])} · conversation runs: {len(u.get('conversationRuns', []))} · model calls {t['modelCalls']} · tokens "
                 f"{(str(t['promptTokens']) + '+' + str(t['completionTokens'])) if t['promptTokens'] is not None else 'partly unavailable'} · paid tools ≈ ${t['paidToolsEstUsd']:.3f}").classes("text-sm")
        _note(u["note"])


# --- Recipes page ---


@ui.page("/recipes")
async def recipes_page(request: Request):
    from .pages import _frame, _guard, _sign_in

    if not await _guard(request):
        return _sign_in()
    body = _frame("Recipes", "Recipes")
    with body:
        ui.label("A recipe is a reusable workflow; a routine runs it daily in one project; each run is an ordinary task there. "
                 "Recipes carry no project data or connection grants.").classes("op-muted text-sm")
        box = ui.column().classes("w-full gap-3")

        def render():
            box.clear()
            with box:
                with ui.expansion("New recipe", icon="add").classes("w-full op-card"):
                    name = ui.input("Name").classes("w-full")
                    desc = ui.input("Description").classes("w-full")
                    inputs = ui.input("Inputs (comma-separated names, e.g. topic, file_name)").classes("w-full")
                    steps = ui.textarea("Steps, one per line (use {{topic}} for inputs)").props("autogrow").classes("w-full")
                    acc = ui.textarea("Acceptance checks, one per line").props("autogrow").classes("w-full")
                    outs = ui.textarea("Outputs, one per line").props("autogrow").classes("w-full")

                    async def create():
                        if await _try(recipes.create, {"name": name.value, "description": desc.value, "inputs": [x.strip() for x in (inputs.value or "").split(",") if x.strip()],
                                                       "steps": _lines(steps.value), "acceptance": _lines(acc.value), "outputs": _lines(outs.value)}, ok="Recipe saved."):
                            render()

                    ui.button("Save", on_click=create)
                rows = recipes.all_recipes()
                if not rows:
                    ui.label("No recipes yet. Make one here or save a task as a recipe.").classes("op-muted text-sm")
                plist = {p["id"]: p["name"] for p in projects.list_projects()}
                for r in rows:
                    with ui.card().classes("op-card w-full"):
                        ui.label(r["name"]).classes("font-medium")
                        if r["description"]:
                            _note(r["description"])
                        for i, s in enumerate(r["steps"], 1):
                            ui.label(f"{i}. {s}").classes("text-sm")
                        if r["acceptance"]:
                            _note("Done when: " + "; ".join(r["acceptance"]))
                        with ui.row().classes("items-end w-full"):
                            proj = ui.select(plist, label="project").classes("w-56")
                            vals = {i["name"]: ui.input(i["name"]).classes("w-40") for i in r["inputs"]}
                            daily = ui.input("daily at (HH:MM, optional)").classes("w-40")

                            async def run(r=r, proj=proj, vals=vals):
                                if await _try(recipes.run_in_project, r["id"], proj.value, {k: v.value for k, v in vals.items()}, ok="Started as a task in the project."):
                                    ui.navigate.to(f"/projects/{proj.value}?tab=tasks")

                            async def routine(r=r, proj=proj, vals=vals, daily=daily):
                                if await _try(recipes.add_routine, r["id"], proj.value, daily.value, {k: v.value for k, v in vals.items()}, ok="Routine added."):
                                    render()

                            ui.button("Run now", on_click=run).props("outline")
                            ui.button("Add daily routine", on_click=routine).props("flat")
                            from .pages import _out_link

                            _out_link("Export", f"/api/recipes/{r['id']}/export", "Export this recipe", download=True)
                            ui.button(icon="delete", on_click=lambda r=r: (recipes.delete(r["id"]), render())).props('flat dense aria-label="Delete recipe"')
                rts = recipes.routines()
                if rts:
                    ui.label("Routines").classes("font-semibold")
                for rt in rts:
                    with ui.row().classes("items-center gap-2"):
                        ui.label(f"{rt['recipe_name']} · daily at {rt['daily_at']} · {plist.get(rt['project_id'], 'archived project')}").classes("text-sm")
                        _note(f"last run {rt['last_run_date'] or 'never'}")
                        ui.switch(value=bool(rt["enabled"]), on_change=lambda e, rt=rt: recipes.set_routine(rt["project_id"], rt["id"], bool(e.value)))
                        ui.button(icon="delete", on_click=lambda rt=rt: (recipes.set_routine(rt["project_id"], rt["id"], delete=True), render())).props('flat dense aria-label="Delete routine"')

        render()
