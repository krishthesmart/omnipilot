"""WatcherPilot in chat: turns "learn math and no AI for 1 hour" into a focus session for the parent to
confirm, answers "is YouTube blocked?", and reports status. It never applies or lifts rules itself (a child
could type the same message): changes go through the Watcher panel behind the parent's PIN.
(Ported from server/src/agents/watcherPilot.ts.)"""
from __future__ import annotations

import asyncio
import json
import re
from datetime import datetime
from urllib.parse import urlsplit

from ... import store
from .. import watcher
from .base import evidence
from .jsfmt import JS_NOT_S

F = re.I | re.A
URL_OR_SITE = re.compile(rf"\b((?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{{2,}}(?:\/{JS_NOT_S}*)?)", F)
SITE_NAMES = {"youtube": "https://youtube.com", "chatgpt": "https://chatgpt.com", "gemini": "https://gemini.google.com", "claude": "https://claude.ai", "khan academy": "https://khanacademy.org",
              "roblox": "https://roblox.com", "tiktok": "https://tiktok.com", "desmos": "https://desmos.com", "photomath": "https://photomath.com", "wikipedia": "https://wikipedia.org"}
SETUP_INTENT = re.compile(r"\b(learn|study|practice|focus|homework time|no ai|block (all )?ai|only (allow|let)|screen time|stay on task|parental|goguardian)\b", F)
LIFT_INTENT = re.compile(r"\b(turn off|disable|stop|unblock|remove|pause|end)\b.*\b(block|watcher|focus|filter|restriction)", F)
CHECK_INTENT = re.compile(r"\b(is|are|can|will|would)\b.*\b(allowed|blocked|open|use|visit|go on)\b|\ballowed\b|\bblocked\b", F)


def _ends(until: str | None) -> str:
    if not until:
        return "when a parent turns it off"
    t = datetime.fromisoformat(until.replace("Z", "+00:00")).astimezone()
    return t.strftime("%I:%M %p").lstrip("0")


def describe(policy: dict) -> list[str]:
    p = {**watcher.DEFAULT_POLICY, **policy}
    return [f"**Task:** {p['task'] or '(not set)'}{' (subject: ' + p['subject'] + ')' if p['subject'] else ''}",
            f"**AI tools & answer solvers:** {'blocked (ChatGPT, Gemini, Claude, Copilot, Photomath, Mathway, Brainly…)' if p['blockAI'] else 'allowed'}",
            f"**AI browser extensions:** {'switched off during the session' if p['blockAIExtensions'] else 'left alone'}",
            f"**Other sites:** {'only pages that fit the task (' + (p['subject'] or 'task') + ' sites, and pages whose content is about it)' if p['onTaskOnly'] else 'allowed'}",
            f"**Ends:** {_ends(p['until'])}"]


def _host(url: str) -> str:
    return re.sub(r"^www\.", "", urlsplit(url).hostname or "")


async def run(input: dict, ctx: dict) -> dict:
    text, run_id = input["requestText"], input["runId"]
    current = watcher.get_policy()
    if LIFT_INTENT.search(text):
        store.audit(run_id, "InfraPilot", "lift_request", {}, "pin_required")
        return {"status": "success", "findings": ["Only a parent can change or stop a focus session: use the button below and enter the parent PIN.",
                                                  f"A session is running: \"{current['task']}\"." if current["active"] else "No focus session is running right now."],
                "evidence": [], "confidence": 0.9, "limitations": ["Changes always require the parent PIN, so a child can't lift the rules from chat."], "proposedActions": [],
                "attachments": [{"type": "watcher-manage", "task": (current["task"] or None) if current["active"] else None}]}
    sites = [m.group(1) if m.group(1).startswith("http") else f"https://{m.group(1)}" for m in URL_OR_SITE.finditer(text)]
    sites += [url for name, url in SITE_NAMES.items() if re.search(rf"\b{name}\b", text, F)]
    if CHECK_INTENT.search(text) and sites and not SETUP_INTENT.search(text):
        checks = [(u, await watcher.classify_page(current, u)) for u in sites[:5]]
        store.audit(run_id, "InfraPilot", "check_sites", {"sites": len(sites)}, "completed")
        return {"status": "success", "findings": [f"Current session: \"{current['task']}\"." if current["active"] else "No focus session is running, so nothing is blocked right now.",
                                                  *[f"- **{_host(u)}**: {'🚫 blocked' if d['decision'] == 'block' else '✅ allowed'} ({d['reason']})" for u, d in checks]],
                "evidence": [evidence(f"watcher:{d['category']}", f"{u} -> {d['decision']}") for u, d in checks], "confidence": 0.85,
                "limitations": ["Pages not on a known list are judged by their title when opened, so the result for a specific page can differ."], "proposedActions": []}
    if SETUP_INTENT.search(text):
        proposed = {**watcher.DEFAULT_POLICY, **watcher.parse_focus_request(text), "active": True}
        examples = ["https://chatgpt.com", "https://photomath.com", "https://youtube.com/watch?v=gaming", "https://roblox.com", "https://khanacademy.org/math"]
        verdicts = await asyncio.gather(*[watcher.classify_page(proposed, u, "Minecraft let's play" if "gaming" in u else "") for u in examples])
        blocked = [urlsplit(u).hostname for u, d in zip(examples, verdicts) if d["decision"] == "block"]
        store.audit(run_id, "InfraPilot", "propose_session", {"task": proposed["task"], "subject": proposed["subject"], "until": proposed["until"]}, "awaiting_parent_pin")
        findings = ["Here's the focus session I'll set up. **A parent needs to confirm it with their PIN** (button below).", *describe(proposed),
                    f"For example, these would be blocked: {', '.join(blocked)}.", "" if watcher.has_pin() else "First time? You'll choose a 4–8 digit parent PIN when you confirm.",
                    "Blocking happens in the browser through the **OmniPilot Watcher** extension (see the Watcher panel for the one-time install)."]
        return {"status": "success", "findings": [f for f in findings if f],
                "evidence": [evidence("watcher-policy", json.dumps({"task": proposed["task"], "subject": proposed["subject"]}, separators=(",", ":"), ensure_ascii=False))], "confidence": 0.85,
                "limitations": ["Blocking covers browsers with the OmniPilot Watcher extension installed. To stop it being removed or bypassed with a private window, a parent can lock it with Chrome's managed policies (see the Watcher panel)."],
                "proposedActions": [], "attachments": [{"type": "watcher-setup", "policy": proposed, "blockedExamples": blocked}]}
    store.audit(run_id, "InfraPilot", "status", {"active": current["active"]}, "completed")
    return {"status": "success", "findings": ["A focus session is running:", *describe(current)] if current["active"] else ["No focus session is running. Tell me the task, e.g. \"learn math, no AI, for 1 hour\"."],
            "evidence": [], "confidence": 0.9, "limitations": [], "proposedActions": []}
