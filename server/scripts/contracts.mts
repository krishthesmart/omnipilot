// Reference runs: what OmniPilot's pipeline does for representative requests, in
// a deterministic setup (keyword routing, no model). The current engine is
// checked against these (tests/contracts.test.ts), and the Python/LangGraph
// engine must reproduce them before it replaces anything (engine/tests).
//   npx tsx scripts/contracts.mts           # print the current results
//   npx tsx scripts/contracts.mts --write   # update contracts/runs.json
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Reference runs use the starter workspace (as the tests do), never the user's live one.
import setupWorkspace, { TEST_WORKSPACE } from "../tests/setup/workspace.js";
if (!process.env.VITEST) setupWorkspace();
Object.assign(process.env, { OMNIPILOT_DB_PATH: ":memory:", ROUTER_MODE: "heuristic", AGENT_LLM: "off", MATHPILOT: "off", OMNIPILOT_KNOWLEDGE: "/nonexistent", OMNIPILOT_WORKSPACE: TEST_WORKSPACE });

export const CONTRACT_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "contracts", "runs.json");

/** Conversations: later messages are follow-ups to earlier ones. */
export const CASES: { name: string; messages: string[] }[] = [
  { name: "letter count tool", messages: ["How many r's are in strawberry?"] },
  { name: "unit conversion tool", messages: ["convert 5 miles to km"] },
  { name: "identity check", messages: ["Is it true that (a+b)^2 = a^2 + b^2?"] },
  { name: "general question without a model", messages: ["Why is the sky blue?"] },
  { name: "code request without a model", messages: ["Write a Python function that reverses a string"] },
  { name: "code scan", messages: ["Check my code for security bugs: const q = 'SELECT * FROM users WHERE id=' + req.query.id; db.query(q);"] },
  { name: "lesson", messages: ["Explain photosynthesis for a 5th grader"] },
  { name: "wiring guide", messages: ["How do I connect an LED to my Arduino?"] },
  { name: "wiring + lesson (dependent agents)", messages: ["How do I connect a button to my Arduino and how does it work?"] },
  { name: "picture", messages: ["Draw a cat and a dog under a rainbow"] },
  { name: "unsafe picture", messages: ["Draw a gory scene"] },
  { name: "focus session", messages: ["My kid should learn math for 1 hour, no AI"] },
  { name: "science simulation", messages: ["Simulate a projectile launched at 25 m/s at 45 degrees"] },
  { name: "ancient scripts", messages: ["Compare Linear A and Linear B"] },
  { name: "prompt refinement", messages: ["Refine my Midjourney prompt: a cat in space"] },
  { name: "homework cheating blocked", messages: ["Do my homework for me: solve all of these math problems"] },
  { name: "integration request", messages: ["Connect Slack"] },
  { name: "follow-up", messages: ["Is 97 prime?", "and is 91 prime?"] },
];

const PHASES = new Set(["run_started", "router_plan", "coordinator_plan", "synthesizer_start", "synthesizer_draft", "router_review_start", "router_review", "clarification_needed", "final_response", "run_failed", "run_cancelled"]);

/** The parts of a run that must stay the same: phases in order, the plan, each agent's outcome, the answer's shape. */
export async function captureCase(c: (typeof CASES)[number], i: number) {
  const { executeRun } = await import("../src/pipeline.js");
  const { runEventBus } = await import("../src/lib/eventBus.js");
  const turns = [];
  for (const [j, message] of c.messages.entries()) {
    const runId = `contract-${i}-${j}`;
    const record = await executeRun(message, {}, runId, `contract-conv-${i}`);
    const events = runEventBus.getHistory(runId);
    turns.push({
      message,
      status: record.status,
      phases: events.map((e) => e.type).filter((t) => PHASES.has(t)),
      agentsStarted: [...new Set(events.filter((e) => e.type === "agent_start").map((e: any) => e.agent))].sort(),
      selected: record.plan?.selectedAgents ?? [],
      steps: (record.steps ?? []).map((s) => ({ agent: s.agent, dependsOn: [...s.dependsOn].sort(), afterAll: Boolean(s.afterAll) })),
      results: (record.agentResults ?? [])
        .map((r) => ({ agent: r.agent, status: r.status, usedResultsFrom: [...(r.usedResultsFrom ?? [])].sort(), coveringFor: r.coveringFor ?? null }))
        .sort((a, b) => a.agent.localeCompare(b.agent)),
      standalone: record.standaloneRequest ?? null,
      attachments: (record.finalResponse?.attachments ?? []).map((a) => a.type),
      answerStartsWith: (record.finalResponse?.summary ?? record.review?.clarifyingQuestion ?? "").slice(0, 60),
    });
  }
  return { name: c.name, turns };
}

/** Phrases whose keyword scores both engines must agree on (the router's deterministic half). */
export const KEYWORD_PHRASES = [
  ...CASES.flatMap((c) => c.messages),
  "Research how to improve my project, check my code for issues, and create a study plan.",
  "connect an LED to my arduino", "Connect Slack and schedule a daily status update", "block youtube and games during homework",
  "is khanacademy.org allowed?", "check if a number is even", "fix the bug in my script", "what's wrong with this code",
  "teach me fractions with flashcards", "make a picture of a dragon", "draw a wiring diagram for a servo", "draw a graph of y = x^2",
  "Is it true that sin(x)^2 + cos(x)^2 = 1?", "Solve 3x + 4 = 19", "what has MathPilot found?", "simulate population growth of rabbits",
  "compare cuneiform and hieroglyphs", "rephrase my prompt for ChatGPT", "how does it work?", "plug in my monitor with HDMI",
  "my son needs focus time for reading, no AI", "unblock wikipedia", "find my notes about the project", "",
];

export async function keywordContract() {
  const { keywordScores } = await import("../src/router/decisionModel.js");
  return KEYWORD_PHRASES.map((text) => ({ text, scores: keywordScores(text) }));
}

if (process.argv[1]?.endsWith("contracts.mts")) {
  const out = [];
  for (const [i, c] of CASES.entries()) out.push(await captureCase(c, i));
  if (process.argv.includes("--write")) {
    fs.writeFileSync(CONTRACT_FILE, JSON.stringify({ about: "Reference runs (keyword routing, no model). See server/scripts/contracts.mts.", cases: out }, null, 2) + "\n");
    console.log(`wrote ${out.length} reference runs to ${CONTRACT_FILE}`);
    const keywords = await keywordContract();
    fs.writeFileSync(path.join(path.dirname(CONTRACT_FILE), "keywords.json"), JSON.stringify({ about: "Keyword scores per phrase. See server/scripts/contracts.mts.", phrases: keywords }, null, 2) + "\n");
    console.log(`wrote ${keywords.length} keyword score cases`);
  } else console.log(JSON.stringify(out, null, 2));
}
