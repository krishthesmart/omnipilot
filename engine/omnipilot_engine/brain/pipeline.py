"""One run, start to finish: follow-up rewriting, skills and custom agents, lessons, governance, routing,
coordination, synthesis (streamed), review, approvals, and the final answer, with every step on the live
event stream and saved to the database. (Same flow as server/src/pipeline.ts.)"""
from __future__ import annotations

import asyncio
import re
import uuid

from .. import llm, store
from ..tools import router as tool_router
from . import control, conversation, coordinator, governance, learning, orchestrator, routing, synthesis
from .events import bus

INVOKE = [re.compile(r"^\s*\/([a-z0-9_-]{2,40})\b\s*([\s\S]*)$", re.I), re.compile(r"^\s*(?:run|start|use)\s+(?:my\s+)?(?:skill\s+)?([a-z0-9_-]{2,40})\b\s*([\s\S]*)$", re.I),
          re.compile(r"^\s*(?:ask|tell)\s+([a-z0-9_-]{2,40})\b[,:]?\s*([\s\S]*)$", re.I)]
SCHEDULE_WORDS = re.compile(r"\b(every ?day|daily|each day|every (morning|evening|night|week)|routine|stop running)\b", re.I)


def match_invocation(message: str) -> tuple[dict, str] | None:
    from ..api_stage2 import get_skill

    m = next((m for p in INVOKE if (m := p.match(message))), None)
    if not m or SCHEDULE_WORDS.search(m.group(2)):
        return None
    s = get_skill(m.group(1))
    return (s, m.group(2).strip()) if s else None


def skill_request(s: dict, extra: str) -> str:
    return f"{s['instructions']}\n\nAlso: {extra}" if extra else s["instructions"]


async def _ai_down() -> str | None:
    if tool_router.PROVIDERS["groq"].configured() or (await llm.local_status()).get("running"):
        return None
    return "No AI model is available: the model on this computer (Ollama) isn't running and there's no Groq key."


def start(message: str, context: dict | None = None, run_id: str | None = None, conversation_id: str | None = None, project: dict | None = None) -> tuple[str, asyncio.Task]:
    """Starts a run in the background; returns its id at once (so the app can attach to its stream).
    `project` (from projects.run_scope, checked by the caller) keeps the run and its agents inside one project."""
    run_id = run_id or str(uuid.uuid4())
    # Saved and announced before returning, so the app can open the run's stream right away.
    record = _begin(message, run_id, conversation_id, project)
    task = asyncio.ensure_future(execute_run(message, context or {}, run_id, conversation_id, record, project))
    return run_id, task


def _begin(message: str, run_id: str, conversation_id: str | None, project: dict | None = None) -> dict:
    record: dict = {"id": run_id, "request": message, "createdAt": store.now(), "status": "running"}
    if conversation_id:
        record["conversationId"] = conversation_id
    if project:
        record["projectId"] = project["id"]
    store.save_run(run_id, message, record["createdAt"], "running", record)
    if conversation_id:
        conversation.add_conversation_run(conversation_id, run_id, message)
    control.begin(run_id)
    bus.publish({"type": "run_started", "runId": run_id, "request": message})
    store.audit(run_id, "System", "run_started", {"request": message[:300], "engine": "python"}, "started")
    return record


async def execute_run(message: str, context: dict, run_id: str, conversation_id: str | None = None, record: dict | None = None, project: dict | None = None) -> dict:
    from .. import projects

    from ..tools import base as tool_base

    token = llm.current_run.set(run_id)
    scope = projects.current.set(project)
    limit = (project or {}).get("runBudgetUsd")
    spend = tool_base.run_spend.set(tool_base.RunSpend(float(limit)) if isinstance(limit, (int, float)) else None)
    # Meter the model calls of any run that isn't already being metered by a task attempt (which keeps its own
    # sink). This covers plain conversation runs, so their usage is recorded too, not just tasks'.
    own_usage = llm.usage_sink.get() is None
    usage: list = []
    usage_token = llm.usage_sink.set(usage) if own_usage else None
    # Collect the model's reasoning for this run (only steps that ask to reason — the final answer — emit any,
    # so routing and agents stay fast). It's kept on the run record, apart from the answer.
    reasoning: list = []
    reasoning_token = llm.reasoning_sink.set(reasoning)
    if project:
        context = {**context, "project": {k: project.get(k) for k in ("id", "name", "requirements", "constraints", "acceptance", "facts", "preferences")}}
    try:
        result = await _run(message, context, run_id, conversation_id, record or _begin(message, run_id, conversation_id, project))
        changed = False
        if own_usage:
            from .. import work

            result["usage"] = work.summarize_usage(usage)
            changed = True
        if reasoning:
            result["reasoning"] = reasoning
            changed = True
        if changed:
            store.save_run(run_id, message, result["createdAt"], result["status"], result)
        return result
    finally:
        llm.reasoning_sink.reset(reasoning_token)
        if usage_token is not None:
            llm.usage_sink.reset(usage_token)
        tool_base.run_spend.reset(spend)
        projects.current.reset(scope)
        llm.current_run.reset(token)


