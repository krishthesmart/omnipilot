"""Project routes (docs/product): projects, their conversations, files, runs, activity, search, export, duplication,
cross-project copying and the Home summary. Every route checks the caller is OmniPilot's owner (SDK tokens get
no project access) and goes through projects.require() for the project itself."""
from __future__ import annotations

import asyncio
import json
from urllib.parse import quote

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response

from . import projects
from .api_stage2 import body, err


def _fail(e: projects.ProjectError) -> JSONResponse:
    return err(e.status, e.code, e.message)


def register(app: FastAPI, allowed, denied) -> None:
    def route(method: str, path: str):
        """A project route: owner check first, ProjectError -> its HTTP status."""
        def wrap(fn):
            async def handler(request: Request, **kw):
                if not await allowed(request):
                    return denied()
                try:
                    return await fn(request, **kw)
                except projects.ProjectError as e:
                    return _fail(e)

            handler.__name__ = fn.__name__
            import inspect

            params = [p for p in inspect.signature(fn).parameters.values() if p.name != "request"]
            handler.__signature__ = inspect.Signature([inspect.Parameter("request", inspect.Parameter.POSITIONAL_OR_KEYWORD, annotation=Request), *params])
            app.add_api_route(path, handler, methods=[method])
            return fn

        return wrap

    async def json_body(request: Request) -> dict:
        b = await body(request)
        if b is None:
            raise projects.ProjectError(400, "invalid_request", "Send a JSON object.")
        return b

    register_dna(app, route, json_body)
    from . import api_work, recipes, work

    api_work.register(app, route, json_body)

    async def on_start() -> None:  # recovery first, then the routine scheduler (off in tests)
        work.reconcile_on_start()
        recipes.start_scheduler()

    app.router.add_event_handler("startup", on_start)

    @route("GET", "/api/home")
    async def home(request: Request):
        return projects.home()

    @route("GET", "/api/projects")
    async def list_projects(request: Request, status: str = "active"):
        if status not in ("active", "archived", "all"):
            return err(400, "invalid_request", "status must be active, archived or all")
        return {"projects": projects.list_projects(status=None if status == "all" else status)}

    @route("POST", "/api/projects")
    async def create(request: Request):
        return JSONResponse(projects.create(await json_body(request)), status_code=201)

    @route("GET", "/api/projects/{project_id}")
    async def get(request: Request, project_id: str):
        return projects.get(project_id)

    @route("PATCH", "/api/projects/{project_id}")
    async def update(request: Request, project_id: str):
        return projects.update(project_id, await json_body(request))

    @route("POST", "/api/projects/{project_id}/archive")
    async def archive(request: Request, project_id: str):
        return projects.set_archived(project_id, True)

    @route("POST", "/api/projects/{project_id}/restore")
    async def restore(request: Request, project_id: str):
        return projects.set_archived(project_id, False)

    @route("GET", "/api/projects/{project_id}/delete-preview")
    async def delete_preview(request: Request, project_id: str):
        return projects.delete_preview(project_id)

    @route("DELETE", "/api/projects/{project_id}")
    async def delete(request: Request, project_id: str):
        return projects.delete(project_id, str((await json_body(request)).get("confirm", "")))

    @route("GET", "/api/projects/{project_id}/export")
    async def export(request: Request, project_id: str):
        data = projects.export(project_id)
        name = quote(f"{data['project']['name'][:60]}.omnipilot.json")
        return Response(json.dumps(data, ensure_ascii=False, indent=2), media_type="application/json",
                        headers={"content-disposition": f"attachment; filename*=UTF-8''{name}", "cache-control": "no-store"})

    @route("GET", "/api/projects/{project_id}/duplicate-preview")
    async def duplicate_preview(request: Request, project_id: str, files: bool = True):
        return projects.duplicate_preview(project_id, files)

    @route("POST", "/api/projects/{project_id}/duplicate")
    async def duplicate(request: Request, project_id: str):
        b = await json_body(request)
        return JSONResponse(projects.duplicate(project_id, b.get("includeFiles", True) is not False), status_code=201)

    @route("GET", "/api/projects/{project_id}/search")
    async def search(request: Request, project_id: str, q: str = ""):
        return {"results": projects.search(project_id, q)}

    @route("GET", "/api/projects/{project_id}/activity")
    async def activity(request: Request, project_id: str):
        projects.require(project_id)
        return {"activity": projects.events(project_id, 100)}

    @route("GET", "/api/projects/{project_id}/runs")
    async def runs(request: Request, project_id: str):
        return {"runs": projects.runs(project_id)}

    # --- conversations ---

    @route("GET", "/api/projects/{project_id}/conversations")
    async def conversations(request: Request, project_id: str):
        return {"conversations": projects.conversations(project_id)}

    @route("POST", "/api/projects/{project_id}/conversations")
    async def create_conversation(request: Request, project_id: str):
        return JSONResponse(projects.create_conversation(project_id, (await json_body(request)).get("title")), status_code=201)

    @route("GET", "/api/projects/{project_id}/conversations/{conversation_id}")
    async def conversation(request: Request, project_id: str, conversation_id: str):
        return projects.conversation(project_id, conversation_id)

    @route("PATCH", "/api/projects/{project_id}/conversations/{conversation_id}")
    async def rename_conversation(request: Request, project_id: str, conversation_id: str):
        return projects.rename_conversation(project_id, conversation_id, (await json_body(request)).get("title", ""))

    @route("POST", "/api/projects/{project_id}/conversations/{conversation_id}/messages")
    async def send(request: Request, project_id: str, conversation_id: str):
        """A message in a project conversation: the run belongs to the project and its agents see only its files."""
        message = (await json_body(request)).get("message")
        if not isinstance(message, str) or not 1 <= len(message.strip()) <= 4000:
            return err(400, "invalid_request", "message must be 1 to 4000 characters")
        run_id = start_project_run(project_id, conversation_id, message.strip())
        return JSONResponse({"runId": run_id}, status_code=202)

    # --- files ---

    @route("GET", "/api/projects/{project_id}/files")
    async def files(request: Request, project_id: str):
        return {"files": projects.files(project_id)}

    @route("POST", "/api/projects/{project_id}/files")
    async def upload(request: Request, project_id: str, name: str = "", replace: bool = False):
        return JSONResponse(projects.add_file(project_id, name, await request.body(), replace=replace), status_code=201)

    @route("GET", "/api/projects/{project_id}/files/{file_id}")
    async def download(request: Request, project_id: str, file_id: str):
        f = projects.get_file(project_id, file_id)
        data = projects.read_file(project_id, file_id)
        # Always a download, never rendered in OmniPilot's own pages (an uploaded HTML file can't run as OmniPilot).
        return Response(data, media_type="application/octet-stream",
                        headers={"content-disposition": f"attachment; filename*=UTF-8''{quote(f['name'].split('/')[-1])}", "x-content-type-options": "nosniff", "cache-control": "no-store"})

    @route("DELETE", "/api/projects/{project_id}/files/{file_id}")
    async def delete_file(request: Request, project_id: str, file_id: str):
        return projects.delete_file(project_id, file_id)

    @route("GET", "/api/projects/{project_id}/files/{file_id}/copy-preview")
    async def copy_preview(request: Request, project_id: str, file_id: str, to: str = ""):
        return projects.copy_file_preview(project_id, file_id, to)

    @route("POST", "/api/projects/{project_id}/files/{file_id}/copy")
    async def copy(request: Request, project_id: str, file_id: str):
        b = await json_body(request)
        return JSONResponse(projects.copy_file(project_id, file_id, str(b.get("to", "")), b.get("confirm") is True), status_code=201)


