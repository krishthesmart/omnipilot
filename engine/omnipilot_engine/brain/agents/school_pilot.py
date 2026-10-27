"""SchoolPilot: keeps track of homework, projects and tests (due dates worked out exactly), breaks big
assignments into steps scheduled before they're due, plans spaced study sessions before a test, and helps
with essays and homework by guiding the student rather than doing the work. Same academic-integrity and
safety rules as LearnPilot. (Ported from server/src/agents/schoolPilot.ts.)"""
from __future__ import annotations

import re

from ... import llm, store
from .. import school
from .base import evidence, model_limitation, previous_turn_text
from .learn_pilot import check_safety

F = re.I | re.A
LIST_INTENT = re.compile(r"\b(what|which|show|list|any)\b[^.?!]*\b(homework|assignments?|due|tests?|exams?|projects?|essays?|tasks?)\b|\bwhat'?s due\b|\bmy (homework|assignments|schedule|to-?do)\b|\b(homework|assignment) list\b", F)
DONE_INTENT = re.compile(r"\b(i('ve| have)? )?(done|finished|completed|turned in|submitted|handed in)\b|\bmark\b[^.?!]*\bdone\b", F)
DELETE_INTENT = re.compile(r"\b(delete|remove|cancel|drop|forget)\b[^.?!]*\b(homework|assignment|project|test|exam|essay|task|it)\b", F)
ADD_NOUN = re.compile(r"\b(homework|assignment|worksheet|project|science fair|report|presentation|poster|essay|paper|test|exam|quiz|midterm|final|lab)\b", F)
SUBJECTS = ["math", "science", "biology", "chemistry", "physics", "history", "english", "reading", "writing", "spanish", "french", "geography", "art", "music", "computer science", "coding", "social studies", "economics"]


def kind_of(text: str) -> str:
    if re.search(r"\b(test|exam|quiz|midterm|final)\b", text, F):
        return "test"
    if re.search(r"\b(essay|paper|book report|report)\b", text, F):
        return "essay"
    if re.search(r"\b(project|science fair|presentation|poster|lab)\b", text, F):
        return "project"
    return "homework"


def subject_of(text: str) -> str | None:
    return next((s for s in SUBJECTS if re.search(rf"\b{s}\b", text, F)), None)


def title_of(text: str) -> str:
    t = re.sub(r"\b(i have|i've got|i got|there'?s|add|remind me about|please|can you|help me( plan)?|plan|a|an|my)\b", " ", text, flags=F)
    t = re.sub(r"\b(due|on|by|for|this|next|in)\b\s*(today|tonight|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d.*|week.*|[a-z]{3,9}\.? \d{1,2}.*)$", "", t, count=1, flags=F)
    t = re.sub(r"\b(due|it'?s due).*$", "", t, count=1, flags=F)
    t = re.sub(r"[.?!,]+$", "", re.sub(r"\s+", " ", t).strip())
    title = t or "Assignment"
    return (title[0].upper() + title[1:])[:80]


STEPS_SYSTEM = ("Break a student's assignment into 3 to 6 concrete steps, in order, that a student can each finish in one sitting (for example: choose a topic, research, outline, first draft, revise, final copy). "
                "Make them specific to the assignment. Each step is one short sentence starting with a verb.")
STEPS_SCHEMA = {"type": "object", "properties": {"steps": {"type": "array", "items": {"type": "string"}, "minItems": 3, "maxItems": 6}}, "required": ["steps"]}
TOPICS_SYSTEM = "A student has a test coming up. List the study sessions to prepare, one short topic or activity per session, from learning the material to practice tests. Make them specific to the subject if one is given."
HELP_SYSTEM = ("You are Helper, a friendly study coach for students. Help with the school task in the request: explain clearly, step by step, at the student's level. "
               "For homework, guide them to the answer (explain the method, work a similar example, then let them try) rather than only giving answers. "
               "For essays, help with choosing a thesis, an outline, evidence and feedback on their own writing; if asked to write a whole essay for school, give a strong outline and an example opening paragraph, and offer to help them write the rest. "
               "Keep it encouraging and concise, with headings or short lists where useful.")
FALLBACK_STEPS = {"project": ["Pick your topic and check it with your teacher", "Research and take notes", "Plan what you'll make or show", "Build or write the main part", "Finish, check it against the instructions, and practise presenting"],
                  "essay": ["Choose a topic and write a one-sentence thesis", "Find evidence and take notes", "Write an outline", "Write the first draft", "Revise, proofread and write the final copy"],
                  "homework": ["Do the homework"], "test": []}


def list_text(tasks: list[dict]) -> str:
    if not tasks:
        return "Nothing on your list right now. Tell me about homework, a project or a test and when it's due, and I'll keep track of it."
    lines = []
    for t in tasks:
        nxt = next((s for s in t["steps"] if school.from_iso(s["date"]) >= school.today()), None)
        line = f"- **{t['title']}** — due {school.when_text(t['due'])}"
        if nxt:
            line += f"\n  Next step ({re.sub(r' \(.+\)$', '', school.when_text(nxt['date']))}): {nxt['text']}"
        lines.append(line)
    return "**Your school list**\n" + "\n".join(lines)