async def _run(message: str, context: dict, run_id: str, conversation_id: str | None, record: dict) -> dict:
    created_at = record["createdAt"]
    save = lambda: store.save_run(run_id, message, created_at, record["status"], record)
    request_text = message

    def remember(status: str, answer: str, question: str | None = None):
        if conversation_id:
            conversation.append_turn(conversation_id, {"request": message, "standalone": request_text, "answer": answer, "status": status, "clarifyingQuestion": question})

    try:
        turns = conversation.get_turns(conversation_id) if conversation_id else []
        invoked = match_invocation(message)
        if invoked:
            skill, extra = invoked
            store.audit(run_id, "System", "custom_agent" if skill["kind"] == "agent" else "run_skill", {"name": skill["name"]}, "started")
            if skill["kind"] == "agent":
                context = {**context, "customAgent": {"name": skill["label"], "instructions": skill["instructions"]}}
            request_text = skill_request(skill, extra) if skill["kind"] == "skill" else (extra or "Introduce yourself in one or two sentences and say what you can help with.")
        else:
            request_text = await conversation.resolve_follow_up(message, turns)
        if request_text != message:
            record["standaloneRequest"] = request_text
            bus.publish({"type": "followup_resolved", "runId": run_id, "original": message, "standalone": request_text})
            store.audit(run_id, "System", "resolve_followup", {"original": message, "standalone": request_text}, "rewritten")
        previous = conversation.previous_turn_context(turns)
        if previous:
            context = {**context, "previousTurn": previous, "conversationHistory": conversation.history_context(turns)}
        if conversation_id:
            context = {**context, "conversationId": conversation_id}

        if previous and learning.CORRECTION.search(message):
            async def learn():
                lesson = await learning.write_lesson(previous["request"], previous["answer"], message, "correction")
                if lesson:
                    store.audit(run_id, "System", "learn_lesson", {"id": lesson["id"], "source": "correction"}, lesson["lesson"])
            asyncio.ensure_future(learn())
        lessons = learning.use_lessons_for(run_id, request_text)
        if lessons:
            store.audit(run_id, "System", "use_lessons", {"ids": [l["id"] for l in lessons]}, f"{len(lessons)} lesson(s) from earlier feedback")

        gate = governance.check(request_text)
        if gate["hits"]:
            store.audit(run_id, "System", "governance_check", {"limits": [h.id for h in gate["hits"]], "whole": gate["whole"]}, "not possible" if gate["whole"] else "partly possible")
        if gate["whole"]:
            final = {"summary": governance.not_possible_text(gate), "sources": [], "limitations": [], "confidence": 0.95, "nextActions": [], "agentResults": [],
                     "governance": {"verdict": "not_possible", "reasons": [h.reason for h in gate["hits"]]}}
            record.update(finalResponse=final, status="completed")
            save()
            remember("completed", final["summary"])
            bus.publish({"type": "final_response", "runId": run_id, "response": final})
            return record

        control.throw_if_cancelled(run_id)
        if context.get("customAgent"):
            plan = {**routing.decide_agents(request_text), "selectedAgents": ["Helper"]}
        else:
            from . import decision

            plan = await decision.plan(request_text)  # the Router's decision model (today: the labelled baseline)
        abilities = plan.get("capabilities") or plan["selectedAgents"]
        if context.get("attachedFile") and "LearnPilot" in abilities and "Helper" in abilities:
            abilities = [a for a in abilities if a != "Helper"]  # the lessons skill teaches from the file itself
            plan = {**plan, "capabilities": abilities}
        record["plan"] = plan
        bus.publish({"type": "router_plan", "runId": run_id, "plan": plan})
        store.audit(run_id, "Router", "select_agents", {"selected": plan["selectedAgents"], "scores": plan["scores"], "routingMode": plan["routingMode"], "modelUsed": plan.get("modelUsed")},
                    f"planned via {plan['modelUsed']} (AI model)" if plan["routingMode"] == "model" else "planned via keyword heuristic")

        base = {"runId": run_id, "requestText": request_text, "context": context}
        steps = coordinator.plan_steps(request_text, abilities)  # planned per ability; shown per specialist
        shown = coordinator.shown_steps(steps)
        record["steps"] = shown
        bus.publish({"type": "coordinator_plan", "runId": run_id, "steps": shown})
        store.audit(run_id, "System", "coordinator_plan", {"steps": [{"agent": s["agent"], "dependsOn": s["dependsOn"], **({"skill": s["skill"]} if s.get("skill") else {})} for s in shown]}, "planned")
        results = await coordinator.coordinate(base, steps, orchestrator.run_agent_isolated)
        record["agentResults"] = results
        control.throw_if_cancelled(run_id)

        bus.publish({"type": "synthesizer_start", "runId": run_id})
        draft = synthesis.synthesize(run_id, request_text, plan, results)
        composed = await synthesis.compose_answer(run_id, request_text, results, lambda d: bus.publish({"type": "answer_delta", "runId": run_id, "delta": d}))
        control.throw_if_cancelled(run_id)
        if composed:
            draft["summary"] = composed
        record["draft"] = draft
        bus.publish({"type": "synthesizer_draft", "runId": run_id, "draft": draft})

        bus.publish({"type": "router_review_start", "runId": run_id})
        rev = synthesis.review(run_id, request_text, plan, results, draft)
        record["review"] = rev
        bus.publish({"type": "router_review", "runId": run_id, "review": rev})
        if not rev["approved"] and rev.get("clarifyingQuestion"):
            record["status"] = "needs_clarification"
            save()
            remember("needs_clarification", "", rev["clarifyingQuestion"])
            bus.publish({"type": "clarification_needed", "runId": run_id, "question": rev["clarifyingQuestion"]})
            return record

        pending = [(a, r["agent"]) for r in results for a in r["proposedActions"] if a.get("requiresApproval")]
        for a, agent in pending:
            store.create_approval(a["id"], run_id, agent, a["description"], a["riskLevel"])
        verdict = governance.judge(gate, results, await _ai_down() if any(governance.unusable(r) for r in results) else None)
        note = governance.verdict_note(verdict, gate)
        if note:
            store.audit(run_id, "System", "governance_verdict", {"verdict": verdict["verdict"], "reasons": len(verdict["reasons"])}, verdict["verdict"])
        summary = note if verdict["verdict"] == "not_possible" else (f"{note}\n\n{rev['finalSummary']}" if note else rev["finalSummary"])
        final = {"summary": summary, "governance": verdict, "sources": draft["sources"], "limitations": rev["finalLimitations"], "confidence": rev["finalConfidence"],
                 "nextActions": [a for r in results for a in r["proposedActions"]], "agentResults": results, "attachments": [x for r in results for x in r.get("attachments") or []]}
        record.update(finalResponse=final, status="needs_approval" if pending else "completed")
        save()
        remember(record["status"], summary)
        store.audit(run_id, "Router", "final_response", {"pendingApprovals": len(pending)}, "completed")
        bus.publish({"type": "final_response", "runId": run_id, "response": final})
        return record
    except control.RunCancelled:
        return _stopped(record, save, run_id)
    except Exception as err:  # noqa: BLE001 -- a run always ends with a terminal event
        if control.is_cancelled(run_id):
            return _stopped(record, save, run_id)
        record["status"] = "failed"
        save()
        store.audit(run_id, "System", "run_failed", {}, str(err)[:300] or type(err).__name__)
        bus.publish({"type": "run_failed", "runId": run_id, "error": str(err)[:300] or "unknown error"})
        return record
    finally:
        learning.end_lessons_for(run_id)
        control.end(run_id)


