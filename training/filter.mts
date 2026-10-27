// Turns recorded teacher calls (record.mts) into training examples, keeping only
// the ones that verifiably did their job:
//   routing      -> matches the plan OmniPilot actually used
//   word problem -> steps run and agree with the answer OmniPilot gave
//   code         -> CodePilot's sandbox tests passed in that run
//   everything   -> valid output format, from a run that completed
// Writes work/recorded.jsonl (chat format, same prompts OmniPilot sends).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runSteps, formatNumber } from "../server/src/lib/math/pal.ts";

const WORK = path.join(path.dirname(fileURLToPath(import.meta.url)), "work");
const lines = (f: string) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

interface Call {
  runId: string | null;
  messages: { role: string; content: string }[];
  format?: any;
  temperature?: number;
  output: string | null;
}

const calls: Call[] = lines(path.join(WORK, "recordings.jsonl"));
const runs = new Map<string, any>(lines(path.join(WORK, "runs.jsonl")).map((r) => [r.runId, r]));

const KINDS: [string, RegExp][] = [
  ["routing", /^You are the routing classifier/],
  ["follow-up", /^Rewrite the user's latest message/],
  ["reflect", /^You are the lead of a team/],
  ["answer", /^You are Helper, a careful assistant/],
  ["grounded", /^You are Helper\. Answer the user's request using ONLY/],
  ["fact-check", /^Answer the question in at most 8 words/],
  ["word problem", /^You solve word problems/],
  ["code", /^You are CodePilot, a careful senior engineer/],
  ["tests", /^You write unit tests/],
  ["repair", /^You are CodePilot fixing your own code/],
  ["prompt", /^You are PromptPilot/],
  ["lesson", /^You are LearnPilot/],
  ["quiz key", /^Answer the multiple-choice question/],
  ["wiring", /^You are HardwarePilot/],
  ["picture", /^You are PicturePilot/],
  ["math explain", /^You are MathPilot/],
  ["compose", /^You write OmniPilot's final reply/],
  ["page check", /focus|on.task|on_task/i],
];
const kindOf = (c: Call) => KINDS.find(([, re]) => re.test(c.messages[0]?.content ?? ""))?.[0] ?? "other";

function validJson(c: Call): any | undefined {
  if (!c.format) return null;
  try {
    const v = JSON.parse(c.output!);
    const required: string[] = typeof c.format === "object" ? (c.format.required ?? []) : [];
    return required.every((k) => k in v) ? v : undefined;
  } catch {
    return undefined;
  }
}

const agentOk = (run: any, agent: string) => run?.agents?.some((a: any) => a.agent === agent && ["success", "partial_success"].includes(a.status));
const codeVerified = (run: any) => run?.agents?.some((a: any) => a.agent === "CodePilot" && a.evidence?.some((e: any) => e.source === "sandbox-run" && /^Verified/.test(e.detail)));

const reasons: Record<string, number> = {};
const reject = (why: string) => ((reasons[why] = (reasons[why] ?? 0) + 1), false);

function keep(c: Call, kind: string): boolean {
  if (!c.output?.trim()) return reject("empty output");
  const pageCheck = c.runId?.startsWith("page-");
  const run = c.runId ? runs.get(c.runId) : undefined;
  if (!pageCheck && (!run || !["completed", "needs_approval", "needs_clarification"].includes(run.status))) return reject("run didn't complete");
  const json = validJson(c);
  if (json === undefined) return reject("invalid output format");
  switch (kind) {
    case "routing": {
      const picked = new Set<string>(json.agents ?? []);
      const used = new Set<string>(run.selected.filter((a: string) => a !== "PromptPilot"));
      return [...used].every((a) => picked.has(a)) && [...picked].every((a) => used.has(a)) ? true : reject("routing differs from the plan used");
    }
    case "word problem": {
      const out = Array.isArray(json.steps) ? runSteps(json.steps.map(String)) : null;
      if (!out) return reject("steps don't run");
      const given = /The answer is \*\*([^*]+)\*\*/.exec(run.agents.find((a: any) => a.agent === "Helper")?.findings?.[0] ?? "")?.[1];
      return given === formatNumber(out.value) ? true : reject("steps disagree with the majority answer");
    }
    case "code":
    case "tests":
    case "repair":
      return codeVerified(run) ? true : reject("code wasn't verified by tests");
    case "lesson":
    case "quiz key":
      return agentOk(run, "LearnPilot") ? true : reject("lesson failed");
    case "wiring":
      return agentOk(run, "HardwarePilot") ? true : reject("wiring rejected");
    case "picture":
      return agentOk(run, "PicturePilot") ? true : reject("picture failed");
    default:
      return c.output.length < 6000 ? true : reject("too long");
  }
}

const MAX_PER_KIND = 80;
const seen = new Set<string>();
const perPrompt = new Map<string, number>();
const kept: { messages: { role: string; content: string }[]; kind: string }[] = [];
const byKind: Record<string, number> = {};
for (const c of calls) {
  const kind = kindOf(c);
  if (!keep(c, kind)) continue;
  const promptKey = JSON.stringify(c.messages);
  const key = promptKey + c.output;
  if (seen.has(key)) continue;
  // Several samples of the same prompt (votes): keep at most two different good ones.
  if ((perPrompt.get(promptKey) ?? 0) >= 2) continue;
  // No single job may dominate (the coordinator's check runs on every request).
  if ((byKind[kind] ?? 0) >= MAX_PER_KIND) continue;
  seen.add(key);
  perPrompt.set(promptKey, (perPrompt.get(promptKey) ?? 0) + 1);
  // Structured outputs are stored compactly, the way the student should write them.
  const output = c.format ? JSON.stringify(JSON.parse(c.output!)) : c.output!.trim();
  kept.push({ kind, messages: [...c.messages, { role: "assistant", content: output }] });
  byKind[kind] = (byKind[kind] ?? 0) + 1;
}

fs.writeFileSync(path.join(WORK, "recorded.jsonl"), kept.map((k) => JSON.stringify(k)).join("\n") + (kept.length ? "\n" : ""));
console.log(`recorded calls: ${calls.length}, kept: ${kept.length}`);
console.log("kept by job:", byKind);
console.log("rejected:", reasons);
