"""InfraPilot: integrations. Skills, custom agents, routines and the calendar; Gmail; Google Drive; GitHub and
Notion links; MCP servers; and, for connected Slack, GitHub and Notion, a concrete action shown with exactly
what will be sent, which runs only when approved. Nothing uses a service until the user connects it with its
own Connect button. (Ported from server/src/agents/infraPilot.ts and lib/integrationActions.ts.)"""
from __future__ import annotations

import json
import re

from ... import actions, llm, store
from .base import evidence, proposed_action
from .infra_apps import drive_skill, link_skill, mail_skill, mcp_skill
from .infra_skills import infra_skills

F = re.I | re.A
KNOWN = [("Slack", r"\bslack\b"), ("GitHub", r"\bgithub\b"), ("Notion", r"\bnotion\b"), ("Google Drive", r"\b(google drive|gdrive)\b"), ("Google Calendar", r"\b(google calendar|gcal)\b")]
WRITE_INTENT = re.compile(r"\b(create|set up|setup|schedule|automate|enable|connect|install|deploy|post|send|message|tell|open|file|add|append|write)\b", F)
CONNECT_ONLY = re.compile(r"^\W*(please\s+)?(connect|set ?up|link|add)\s+(my\s+)?(slack|github|notion|google drive|gdrive)\W*$", F)
WRITES = {
    "Slack": {"kind": "slack_message", "intent": re.compile(r"\b(post|send|message|tell|announce|share|write)\b", F),
              "schema": {"type": "object", "properties": {"channel": {"type": "string"}, "text": {"type": "string"}}, "required": ["channel", "text"]},
              "system": "Extract the Slack message the user wants to post. `channel` is the channel name with # (e.g. #general) or a person's @handle. `text` is the exact message, written out if they described it."},
    "GitHub": {"kind": "github_issue", "intent": re.compile(r"\b(issue|bug report|ticket)\b", F),
               "schema": {"type": "object", "properties": {"repo": {"type": "string"}, "title": {"type": "string"}, "body": {"type": "string"}}, "required": ["repo", "title", "body"]},
               "system": "Extract the GitHub issue the user wants to open. `repo` is owner/name. Write a clear title and a helpful body (steps, expected vs actual) from what they said."},
    "Notion": {"kind": "notion_append", "intent": re.compile(r"\b(add|append|write|note|save|put)\b", F),
               "schema": {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]},
               "system": "Extract the text the user wants added to their Notion page, written out in full (keep their wording; separate paragraphs with blank lines)."},
}


def _quoted(text: str) -> str | None:
    m = re.search(r"[\"“'‘]([^\"”'’]{1,2000})[\"”'’]", text)
    return m.group(1).strip() if m else None


def slack_from_text(text: str) -> dict:
    ch = re.search(r"(#[\w-]{1,80})", text, re.A)
    msg = _quoted(text)
    if msg is None and (m := re.search(r"\b(?:saying|that says|message)\s*:?\s+(.+?)(?:\s+(?:to|in|on)\s+(?:#|slack)|$)", text, F)):
        msg = m.group(1).strip()
    return {"channel": ch.group(1) if ch else None, "text": msg}


def github_from_text(text: str) -> dict:
    repo = re.search(r"\b([\w.-]+\/[\w.-]+)\b", re.sub(r"https?:\/\/github\.com\/", "", text), re.A)
    title = re.search(r"\b(?:titled|called|named|title)\s*:?\s*[\"“']([^\"”']+)[\"”']", text, F)
    body = re.search(r"\b(?:saying|body|that says|description)\s*:?\s+(.+)$", text, F)
    return {"repo": repo.group(1) if repo else None, "title": title.group(1) if title else _quoted(text), "body": body.group(1).strip() if body else ""}


def notion_page_id(text: str) -> str | None:
    m = re.search(r"([0-9a-f]{32})(?:[?#\s]|$)", text.replace("-", ""), re.I)
    if not m:
        return None
    h = m.group(1)
    return f"{h[:8]}-{h[8:12]}-{h[12:16]}-{h[16:20]}-{h[20:]}"


def _stash(kind: str, params: dict, description: str, risk: str, preview: str) -> dict:
    action = proposed_action(description, risk, preview=preview)
    actions.save_action(action["id"], kind, params)
    return action