def register_dna(app: FastAPI, route, json_body) -> None:
    """Project DNA, the Assumption Inbox and personal preferences (slice 2). Requests from people are human actions."""
    from . import project_dna as dna

    @route("GET", "/api/projects/{project_id}/dna")
    async def get_dna(request: Request, project_id: str):
        return dna.dna(project_id)

    @route("POST", "/api/projects/{project_id}/facts")
    async def add_fact(request: Request, project_id: str):
        return JSONResponse(dna.add_fact(project_id, await json_body(request)), status_code=201)

    @route("PATCH", "/api/projects/{project_id}/facts/{fact_id}")
    async def edit_fact(request: Request, project_id: str, fact_id: str):
        return dna.edit_fact(project_id, fact_id, await json_body(request))

    @route("POST", "/api/projects/{project_id}/facts/{fact_id}/confirm")
    async def confirm_fact(request: Request, project_id: str, fact_id: str):
        return dna.confirm_fact(project_id, fact_id)

    @route("POST", "/api/projects/{project_id}/facts/{fact_id}/retire")
    async def retire_fact(request: Request, project_id: str, fact_id: str):
        return dna.retire_fact(project_id, fact_id, str((await json_body(request)).get("reason", "")))

    @route("POST", "/api/projects/{project_id}/facts/{fact_id}/supersede")
    async def supersede(request: Request, project_id: str, fact_id: str):
        return JSONResponse(dna.supersede_decision(project_id, fact_id, await json_body(request)), status_code=201)

    @route("GET", "/api/projects/{project_id}/facts/{fact_id}/history")
    async def fact_history(request: Request, project_id: str, fact_id: str):
        return {"history": dna.history(project_id, fact_id)}

    @route("GET", "/api/projects/{project_id}/assumptions")
    async def list_assumptions(request: Request, project_id: str, status: str = ""):
        return {"assumptions": dna.assumptions(project_id, status=status or None)}

    @route("POST", "/api/projects/{project_id}/assumptions")
    async def add_assumption(request: Request, project_id: str):
        return JSONResponse(dna.add_assumption(project_id, await json_body(request)), status_code=201)

    @route("POST", "/api/projects/{project_id}/assumptions/{assumption_id}/resolve")
    async def resolve(request: Request, project_id: str, assumption_id: str):
        b = await json_body(request)
        return dna.resolve_assumption(project_id, assumption_id, str(b.get("outcome", "")), str(b.get("correction") or ""), b.get("saveAs") or None)

    @route("GET", "/api/preferences")
    async def prefs(request: Request):
        return {"preferences": dna.preferences()}

    @route("PUT", "/api/preferences/{key}")
    async def set_pref(request: Request, key: str):
        return dna.set_preference(key, (await json_body(request)).get("value"))

    @route("DELETE", "/api/preferences/{key}")
    async def delete_pref(request: Request, key: str):
        return {"deleted": dna.delete_preference(key)}


def start_project_run(project_id: str, conversation_id: str, message: str) -> str:
    """Starts a run inside a project conversation (access checked); returns its id."""
    from .brain import pipeline

    projects.conversation_for_chat(project_id, conversation_id)
    scope = projects.run_scope(project_id)
    run_id, task = pipeline.start(message, {}, None, conversation_id, scope)
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)

    def after(_t) -> None:  # then: assumptions the answer relied on, for the Assumption Inbox (suggestions only)
        from . import project_dna

        follow = asyncio.ensure_future(project_dna.suggest_assumptions(project_id, run_id))
        _tasks.add(follow)
        follow.add_done_callback(_tasks.discard)

    task.add_done_callback(after)
    projects.record(project_id, "message_sent", f"Asked: {message[:120]}", {"conversation": conversation_id, "run": run_id})
    return run_id


_tasks: set = set()
