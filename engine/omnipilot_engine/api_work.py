"""Routes for slices 3-9 (docs/product): tasks and runs, evidence, recovery, Change Radar and trace links,
readiness, Comparison Bench, branches, Challenge My Plan, Learn Mode, Return Briefing, Handoff Capsules,
recipes and routines, connection grants, budgets and usage. Same owner check and project access as api_projects."""
from __future__ import annotations

import json
from urllib.parse import quote

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response

from . import bench, grants, handoff, learn, projects, radar, recipes, store, work
from .projects import ProjectError


def register(app: FastAPI, route, json_body) -> None:
    # --- tasks, attempts, steps ---

    @route("GET", "/api/projects/{project_id}/tasks")
    async def list_tasks(request: Request, project_id: str):
        return {"tasks": work.tasks(project_id)}

    @route("POST", "/api/projects/{project_id}/tasks")
    async def create_task(request: Request, project_id: str):
        return JSONResponse(work.create_task(project_id, await json_body(request)), status_code=201)

    @route("GET", "/api/projects/{project_id}/tasks/{task_id}")
    async def get_task(request: Request, project_id: str, task_id: str):
        return work.get_task(project_id, task_id)

    @route("PATCH", "/api/projects/{project_id}/tasks/{task_id}")
    async def update_task(request: Request, project_id: str, task_id: str):
        return work.update_task(project_id, task_id, await json_body(request))

    @route("POST", "/api/projects/{project_id}/tasks/{task_id}/start")
    async def start_task(request: Request, project_id: str, task_id: str):
        return JSONResponse(work.start_task(project_id, task_id), status_code=202)

    @route("POST", "/api/projects/{project_id}/tasks/{task_id}/resume")
    async def resume_task(request: Request, project_id: str, task_id: str):
        return JSONResponse(work.resume_task(project_id, task_id), status_code=202)

    @route("POST", "/api/projects/{project_id}/tasks/{task_id}/cancel")
    async def cancel_task(request: Request, project_id: str, task_id: str):
        return work.cancel_task(project_id, task_id)

    @route("POST", "/api/projects/{project_id}/steps/{step_id}/retry")
    async def retry_step(request: Request, project_id: str, step_id: str):
        return await work.retry_step(project_id, step_id)

    @route("POST", "/api/projects/{project_id}/steps/{step_id}/reconcile")
    async def reconcile_step(request: Request, project_id: str, step_id: str):
        return work.reconcile_step(project_id, step_id, str((await json_body(request)).get("outcome", "")))

    @route("POST", "/api/projects/{project_id}/checks/{check_id}")
    async def set_check(request: Request, project_id: str, check_id: str):
        b = await json_body(request)
        return work.set_check(project_id, check_id, str(b.get("state", "")), b.get("evidenceId") if isinstance(b.get("evidenceId"), str) else None, b.get("note") or "")

    # --- evidence ---

    @route("GET", "/api/projects/{project_id}/evidence")
    async def list_evidence(request: Request, project_id: str, task: str | None = None):
        return {"evidence": work.evidence(project_id, task_id=task)}

    @route("POST", "/api/projects/{project_id}/evidence")
    async def add_evidence(request: Request, project_id: str):
        return JSONResponse(work.add_evidence(project_id, await json_body(request)), status_code=201)

    # --- Change Radar, trace, readiness ---

    @route("GET", "/api/projects/{project_id}/alerts")
    async def list_alerts(request: Request, project_id: str, status: str = "open"):
        return {"alerts": radar.alerts(project_id, None if status == "all" else status)}

    @route("POST", "/api/projects/{project_id}/alerts/{alert_id}")
    async def set_alert(request: Request, project_id: str, alert_id: str):
        return radar.set_alert(project_id, alert_id, str((await json_body(request)).get("status", "")))

    @route("GET", "/api/projects/{project_id}/links")
    async def list_links(request: Request, project_id: str):
        return {"links": radar.links(project_id)}

    @route("POST", "/api/projects/{project_id}/links")
    async def add_link(request: Request, project_id: str):
        b = await json_body(request)
        return JSONResponse(radar.link(project_id, str(b.get("fromKind")), str(b.get("fromId")), str(b.get("toKind")), str(b.get("toId")), b.get("note") or ""), status_code=201)

    @route("DELETE", "/api/projects/{project_id}/links/{link_id}")
    async def delete_link(request: Request, project_id: str, link_id: str):
        return {"deleted": radar.unlink(project_id, link_id)}

    @route("GET", "/api/projects/{project_id}/trace")
    async def get_trace(request: Request, project_id: str, kind: str, id: str):
        return radar.trace(project_id, kind, id)

    @route("POST", "/api/projects/{project_id}/readiness")
    async def run_readiness(request: Request, project_id: str):
        return radar.readiness(project_id)

    # --- Comparison Bench, branches, Challenge My Plan ---

    @route("GET", "/api/projects/{project_id}/comparisons")
    async def list_comparisons(request: Request, project_id: str):
        return {"comparisons": bench.comparisons(project_id)}

    @route("POST", "/api/projects/{project_id}/comparisons")
    async def run_comparison(request: Request, project_id: str):
        b = await json_body(request)
        fn = {"prompt": bench.compare_prompts, "code": bench.compare_code, "simulation": bench.compare_simulations}.get(b.get("kind"))
        if not fn:
            raise ProjectError(400, "invalid_request", "kind must be prompt, code or simulation.")
        return JSONResponse(await fn(project_id, b), status_code=201)

    @route("POST", "/api/projects/{project_id}/comparisons/{cid}/winner")
    async def choose_winner(request: Request, project_id: str, cid: str):
        b = await json_body(request)
        return bench.choose_winner(project_id, cid, str(b.get("label", "")), b.get("note") or "")

    @route("GET", "/api/projects/{project_id}/branches")
    async def list_branches(request: Request, project_id: str):
        return {"branches": bench.branches(project_id)}

    @route("POST", "/api/projects/{project_id}/branches")
    async def create_branch(request: Request, project_id: str):
        b = await json_body(request)
        return JSONResponse(bench.create_branch(project_id, b.get("name"), b.get("purpose") or ""), status_code=201)

    @route("GET", "/api/projects/{project_id}/branches/{bid}")
    async def get_branch(request: Request, project_id: str, bid: str):
        return bench.get_branch(project_id, bid)

    @route("POST", "/api/projects/{project_id}/branches/{bid}/changes")
    async def propose(request: Request, project_id: str, bid: str):
        b = await json_body(request)
        return JSONResponse(bench.propose(project_id, bid, str(b.get("op")), b.get("payload") or {}, b.get("targetId")), status_code=201)

    @route("DELETE", "/api/projects/{project_id}/branches/{bid}/changes/{change_id}")
    async def discard(request: Request, project_id: str, bid: str, change_id: str):
        return bench.discard_change(project_id, bid, change_id)

    @route("GET", "/api/projects/{project_id}/branches/{bid}/merge-preview")
    async def merge_preview(request: Request, project_id: str, bid: str):
        return bench.merge_preview(project_id, bid)

    @route("POST", "/api/projects/{project_id}/branches/{bid}/merge")
    async def merge(request: Request, project_id: str, bid: str):
        return bench.merge(project_id, bid, (await json_body(request)).get("confirm") is True)

    @route("POST", "/api/projects/{project_id}/branches/{bid}/abandon")
    async def abandon(request: Request, project_id: str, bid: str):
        return bench.abandon(project_id, bid)

    @route("GET", "/api/projects/{project_id}/challenges")
    async def list_challenges(request: Request, project_id: str):
        return {"challenges": bench.challenges(project_id)}

    @route("POST", "/api/projects/{project_id}/challenges")
    async def challenge(request: Request, project_id: str):
        b = await json_body(request)
        return JSONResponse(await bench.challenge(project_id, b.get("plan") or "", b.get("taskId")), status_code=201)

    @route("POST", "/api/projects/{project_id}/challenges/{cid}/inbox")
    async def challenge_to_inbox(request: Request, project_id: str, cid: str):
        return JSONResponse(bench.send_to_inbox(project_id, cid, (await json_body(request)).get("index")), status_code=201)

    # --- Learn Mode, Return Briefing ---

    @route("GET", "/api/projects/{project_id}/learn")
    async def learn_state(request: Request, project_id: str):
        return {"enabled": learn.learn_mode(project_id), "notes": learn.notes(project_id), "modes": learn.MODES, "depths": learn.DEPTHS}

    @route("POST", "/api/projects/{project_id}/learn/mode")
    async def learn_toggle(request: Request, project_id: str):
        return {"enabled": learn.set_learn_mode(project_id, (await json_body(request)).get("enabled") is True)}

    @route("POST", "/api/projects/{project_id}/learn")
    async def teach(request: Request, project_id: str):
        b = await json_body(request)
        return JSONResponse(await learn.teach(project_id, str(b.get("mode")), b.get("subject"), str(b.get("depth") or "normal"), b.get("input") or "", b.get("fileId")), status_code=201)

    @route("DELETE", "/api/projects/{project_id}/learn/{note_id}")
    async def delete_note(request: Request, project_id: str, note_id: str):
        return {"deleted": learn.delete_note(project_id, note_id)}

    @route("GET", "/api/projects/{project_id}/briefing")
    async def briefing(request: Request, project_id: str):
        return learn.briefing(project_id)

    @route("POST", "/api/projects/{project_id}/briefing/seen")
    async def briefing_seen(request: Request, project_id: str):
        learn.seen(project_id)
        return {"ok": True}

    # --- Handoff Capsules ---

    @route("GET", "/api/projects/{project_id}/handoffs")
    async def list_handoffs(request: Request, project_id: str):
        return {"handoffs": handoff.handoffs(project_id), "presets": {k: v["label"] for k, v in handoff.PRESETS.items()}}

    @route("GET", "/api/projects/{project_id}/handoffs/preview")
    async def handoff_preview(request: Request, project_id: str, preset: str = "quick_summary"):
        return handoff.preview(project_id, preset)

    @route("POST", "/api/projects/{project_id}/handoffs")
    async def make_handoff(request: Request, project_id: str):
        b = await json_body(request)
        remove = [x for x in (b.get("remove") or []) if isinstance(x, str)]
        return JSONResponse(handoff.build(project_id, str(b.get("preset")), remove), status_code=201)

    @route("GET", "/api/projects/{project_id}/handoffs/{hid}/download")
    async def download_handoff(request: Request, project_id: str, hid: str, format: str = "md"):
        h = handoff.get_handoff(project_id, hid)
        name = quote(f"{projects.get(project_id)['name'][:60]}-{h['preset']}.{'json' if format == 'json' else 'md'}")
        return Response(h["content_json"] if format == "json" else h["content_md"], media_type="application/json" if format == "json" else "text/markdown",
                        headers={"content-disposition": f"attachment; filename*=UTF-8''{name}", "cache-control": "no-store", "x-content-type-options": "nosniff"})

    # --- recipes and routines (recipes are global; running one needs the project) ---

    @route("GET", "/api/recipes")
    async def list_recipes(request: Request):
        return {"recipes": recipes.all_recipes()}

    @route("POST", "/api/recipes")
    async def create_recipe(request: Request):
        b = await json_body(request)
        return JSONResponse(recipes.import_recipe(b) if b.get("format") else recipes.create(b), status_code=201)

    @route("PATCH", "/api/recipes/{rid}")
    async def update_recipe(request: Request, rid: str):
        return recipes.update(rid, await json_body(request))

    @route("DELETE", "/api/recipes/{rid}")
    async def delete_recipe(request: Request, rid: str):
        return {"deleted": recipes.delete(rid)}

    @route("GET", "/api/recipes/{rid}/export")
    async def export_recipe(request: Request, rid: str):
        r = recipes.portable(rid)
        return Response(json.dumps(r, ensure_ascii=False, indent=2), media_type="application/json",
                        headers={"content-disposition": f"attachment; filename*=UTF-8''{quote(r['name'][:60])}.recipe.json", "cache-control": "no-store"})

    @route("POST", "/api/projects/{project_id}/tasks/{task_id}/save-recipe")
    async def save_recipe(request: Request, project_id: str, task_id: str):
        return JSONResponse(recipes.from_task(project_id, task_id, (await json_body(request)).get("name")), status_code=201)

    @route("POST", "/api/projects/{project_id}/recipes/{rid}/run")
    async def run_recipe(request: Request, project_id: str, rid: str):
        return JSONResponse(recipes.run_in_project(rid, project_id, (await json_body(request)).get("inputs") or {}), status_code=202)

    @route("GET", "/api/projects/{project_id}/routines")
    async def list_routines(request: Request, project_id: str):
        projects.require(project_id)
        return {"routines": recipes.routines(project_id)}

    @route("POST", "/api/projects/{project_id}/routines")
    async def add_routine(request: Request, project_id: str):
        b = await json_body(request)
        return JSONResponse(recipes.add_routine(str(b.get("recipeId")), project_id, b.get("dailyAt"), b.get("inputs") or {}), status_code=201)

    @route("PATCH", "/api/projects/{project_id}/routines/{rtid}")
    async def set_routine(request: Request, project_id: str, rtid: str):
        b = await json_body(request)
        return {"ok": recipes.set_routine(project_id, rtid, b.get("enabled") is True, b.get("delete") is True)}

    # --- connection grants, budget, usage ---

    @route("GET", "/api/projects/{project_id}/permissions")
    async def permissions(request: Request, project_id: str):
        return {"grants": grants.grants_for(project_id), "connectors": grants.CONNECTORS, "capabilities": grants.CAPABILITIES,
                "runBudgetUsd": projects.run_budget(project_id), "collaboration": learn.COLLABORATION_NOTE}

    @route("POST", "/api/projects/{project_id}/permissions")
    async def change_permission(request: Request, project_id: str):
        b = await json_body(request)
        fn = grants.grant if b.get("allow") is True else grants.revoke
        return {"grants": fn(project_id, str(b.get("connector")), str(b.get("capability")))}

    @route("POST", "/api/projects/{project_id}/budget")
    async def set_budget(request: Request, project_id: str):
        return projects.set_run_budget(project_id, (await json_body(request)).get("runBudgetUsd"))

    @route("GET", "/api/projects/{project_id}/usage")
    async def usage(request: Request, project_id: str):
        return project_usage(project_id)


