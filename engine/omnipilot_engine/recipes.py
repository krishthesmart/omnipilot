"""Portable Recipes and routines (docs/product, slice 8).

A recipe is a reusable workflow: named inputs, steps, acceptance checks and expected outputs. Recipes are global
and hold no project data: running one inside a project fills its inputs and creates a task there (so it gets the
project's own files, facts, grants and approvals, never another project's). A routine is a daily trigger for a
recipe in one project. A run is one execution: an ordinary task attempt.
"""
from __future__ import annotations

import asyncio
import datetime as dt
import json
import os
import re
import uuid

from . import projects, store, work
from .projects import OWNER, ProjectError

INPUT_NAME = re.compile(r"^[a-z][a-z0-9_]{0,39}$")
PLACEHOLDER = re.compile(r"\{\{\s*([a-z][a-z0-9_]{0,39})\s*\}\}")
_loop: asyncio.Task | None = None


def _now() -> str:
    return store.now()


def _row(r: dict) -> dict:
    return {**r, **{k: json.loads(r[k]) for k in ("inputs", "steps", "acceptance", "outputs")}}


def _clean(data: dict) -> dict:
    name = projects._clean_text(data.get("name"), "name", 80, required=True)
    inputs = data.get("inputs") or []
    if not isinstance(inputs, list) or len(inputs) > 10:
        raise ProjectError(400, "invalid_request", "inputs: a list of up to 10.")
    clean_inputs = []
    for i in inputs:
        n = i.get("name") if isinstance(i, dict) else i
        if not isinstance(n, str) or not INPUT_NAME.match(n):
            raise ProjectError(400, "invalid_request", "Input names are lowercase words with underscores (e.g. topic, file_name).")
        clean_inputs.append({"name": n, "description": projects._clean_text(i.get("description") if isinstance(i, dict) else "", "description", 200)})
    steps = projects._clean_list(data.get("steps"), "steps")
    if not steps:
        raise ProjectError(400, "invalid_request", "A recipe needs at least one step.")
    names = {i["name"] for i in clean_inputs}
    used = {m for s in [*steps, *projects._clean_list(data.get("acceptance"), "acceptance")] for m in PLACEHOLDER.findall(s)}
    if used - names:
        raise ProjectError(400, "invalid_request", f"Steps use inputs that aren't declared: {', '.join(sorted(used - names))}")
    return {"name": name, "description": projects._clean_text(data.get("description"), "description", 1000), "inputs": clean_inputs, "steps": steps,
            "acceptance": projects._clean_list(data.get("acceptance"), "acceptance"), "outputs": projects._clean_list(data.get("outputs"), "outputs")}


