import type { AgentResult } from "../types.js";

// Governance: OmniPilot says plainly when something isn't possible, instead of producing a weak or
// made-up answer. Two checks:
//   1. Before any agent runs, the request is compared with what OmniPilot can never do (send email,
//      make videos, buy things, make calls, get into other people's accounts...). If that's the
//      whole request, it answers "not possible" with the reason and what it can do instead. If
//      it's only part, the rest still runs and the answer says which part isn't possible.
//   2. After the agents run, if none produced a usable result, the answer says it couldn't be done
//      and why (each agent's own reason), instead of a confident-sounding summary of nothing.

export interface Limit {
  id: string;
  pattern: RegExp;
  /** Why OmniPilot can't. */
  reason: string;
  /** What it can do instead. */
  instead: string;
}

export const LIMITS: Limit[] = [
  {
    id: "send_email",
    pattern: /\bsend\b[^.?!]*\b(e-?mail|gmail)\b|\b(e-?mail|gmail)\b[^.?!]*\bsend\b(?![^.?!]*\bdraft)/i,
    reason: "OmniPilot never sends email on your behalf (Gmail is connected read-only, by design).",
    instead: "I can write the email and, when you approve, save it in your Gmail Drafts for you to send.",
  },
  {
    id: "video",
    // The video must be what's being made ("make a short video about..."), not something in a picture ("a picture of a movie theater").
    pattern: /\b(make|create|generate|render|produce|edit|film|record)\s+(me\s+)?(a|an|the|my|some|this)?\s*([\w-]+\s+)?(videos?|movies?|films?|mp4s?|video clips?|gifs?|tiktoks?|youtube videos?)\b/i,
    reason: "OmniPilot can't make videos: PicturePilot makes still pictures only.",
    instead: "I can make a still illustration, an interactive 3D model you can rotate and take apart, or a storyboard of scenes.",
  },
  {
    id: "purchase",
    pattern: /\b(buy|purchase)\s+(me\s+)?(a|an|the|some|\d+|tickets?)\b|\border\s+(me\s+)?(a|an|some)\s+(pizza|food|meal|uber|taxi|ride|delivery)\b|\b(pay|transfer|send)\s+(\$\s?\d+|\d+\s*(dollars|usd)|money|my (bill|rent))\b|\b(book|reserve)\s+(me\s+)?(a\s+)?(flight|hotel|table|room|tickets?|ride)\b/i,
    reason: "OmniPilot can't buy, order, pay or book anything: it has no access to payments or shops, on purpose.",
    instead: "I can compare options, find prices on the web, and write a checklist so you can do it yourself.",
  },
  {
    id: "phone",
    pattern: /\b(make a (phone )?call|phone call|call (my|me)\b|send (a |an )?(text|sms)|text message|facetime)\b/i,
    reason: "OmniPilot can't make phone calls or send text messages.",
    instead: "I can write the message for you to send, or post it to Slack if Slack is connected.",
  },
  {
    id: "devices",
    pattern: /\b(turn|switch) (on|off) (the|my) (lights?|tv|television|heater|heating|ac|air conditioning|oven|car|alarm)\b|\b(unlock|lock|start) (the|my) (door|car)\b/i,
    reason: "OmniPilot can't control devices in your home or car.",
    instead: "I can explain how to set up an automation in your smart-home app, or how to wire your own Arduino project.",
  },
  {
    id: "others_accounts",
    pattern: /\b(hack|break into|crack|bypass|get into)\b[^.?!]*\b(accounts?|passwords?|wi-?fi|phones?|instagram|snapchat|school (system|computer)|grades?)\b|\b(someone else'?s|my (friend|sister|brother|teacher|mom|dad|parent)'?s)\s+(accounts?|passwords?|e-?mails?|messages|phone)\b|\bchange my grades?\b/i,
    reason: "OmniPilot won't get into accounts, devices or systems that aren't yours, or change records like grades.",
    instead: "If it's your own account, I can walk you through the official recovery steps.",
  },
  {
    id: "predictions",
    pattern: /\b(lottery|powerball|winning) numbers\b|\b(predict|guarantee|tell me)\b[^.?!]*\b(stock|crypto|bitcoin) (price|prices|market)\b[^.?!]*\b(tomorrow|next week|exactly|guaranteed)\b/i,
    reason: "Nobody can reliably predict lottery numbers or exact future prices, and OmniPilot won't pretend to.",
    instead: "I can explain the odds, or how prices are modelled and why forecasts are uncertain.",
  },
  {
    id: "outside_workspace",
    pattern: /\b(delete|wipe|erase|format)\b[^.?!]*\b(my (computer|hard drive|disk|desktop|downloads|documents)|all (of )?my files|system32|the whole drive)\b/i,
    reason: "OmniPilot only touches files in the workspace folder you approved, and never deletes files on your computer.",
    instead: "I can show you how to clean up files safely yourself.",
  },
];

