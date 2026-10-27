import { generateJson } from "./llm.js";
import { insertTurn, pruneTurns, selectTurns } from "../db.js";

// Multi-turn memory: lets "make it faster", "now in JavaScript" or "why?"
// refer back to the previous answer. Turns are stored in SQLite per
// conversation (the last 10), and conversations older than 30 days are pruned.

export interface Turn {
  request: string;
  /** The request as actually executed (a follow-up rewritten to stand alone). */
  standalone: string;
  answer: string;
  status: string;
  /** Set when OmniPilot answered with a question instead of an answer. */
  clarifyingQuestion?: string;
}

export const MAX_TURNS = 10;

export function getTurns(conversationId: string): Turn[] {
  return selectTurns(conversationId) as Turn[];
}

export function appendTurn(conversationId: string, turn: Turn) {
  insertTurn(conversationId, turn, MAX_TURNS);
}

pruneTurns();

/** Short messages that lean on what came before: pronouns, "now/also/instead", bare "why?". */
export const FOLLOW_UP =
  /^(and|also|now|then|but|so|ok|okay|what about|how about|why|how come|can you|could you|make|do|try|again|instead|same)\b|\b(it|that|this|these|those|them|its|the (code|function|answer|above|last|previous|one)|(first|second|third|last|other|next) (one|issue|step|part)|instead|again|more|less|shorter|longer|simpler|faster)\b/i;

export function looksLikeFollowUp(message: string, previous: Turn | undefined): boolean {
  if (!previous) return false;
  if (previous.status === "needs_clarification") return true; // the message answers our question
  return message.trim().split(/\s+/).length <= 14 && FOLLOW_UP.test(message);
}

export const REWRITE_SYSTEM =
  "Rewrite the user's latest message as ONE standalone request that makes sense without the conversation, " +
  "by filling in what 'it/that/this' refers to from the previous turn. Keep the user's intent and wording; do not answer it. " +
  "If the latest message already stands alone, return it unchanged.";
export const REWRITE_SCHEMA = { type: "object", properties: { request: { type: "string" } }, required: ["request"] };
export const REWRITE_EXAMPLES = [
  {
    user: 'Previous request: "Write a python function that returns the nth prime number"\nLatest message: "now do it in javascript"',
    assistant: JSON.stringify({ request: "Write a javascript function that returns the nth prime number" }),
  },
  {
    user: 'Previous request: "Explain photosynthesis for a 5th grader"\nLatest message: "make a harder quiz on that"',
    assistant: JSON.stringify({ request: "Make a harder quiz on photosynthesis for a 5th grader" }),
  },
  {
    user:
      'Previous request: "Check my code for security bugs"\nPrevious answer (start): "- [CRITICAL] SQL injection at login.js:9 ...\n- [HIGH] Hardcoded API key at config.js:3 ..."\nLatest message: "how do I fix the first one?"',
    assistant: JSON.stringify({ request: "How do I fix the SQL injection at login.js:9?" }),
  },
  {
    user: 'Previous request: "Check my code for security bugs"\nOmniPilot asked: "Which file should I check?"\nLatest message: "the login handler"',
    assistant: JSON.stringify({ request: "Check the login handler code for security bugs" }),
  },
];

/**
 * Turns a follow-up into a standalone request (query rewriting), so the router
 * and every agent see the full intent. Falls back to attaching the previous
 * request when the model is unavailable or returns something unusable.
 */
export async function resolveFollowUp(message: string, turns: Turn[]): Promise<string> {
  const previous = turns[turns.length - 1];
  if (!looksLikeFollowUp(message, previous)) return message;

  const asked = previous.clarifyingQuestion ? `\nOmniPilot asked: "${previous.clarifyingQuestion}"` : "";
  const rewritten = await generateJson<{ request: string }>(
    REWRITE_SYSTEM,
    `Previous request: "${previous.standalone}"${asked}${
      previous.answer ? `\nPrevious answer (start): "${previous.answer.slice(0, 700)}"` : ""
    }\nLatest message: "${message}"`,
    { schema: REWRITE_SCHEMA, examples: REWRITE_EXAMPLES, temperature: 0, maxTokens: 120 }
  );
  const candidate = rewritten?.request?.trim();
  // A small model sometimes just repeats the previous request; a rewrite must keep the new message's own words.
  if (candidate && candidate.length <= 600 && keepsWords(message, candidate)) return candidate;
  // A message that names its own subject stands alone (agents still see the previous turn as context).
  if (contentWords(message).length >= 3 && previous.status !== "needs_clarification") return message;
  return `${message} (following up on: "${previous.standalone}")`;
}

export const STOP = new Set(
  ("the and you how can one for are was not but its now why did get our out use who what when that this with have them then make does " +
    "into about tell please could would should also again instead").split(" ")
);

function contentWords(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => w.length > 2 && !STOP.has(w));
}

function keepsWords(message: string, candidate: string): boolean {
  const words = contentWords(message);
  if (words.length === 0) return true;
  const lower = candidate.toLowerCase();
  return words.filter((w) => lower.includes(w.slice(0, 5))).length / words.length >= 0.6;
}

/** The previous exchange, for agents to build on ("make it faster" needs the code). */
export function previousTurnContext(turns: Turn[]): { request: string; answer: string } | undefined {
  const previous = turns[turns.length - 1];
  return previous ? { request: previous.standalone, answer: previous.answer.slice(0, 2500) } : undefined;
}
