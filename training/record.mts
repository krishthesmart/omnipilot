// Runs the requests from prompts.mts through the real OmniPilot pipeline with a
// teacher model (Apache 2.0 licensed: qwen3.5:9b by default) standing in as
// OmniPilot's brain, and records every model call it makes. filter.mts then
// keeps the good ones as training data for omnipilot-mini. Resumable: rerun to
// continue where it stopped.
//   cd server && npx tsx ../training/record.mts [--teacher qwen3.5:9b] [--limit 20]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const WORK = path.join(path.dirname(fileURLToPath(import.meta.url)), "work");
const arg = (name: string, d: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const teacher = arg("teacher", "qwen3.5:9b");
const limit = Number(arg("limit", "100000"));
// --only everyday --pass kb: re-record one category (e.g. after building the encyclopedia).
const only = arg("only", "");
const pass = arg("pass", "");
// --skip "word problem": leave out categories already covered elsewhere (GSM8K covers word problems).
const skip = new Set(arg("skip", "").split(",").map((c) => c.trim()).filter(Boolean));

// Configure OmniPilot before it loads: the teacher runs everything, every call is recorded.
Object.assign(process.env, {
  OMNIPILOT_DB_PATH: path.join(WORK, "record.sqlite"),
  OMNIPILOT_RECORD: path.join(WORK, "recordings.jsonl"),
  OLLAMA_MODEL: teacher,
  OLLAMA_AGENT_MODEL: teacher,
  OLLAMA_THINK: "off",
  // Ollama answers one request at a time and a run sends several at once, so requests queue:
  // generous time limits keep them from timing out while they wait their turn.
  OLLAMA_TIMEOUT_MS: "600000",
  OMNIPILOT_SLOWDOWN: "4",
  MATHPILOT: "off",
});

const { executeRun } = await import("../server/src/pipeline.ts");
const { withRunContext } = await import("../server/src/lib/recorder.ts");
const { classifyPage, DEFAULT_POLICY } = await import("../server/src/lib/watcher.ts");
const { buildSessions } = await import("./prompts.mts");

const donePath = path.join(WORK, "record-done.json");
const done: Record<string, boolean> = fs.existsSync(donePath) ? JSON.parse(fs.readFileSync(donePath, "utf8")) : {};
const runsPath = path.join(WORK, "runs.jsonl");

const all = buildSessions();
// Round-robin across categories, so stopping early still leaves examples of every job.
const byCategory = new Map<string, [number, (typeof all)[number]][]>();
all.forEach((s, i) => byCategory.set(s.category, [...(byCategory.get(s.category) ?? []), [i, s]]));
const order: [number, (typeof all)[number]][] = [];
for (let round = 0; order.length < all.length; round++) for (const list of byCategory.values()) if (list[round]) order.push(list[round]);
const sessions = all;
let ran = 0;
const started = Date.now();
for (const [i, session] of order) {
  const key = `${pass ? `${pass}-` : ""}session-${i}`;
  if (done[key] || ran >= limit || (only && session.category !== only) || skip.has(session.category)) continue;
  const conversationId = `rec-${pass ? `${pass}-` : ""}${i}`;
  for (const message of session.messages) {
    const runId = randomUUID();
    const record = await executeRun(message, {}, runId, conversationId);
    // What filter.mts needs to judge the recorded calls: how each specialist did.
    fs.appendFileSync(
      runsPath,
      JSON.stringify({
        runId,
        category: session.category,
        message,
        status: record.status,
        selected: record.plan?.selectedAgents ?? [],
        agents: (record.agentResults ?? []).map((r) => ({ agent: r.agent, status: r.status, confidence: r.confidence, evidence: r.evidence, findings: r.findings.slice(0, 3) })),
      }) + "\n"
    );
  }
  done[key] = true;
  fs.writeFileSync(donePath, JSON.stringify(done));
  ran++;
  const mins = (Date.now() - started) / 60000;
  console.log(`${Object.keys(done).length}/${sessions.length} [${session.category}] ${session.messages[0].slice(0, 60)}  (${(mins / ran).toFixed(1)} min each)`);
}

// Watcher page checks happen in the browser extension, never in chat: record some directly.
const PAGES: [string, string][] = [
  ["https://www.youtube.com/watch?v=a1", "Adding fractions with unlike denominators | Math Antics"], ["https://www.youtube.com/watch?v=a2", "Minecraft speedrun world record"],
  ["https://en.wikipedia.org/wiki/Pythagorean_theorem", "Pythagorean theorem - Wikipedia"], ["https://en.wikipedia.org/wiki/Taylor_Swift", "Taylor Swift - Wikipedia"],
  ["https://www.reddit.com/r/learnmath/", "r/learnmath: help with algebra"], ["https://www.reddit.com/r/gaming/", "r/gaming"],
  ["https://www.coolmathgames.com/0-run-3", "Run 3 - Cool Math Games"], ["https://www.mathsisfun.com/algebra/index.html", "Algebra - Math is Fun"],
  ["https://www.amazon.com/dp/B0", "Wireless gaming headset"], ["https://www.ixl.com/math/grade-5", "IXL | Grade 5 math practice"],
];
if (!done["pages"] && !only) {
  const mathTime = { ...DEFAULT_POLICY, active: true, task: "learn math", subject: "math" as const, blockAI: true, onTaskOnly: true };
  for (const [i, [url, title]] of PAGES.entries()) await withRunContext(`page-${i}`, () => classifyPage(mathTime, url, title));
  done["pages"] = true;
  fs.writeFileSync(donePath, JSON.stringify(done));
}
console.log("Recording finished.");