async def write_action(service: str, input: dict) -> dict:
    w = WRITES[service]
    text = input["requestText"]
    ai = await llm.generate_json(w["system"], text, schema=w["schema"], temperature=0.2, max_tokens=800) if await llm.available() else None
    ai = ai if isinstance(ai, dict) else {}
    if service == "Slack":
        rx = slack_from_text(text)
        channel = rx["channel"] or ai.get("channel")
        message = ai.get("text") or rx["text"]
        if not channel or not re.match(r"^[#@]?[\w.-]+$", channel, re.A):
            return {"missing": "Which Slack channel should it go to? (for example #general)"}
        if not message:
            return {"missing": "What should the message say? Put it in quotes."}
        ch = channel if channel[0] in "#@" else f"#{channel}"
        return {"action": _stash(w["kind"], {"channel": ch, "text": message}, f"Post to {ch} in Slack", "medium", f"Channel: {ch}\n\n{message}")}
    if service == "GitHub":
        rx = github_from_text(text)
        repo = rx["repo"] or ai.get("repo")
        title = ai.get("title") or rx["title"]
        if not repo or not re.match(r"^[\w.-]+\/[\w.-]+$", repo, re.A):
            return {"missing": "Which repository? Give it as owner/name (for example octocat/hello-world)."}
        if not title:
            return {"missing": "What should the issue be titled?"}
        params = {"repo": repo, "title": title, "body": ai.get("body") or rx["body"] or ""}
        return {"action": _stash(w["kind"], params, f'Open a GitHub issue in {repo}: "{title}"', "medium", f"Repository: {repo}\nTitle: {title}\n\n{params['body']}")}
    page_id = notion_page_id(text)
    content = ai.get("text") or ((m.group(1)) if (m := re.search(r"[\"“]([^\"”]+)[\"”]", text)) else None)
    if not page_id:
        return {"missing": "Which Notion page? Paste its link (and share the page with your OmniPilot integration in Notion)."}
    if not content:
        return {"missing": "What should I add to the page? Put it in quotes."}
    return {"action": _stash(w["kind"], {"pageId": page_id, "text": content}, "Add text to your Notion page", "medium", content)}


def _connector_json(name: str, connected: bool, record: dict | None) -> str:
    return json.dumps({"name": name, "status": "connected" if connected else "not_connected", "kind": (record or {}).get("kind"), "verification": (record or {}).get("verification"),
                       "accountLabel": (record or {}).get("account_label")}, separators=(",", ":"), ensure_ascii=False)


async def run(input: dict, ctx: dict) -> dict:
    for skill in (infra_skills, mail_skill, drive_skill, link_skill, mcp_skill):
        out = await skill(input)
        if out:
            return out
    text, run_id = input["requestText"], input["runId"]
    connectors = store.list_connectors()
    store.audit(run_id, "InfraPilot", "list_connectors", {}, f"found {len(connectors)}")
    mentioned = [name for name, p in KNOWN if re.search(p, text, F)]
    wants_write = bool(WRITE_INTENT.search(text))
    mentions_workflow = bool(re.search(r"\bworkflow|schedule|skill|custom agent\b", text, F))
    if mentioned:
        findings, ev, acts, any_missing = [], [], [], False
        for name in mentioned:
            record = next((c for c in connectors if c["name"] == name), None)
            connected = bool(record and record["status"] == "connected")
            any_missing = any_missing or not connected
            findings.append(f"{name} is connected{' as ' + record['account_label'] if record and record.get('account_label') else ''} and approved for use." if connected
                            else f"{name} is not connected yet. Use the **Connect** button on its card above{' and paste an access token for your account' if record and record.get('verification') == 'token' else ''}; nothing can use {name} until you do.")
            ev.append(evidence(f"connector:{name}", _connector_json(name, connected, record)))
            if connected and wants_write and name in WRITES and WRITES[name]["intent"].search(text) and not CONNECT_ONLY.search(text):
                r = await write_action(name, input)
                if r.get("action"):
                    acts.append(r["action"])
                    findings.append(f"Ready: approve it below and it's done (it uses your connected {name} account).")
                elif r.get("missing"):
                    findings.append(r["missing"])
            elif connected and wants_write and not CONNECT_ONLY.search(text):
                what = {"Slack": "post a message to a channel", "GitHub": "open an issue in a repository", "Notion": "add text to a page"}.get(name, "read it")
                findings.append(f"What should I do in {name}? I can {what}.")
        store.audit(run_id, "InfraPilot", "check_connector_status", {"requested": mentioned}, "needs_connection" if any_missing else "ok")
        return {"status": "needs_connection" if any_missing else "needs_approval" if acts else "success", "findings": findings, "evidence": ev, "confidence": 0.9,
                "limitations": ["Nothing can use a service until you connect it yourself with the Connect button on its card."] if any_missing else ["Nothing is sent until you approve it."] if acts else [],
                "proposedActions": acts}
    if mentions_workflow:
        n_connected = sum(1 for c in connectors if c["status"] == "connected")
        store.audit(run_id, "InfraPilot", "list_connectors", {"connected": n_connected}, "summary")
        return {"status": "success", "findings": [f"{n_connected} of {len(connectors)} known integrations are currently connected.", "No specific integration was named in the request, so no connector-specific action was taken.",
                                                  "Custom AI agents, skills, and schedules can only be created against a connected integration or purely-internal (no external call) workflow."],
                "evidence": [evidence(f"connector:{c['name']}", json.dumps(c, separators=(",", ":"), ensure_ascii=False)) for c in connectors], "confidence": 0.6,
                "limitations": ["This is a status summary, not a created workflow — ask for a specific integration to proceed."], "proposedActions": []}
    return {"status": "success", "findings": ["No integration, MCP server, schedule, or workflow action was identified as needed for this request."], "evidence": [], "confidence": 0.5,
            "limitations": ["InfraPilot only acts when the request references an integration, workflow, schedule, custom agent, or MCP server."], "proposedActions": []}
