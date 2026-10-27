"""Governance: OmniPilot says plainly when something isn't possible instead of producing a weak or made-up
answer. Before any agent runs, the request is compared with what OmniPilot can never do; after they run,
an answer where nothing worked says so, with each reason. (Same rules as server/src/lib/governance.ts.)"""
from __future__ import annotations

import re
from dataclasses import dataclass

from .specs import rx


@dataclass
class Limit:
    id: str
    pattern: re.Pattern
    reason: str
    instead: str


LIMITS = [
    Limit("send_email", rx(r"\bsend\b[^.?!]*\b(e-?mail|gmail)\b|\b(e-?mail|gmail)\b[^.?!]*\bsend\b(?![^.?!]*\bdraft)"),
          "OmniPilot never sends email on your behalf (Gmail is connected read-only, by design).",
          "I can write the email and, when you approve, save it in your Gmail Drafts for you to send."),
    Limit("video", rx(r"\b(make|create|generate|render|produce|edit|film|record)\s+(me\s+)?(a|an|the|my|some|this)?\s*([\w-]+\s+)?(videos?|movies?|films?|mp4s?|video clips?|gifs?|tiktoks?|youtube videos?)\b"),
          "OmniPilot can't make videos: PicturePilot makes still pictures only.",
          "I can make a still illustration, an interactive 3D model you can rotate and take apart, or a storyboard of scenes."),
    Limit("purchase", rx(r"\b(buy|purchase)\s+(me\s+|us\s+)?(a|an|the|some|\d+|tickets?|one|two|three|four|five|six|seven|eight|nine|ten|a pair of|a couple of)\b|\border\s+(me\s+)?(a|an|some)\s+(pizza|food|meal|uber|taxi|ride|delivery)\b|\b(pay|transfer|send)\s+(\$\s?\d+|\d+\s*(dollars|usd)|money|my (bill|rent))\b|\b(book|reserve)\s+(me\s+)?(a\s+)?(flight|hotel|table|room|tickets?|ride)\b"),
          "OmniPilot can't buy, order, pay or book anything: it has no access to payments or shops, on purpose.",
          "I can compare options, find prices on the web, and write a checklist so you can do it yourself."),
    Limit("phone", rx(r"\b(make a (phone )?call|phone call|call (my|me)\b|send (a |an )?(text|sms)|text message|facetime)\b"),
          "OmniPilot can't make phone calls or send text messages.",
          "I can write the message for you to send, or post it to Slack if Slack is connected."),
    Limit("devices", rx(r"\b(turn|switch) (on|off) (the|my) (lights?|tv|television|heater|heating|ac|air conditioning|oven|car|alarm)\b|\b(unlock|lock|start) (the|my) (door|car)\b"),
          "OmniPilot can't control devices in your home or car.",
          "I can explain how to set up an automation in your smart-home app, or how to wire your own Arduino project."),
    Limit("others_accounts", rx(r"\b(hack|break into|crack|bypass|get into)\b[^.?!]*\b(accounts?|passwords?|wi-?fi|phones?|instagram|snapchat|school (system|computer)|grades?)\b|\b(someone else'?s|my (friend|sister|brother|teacher|mom|dad|parent)'?s)\s+(accounts?|passwords?|e-?mails?|messages|phone)\b|\bchange my grades?\b"),
          "OmniPilot won't get into accounts, devices or systems that aren't yours, or change records like grades.",
          "If it's your own account, I can walk you through the official recovery steps."),
    Limit("predictions", rx(r"\b(lottery|powerball|winning) numbers\b|\b(predict|guarantee|tell me)\b[^.?!]*\b(stock|crypto|bitcoin) (price|prices|market)\b[^.?!]*\b(tomorrow|next week|exactly|guaranteed)\b"),
          "Nobody can reliably predict lottery numbers or exact future prices, and OmniPilot won't pretend to.",
          "I can explain the odds, or how prices are modelled and why forecasts are uncertain."),
    Limit("outside_workspace", rx(r"\b(delete|wipe|erase|format)\b[^.?!]*\b(my (computer|hard drive|disk|desktop|downloads|documents)|all (of )?my files|system32|the whole drive)\b"),
          "OmniPilot only touches files in the workspace folder you approved, and never deletes files on your computer.",
          "I can show you how to clean up files safely yourself."),
]

_CLAUSE_SPLIT = rx(r"[.;!?\n]+|,\s*(?:and\s+|then\s+)?|\s+(?:and then|then|and also|also)\s+|\s+and\s+(?=(?:please\s+)?[a-z]+\b)")


def _clauses(text: str) -> list[str]:
    return [c.strip() for c in _CLAUSE_SPLIT.split(text) if c and len(c.strip().split()) >= 2]


def check(text: str) -> dict:
    hits = [l for l in LIMITS if l.pattern.search(text)]
    if not hits:
        return {"hits": [], "whole": False}
    parts = _clauses(text)
    blocking = [l for l in LIMITS if l.id != "send_email"]
    whole = bool(parts) and all(any(l.pattern.search(c) for l in blocking) for c in parts)
    return {"hits": hits, "whole": whole}


def not_possible_text(gate: dict) -> str:
    return "**That isn't possible.**\n" + "\n".join(f"- {h.reason} {h.instead}" for h in gate["hits"])


def unusable(r: dict) -> bool:
    if r["status"] in ("failed_safe", "timeout", "unreachable", "missing_permissions"):
        return True
    return r["status"] == "partial_success" and r["confidence"] <= 0.2 and not any(a.get("requiresApproval") for a in r.get("proposedActions") or []) and not r.get("attachments")


def judge(gate: dict, results: list[dict], ai_down: str | None = None) -> dict:
    failed = [r for r in results if unusable(r) and r.get("role") != "support"]
    worked = [r for r in results if not unusable(r) and r.get("role") != "support"]
    reasons = ([ai_down] if ai_down and failed else []) + [h.reason for h in gate["hits"]] + [
        f"{r['agent']}: {re.sub(r'\s+', ' ', (r['findings'] or [r['status']])[0])[:240]}" for r in failed]
    if not worked and (failed or gate["hits"]):
        return {"verdict": "not_possible", "reasons": reasons}
    if gate["hits"] or failed:
        return {"verdict": "partly_possible", "reasons": reasons}
    return {"verdict": "possible", "reasons": []}


def verdict_note(v: dict, gate: dict) -> str | None:
    if v["verdict"] == "possible":
        return None
    lines = "\n".join(f"- {r}" for r in v["reasons"])
    if v["verdict"] == "not_possible":
        return f"**That isn't possible right now.**\n{lines}" + (f"\n\n{' '.join(h.instead for h in gate['hits'])}" if gate["hits"] else "")
    return f"**Part of this isn't possible:**\n{lines}"