def plan_text(task: dict) -> str:
    if not task["steps"]:
        return f"Added **{task['title']}**, due {school.when_text(task['due'])}."
    heading = "Study plan" if task["kind"] == "test" else "Plan"
    steps = "\n".join(f"- {school.label(school.from_iso(s['date']))}: {s['text']}" for s in task["steps"])
    return f"Added **{task['title']}**, due {school.when_text(task['due'])}.\n\n**{heading}**\n{steps}\n\nAsk \"what's due?\" any time, or tell me when you finish it."


def _added(task: dict, due: str, used_model: bool) -> dict:
    return {"status": "success", "findings": [plan_text(task)], "evidence": [evidence("school-list", f"{task['title']} due {due}")], "confidence": 0.9,
            "limitations": [model_limitation()] if used_model else [], "proposedActions": []}


async def run(input: dict, ctx: dict) -> dict:
    text, run_id, context = input["requestText"], input["runId"], input.get("context") or {}
    original = context.get("originalRequest") if isinstance(context.get("originalRequest"), str) else ""
    gate = check_safety(f"{original}\n{text}" if original else text)
    if gate["blocked"]:
        store.audit(run_id, "Helper", "safety_gate", {"requestExcerpt": text[:120]}, "blocked")
        return {"status": "failed_safe", "findings": [f"Request blocked by Helper's safety policy for schoolwork: {gate['reason']}"], "evidence": [], "confidence": 1,
                "limitations": ["Helper helps students learn and plan, but won't complete graded work for them to hand in."], "proposedActions": []}
    due = school.parse_due_date(text)
    if LIST_INTENT.search(text) and not due:
        tasks = school.list_tasks()
        store.audit(run_id, "Helper", "list_tasks", {"open": len(tasks)}, "completed")
        return {"status": "success", "findings": [list_text(tasks)], "evidence": [evidence("school-list", f"{len(tasks)} open item(s)")], "confidence": 0.95, "limitations": [], "proposedActions": []}
    deleting = bool(DELETE_INTENT.search(text))
    if (DONE_INTENT.search(text) or deleting) and not due:
        task = school.find_task(text)
        if task:
            (school.delete_task if deleting else school.set_done)(task["id"])
            store.audit(run_id, "Helper", "delete_task" if deleting else "complete_task", {"id": task["id"]}, "completed")
            left = school.list_tasks()
            return {"status": "success", "findings": [f"{'Removed' if deleting else 'Nice work! Marked done:'} **{task['title']}**." + (f"\n\n{list_text(left)}" if left else "\n\nThat's everything on your list.")],
                    "evidence": [evidence("school-list", f"{len(left)} open item(s)")], "confidence": 0.9, "limitations": [], "proposedActions": []}
    if due and ADD_NOUN.search(text):
        kind, subject, title = kind_of(text), subject_of(text), title_of(text)
        if kind == "test":
            days = school.study_days(due)
            plan = await llm.generate_json(TOPICS_SYSTEM, f"Test: {title}{f' (subject: {subject})' if subject else ''}. Sessions: {len(days)}.",
                                           schema={"type": "object", "properties": {"sessions": {"type": "array", "items": {"type": "string"}, "minItems": len(days), "maxItems": len(days)}}, "required": ["sessions"]},
                                           temperature=0.3, max_tokens=300)
            sessions = [str(s) for s in plan["sessions"]][:len(days)] if isinstance(plan, dict) and isinstance(plan.get("sessions"), list) else []
            used = len(sessions) == len(days)
            fallback = ["Quick review of everything and an early night" if i == len(days) - 1 else "Read through your notes and list what you don't understand yet" if i == 0 else "Practise questions on the weakest topic" for i in range(len(days))]
            task = school.add_task(title, subject, kind, due, [{"date": d, "text": (sessions if used else fallback)[i]} for i, d in enumerate(days)])
            store.audit(run_id, "Helper", "add_task", {"kind": kind, "due": due, "sessions": len(days), "model": (llm.last_answer.get() or {}).get("model") if used else None}, "completed")
            return _added(task, due, used)
        steps, used = [], False
        if kind in ("project", "essay"):
            planned = await llm.generate_json(STEPS_SYSTEM, f"{text}{previous_turn_text(input)}", schema=STEPS_SCHEMA, temperature=0.3, max_tokens=300)
            steps = [str(s) for s in planned["steps"] if s][:6] if isinstance(planned, dict) and isinstance(planned.get("steps"), list) else []
            used = len(steps) >= 3
            if not used:
                steps = FALLBACK_STEPS[kind]
        task = school.add_task(title, subject, kind, due, school.schedule_steps(steps, due))
        store.audit(run_id, "Helper", "add_task", {"kind": kind, "due": due, "steps": len(steps), "model": (llm.last_answer.get() or {}).get("model") if used else None}, "completed")
        return _added(task, due, used)
    help = await llm.generate_text(HELP_SYSTEM, f"{previous_turn_text(input)}{text}", max_tokens=900, temperature=0.4)
    a = llm.last_answer.get() or {}
    store.audit(run_id, "Helper", "school_help", {"model": a.get("model") if help else None}, "completed" if help else "model_unavailable")
    if not help:
        return {"status": "partial_success", "findings": ["I can keep track of homework, projects and tests (tell me what's due and when), but explaining needs the AI model, which isn't answering right now."],
                "evidence": [], "confidence": 0.3, "limitations": ["The AI model (Groq) didn't respond."], "proposedActions": []}
    return {"status": "success", "findings": [help], "evidence": [evidence(f"ai-model:{a.get('model')}", "School help")], "confidence": 0.7, "limitations": [model_limitation()], "proposedActions": []}