def project_usage(project_id: str) -> dict:
    """Usage per task attempt, from what was captured during the runs. Unknown numbers stay unknown."""
    projects.require(project_id)
    rows = store.q("SELECT t.id, t.attempt, t.status, t.usage, t.started_at, k.title FROM task_runs t JOIN project_tasks k ON k.id = t.task_id WHERE t.project_id = ? ORDER BY t.started_at DESC", project_id)
    runs = [{**{k: r[k] for k in ("id", "attempt", "status", "started_at", "title")}, "usage": json.loads(r["usage"])} for r in rows]
    calls = sum(r["usage"].get("modelCalls", 0) for r in runs)
    tools = sum(r["usage"].get("paidToolsEstUsd", 0) or 0 for r in runs)
    # Conversation runs in this project (not task attempts) carry their own usage summary on the run record.
    task_run_ids = {r["id"] for r in store.q("SELECT run_id AS id FROM task_runs WHERE project_id = ? AND run_id IS NOT NULL", project_id)}
    convo = []
    for r in store.q("SELECT id, request, created_at, status, data FROM runs WHERE project_id = ? ORDER BY created_at DESC LIMIT 200", project_id):
        if r["id"] in task_run_ids:
            continue
        u = (json.loads(r["data"]) or {}).get("usage")
        if isinstance(u, dict) and u.get("modelCalls"):
            convo.append({"id": r["id"], "title": r["request"][:80], "status": r["status"], "started_at": r["created_at"], "usage": u})
    metered = runs + convo
    calls = sum(r["usage"].get("modelCalls", 0) for r in metered)
    complete = all(r["usage"].get("tokensNote") == "complete" for r in metered if r["usage"].get("modelCalls"))
    return {"runs": runs, "conversationRuns": convo, "totals": {"modelCalls": calls, "paidToolsEstUsd": round(tools, 4),
                                     "promptTokens": sum(r["usage"].get("promptTokens") or 0 for r in metered) if complete else None,
                                     "completionTokens": sum(r["usage"].get("completionTokens") or 0 for r in metered) if complete else None},
            "runBudgetUsd": projects.run_budget(project_id),
            "note": "Model usage for task attempts and conversation runs. The local model costs nothing; Groq's free tier isn't priced here; paid tools (task runs) show their estimated cost."}