def _stopped(record, save, run_id):
    record["status"] = "cancelled"
    save()
    store.audit(run_id, "System", "run_cancelled", {}, "stopped by the user")
    bus.publish({"type": "run_cancelled", "runId": run_id})
    return record


def replay_events(run: dict) -> list[dict]:
    """The events a finished run would have sent, rebuilt from its saved record."""
    rid = run["id"]
    ev = [{"type": "run_started", "runId": rid, "request": run["request"]}]
    if run.get("standaloneRequest"):
        ev.append({"type": "followup_resolved", "runId": rid, "original": run["request"], "standalone": run["standaloneRequest"]})
    if run.get("plan"):
        ev.append({"type": "router_plan", "runId": rid, "plan": run["plan"]})
    if run.get("steps"):
        ev.append({"type": "coordinator_plan", "runId": rid, "steps": run["steps"]})
    for r in run.get("agentResults") or []:
        ev.append({"type": "agent_complete", "runId": rid, "result": r})
    if run.get("review"):
        ev.append({"type": "router_review", "runId": rid, "review": run["review"]})
    if run.get("finalResponse"):
        ev.append({"type": "final_response", "runId": rid, "response": run["finalResponse"]})
    elif run.get("status") == "needs_clarification" and (run.get("review") or {}).get("clarifyingQuestion"):
        ev.append({"type": "clarification_needed", "runId": rid, "question": run["review"]["clarifyingQuestion"]})
    elif run.get("status") == "cancelled":
        ev.append({"type": "run_cancelled", "runId": rid})
    elif run.get("status") == "failed":
        ev.append({"type": "run_failed", "runId": rid, "error": "This run failed."})
    else:
        ev.append({"type": "run_failed", "runId": rid, "error": "OmniPilot was restarted before this answer finished. Ask again."})
    return ev