def create(data: dict) -> dict:
    c = _clean(data)
    if store.q1("SELECT 1 AS x FROM recipes WHERE name = ?", c["name"]):
        raise ProjectError(409, "exists", "A recipe with that name exists.")
    rid, now = str(uuid.uuid4()), _now()
    store.x("INSERT INTO recipes (id, name, description, inputs, steps, acceptance, outputs, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            rid, c["name"], c["description"], json.dumps(c["inputs"]), json.dumps(c["steps"]), json.dumps(c["acceptance"]), json.dumps(c["outputs"]), now, now)
    return get(rid)


def get(rid: str) -> dict:
    r = store.q1("SELECT * FROM recipes WHERE id = ?", rid)
    if not r:
        raise ProjectError(404, "not_found", "No such recipe.")
    return _row(r)


def all_recipes() -> list[dict]:
    return [_row(r) for r in store.q("SELECT * FROM recipes ORDER BY name")]


def update(rid: str, data: dict) -> dict:
    old = get(rid)
    c = _clean({**old, **data})
    store.x("UPDATE recipes SET name = ?, description = ?, inputs = ?, steps = ?, acceptance = ?, outputs = ?, updated_at = ? WHERE id = ?",
            c["name"], c["description"], json.dumps(c["inputs"]), json.dumps(c["steps"]), json.dumps(c["acceptance"]), json.dumps(c["outputs"]), _now(), rid)
    return get(rid)


def delete(rid: str) -> bool:
    return bool(store.x("DELETE FROM recipes WHERE id = ?", rid))


def from_task(project_id: str, task_id: str, name: str, actor: str = OWNER) -> dict:
    """Saves a task's shape as a recipe. Only the contract's wording is kept, never files, facts, runs or grants."""
    t = work.get_task(project_id, task_id, actor)
    return create({"name": name, "description": f"Made from a task: {t['title']}"[:1000], "inputs": [],
                   "steps": [t["request"] or t["goal"] or t["title"], *[f"Constraint: {c}" for c in t["constraints"]], *[f"Don't: {o}" for o in t["out_of_scope"]]],
                   "acceptance": [c["text"] for c in t["acceptance"]], "outputs": []})


def portable(rid: str) -> dict:
    """The recipe as a file to share: its definition only."""
    r = get(rid)
    return {"format": "omnipilot.recipe/1", **{k: r[k] for k in ("name", "description", "inputs", "steps", "acceptance", "outputs")}}


def import_recipe(data: dict) -> dict:
    if not isinstance(data, dict) or data.get("format") != "omnipilot.recipe/1":
        raise ProjectError(400, "invalid_request", "That isn't an OmniPilot recipe file.")
    return create(data)


def _fill(text: str, values: dict) -> str:
    return PLACEHOLDER.sub(lambda m: values.get(m.group(1), m.group(0)), text)


def run_in_project(rid: str, project_id: str, values: dict | None = None, actor: str = OWNER, start: bool = True) -> dict:
    """One execution: a task in the project built from the recipe, started like any other task."""
    r = get(rid)
    values = values if isinstance(values, dict) else {}
    clean = {}
    for i in r["inputs"]:
        v = values.get(i["name"])
        clean[i["name"]] = projects._clean_text(v, i["name"], 500, required=True)
    steps = [_fill(s, clean) for s in r["steps"]]
    request = "Follow these steps:\n" + "\n".join(f"{n}. {s}" for n, s in enumerate(steps, 1))
    if r["outputs"]:
        request += "\nProduce: " + "; ".join(r["outputs"])
    t = work.create_task(project_id, {"title": f"{r['name']}" + (f": {next(iter(clean.values()))[:60]}" if clean else ""), "goal": r["description"], "request": request,
                                      "acceptance": [_fill(a, clean) for a in r["acceptance"]], "recipeId": rid}, actor)
    attempt = work.start_task(project_id, t["id"], actor) if start else None
    return {"task": work.get_task(project_id, t["id"], actor), "attempt": attempt}


# --- routines ---


def add_routine(rid: str, project_id: str, daily_at: str, values: dict | None = None, actor: str = OWNER) -> dict:
    projects.require(project_id, "write", actor)
    get(rid)
    if not isinstance(daily_at, str) or not re.fullmatch(r"([01]\d|2[0-3]):[0-5]\d", daily_at):
        raise ProjectError(400, "invalid_request", "daily_at is a time like 08:30.")
    rtid = str(uuid.uuid4())
    store.x("INSERT INTO recipe_routines (id, recipe_id, project_id, daily_at, inputs, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            rtid, rid, project_id, daily_at, json.dumps(values or {}), _now())
    projects.record(project_id, "routine_added", f"Daily routine at {daily_at}: {get(rid)['name']}", {"routineId": rtid}, actor=actor)
    return store.q1("SELECT * FROM recipe_routines WHERE id = ?", rtid)


def routines(project_id: str | None = None) -> list[dict]:
    return store.q("SELECT rt.*, r.name AS recipe_name FROM recipe_routines rt JOIN recipes r ON r.id = rt.recipe_id WHERE (? IS NULL OR rt.project_id = ?) ORDER BY daily_at",
                   project_id, project_id)


def set_routine(project_id: str, rtid: str, enabled: bool | None = None, delete: bool = False, actor: str = OWNER) -> bool:
    projects.require(project_id, "write", actor)
    if delete:
        return bool(store.x("DELETE FROM recipe_routines WHERE id = ? AND project_id = ?", rtid, project_id))
    return bool(store.x("UPDATE recipe_routines SET enabled = ? WHERE id = ? AND project_id = ?", int(bool(enabled)), rtid, project_id))


def due(now: dt.datetime | None = None) -> list[dict]:
    now = now or dt.datetime.now()
    today, hm = now.date().isoformat(), now.strftime("%H:%M")
    return [r for r in routines() if r["enabled"] and r["daily_at"] <= hm and r["last_run_date"] != today]


def run_due(now: dt.datetime | None = None) -> list[str]:
    """Starts every routine that's due today and hasn't run yet. Archived projects are skipped."""
    started = []
    today = (now or dt.datetime.now()).date().isoformat()
    for r in due(now):
        if not store.x("UPDATE recipe_routines SET last_run_date = ? WHERE id = ? AND (last_run_date IS NULL OR last_run_date != ?)", today, r["id"], today):
            continue  # another loop took it
        try:
            out = run_in_project(r["recipe_id"], r["project_id"], json.loads(r["inputs"]))
            started.append(out["task"]["id"])
        except ProjectError as e:
            try:
                projects.record(r["project_id"], "routine_failed", f"Routine {r['recipe_name']} didn't start: {e.message}", {"routineId": r["id"]}, actor="OmniPilot", actor_type="system")
            except Exception:  # noqa: BLE001 -- the project may be gone
                pass
    return started


def start_scheduler() -> None:
    """Checks routines once a minute (off with OMNIPILOT_SCHEDULER=off, as in tests)."""
    global _loop
    if os.environ.get("OMNIPILOT_SCHEDULER") == "off" or (_loop and not _loop.done()):
        return

    async def loop():
        while True:
            try:
                run_due()
            except Exception:  # noqa: BLE001 -- the scheduler keeps going
                pass
            await asyncio.sleep(60)

    _loop = asyncio.ensure_future(loop())