export interface Gate {
  /** Limits the request runs into. */
  hits: Limit[];
  /** True when every part of the request is something OmniPilot can't do. */
  whole: boolean;
}

/** The request's parts ("do X, then Y and Z"). */
function clauses(text: string): string[] {
  return text
    .split(/[.;!?\n]+|,\s*(?:and\s+|then\s+)?|\s+(?:and then|then|and also|also)\s+|\s+and\s+(?=(?:please\s+)?[a-z]+\b)/i)
    .map((c) => c.trim())
    .filter((c) => c.split(/\s+/).length >= 2);
}

/** Checks a request against the limits before anything runs. */
export function governanceCheck(text: string): Gate {
  const hits = LIMITS.filter((l) => l.pattern.test(text));
  if (!hits.length) return { hits, whole: false };
  const parts = clauses(text);
  // "Send an email" still gets the closest real thing (a draft to approve), so it never blocks the whole request.
  const blocking = LIMITS.filter((l) => l.id !== "send_email");
  const whole = parts.length > 0 && parts.every((c) => blocking.some((l) => l.pattern.test(c)));
  return { hits, whole };
}

export function notPossibleText(gate: Gate): string {
  const lines = gate.hits.map((h) => `- ${h.reason} ${h.instead}`);
  return `**That isn't possible.**\n${lines.join("\n")}`;
}

export interface Verdict {
  verdict: "possible" | "partly_possible" | "not_possible";
  reasons: string[];
}

/** A result that didn't really do anything: it failed, timed out, or only said it couldn't. */
export function unusable(r: Pick<AgentResult, "status" | "confidence" | "proposedActions" | "attachments">): boolean {
  if (["failed_safe", "timeout", "unreachable", "missing_permissions"].includes(r.status)) return true;
  return r.status === "partial_success" && r.confidence <= 0.2 && !r.proposedActions.some((a) => a.requiresApproval) && !(r.attachments ?? []).length;
}

/** What actually happened, judged after the agents ran. */
export function judgeOutcome(gate: Gate, results: AgentResult[], aiDown: string | null = null): Verdict {
  const failed = results.filter((r) => unusable(r) && r.role !== "support");
  const worked = results.filter((r) => !unusable(r) && r.role !== "support");
  const reasons = [
    // The underlying cause first (e.g. Groq's daily limit is used up), when some agent failed.
    ...(aiDown && failed.length ? [aiDown] : []),
    ...gate.hits.map((h) => h.reason),
    ...failed.map((r) => `${r.agent}: ${(r.findings[0] ?? r.status).replace(/\s+/g, " ").slice(0, 240)}`),
  ];
  if (!worked.length && (failed.length || gate.hits.length)) return { verdict: "not_possible", reasons };
  if (gate.hits.length || failed.length) return { verdict: "partly_possible", reasons };
  return { verdict: "possible", reasons: [] };
}

/** The answer's opening line when not everything could be done. */
export function verdictNote(v: Verdict, gate: Gate): string | null {
  if (v.verdict === "possible") return null;
  if (v.verdict === "not_possible") {
    return `**That isn't possible right now.**\n${v.reasons.map((r) => `- ${r}`).join("\n")}${gate.hits.length ? `\n\n${gate.hits.map((h) => h.instead).join(" ")}` : ""}`;
  }
  return `**Part of this isn't possible:**\n${v.reasons.map((r) => `- ${r}`).join("\n")}`;
}
