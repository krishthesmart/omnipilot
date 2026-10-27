// Benchmark: held-out GSM8K test problems (never used in training), exact final number.
//   npx tsx ../training/eval.mts --model llama3.1:8b --method direct --n 150
// Methods:
//   direct  - the model reasons and answers by itself (how a model is normally used)
//   steps   - OmniPilot's format: the model writes steps, OmniPilot calculates (one try)
//   vote    - steps x3 with majority answer (what OmniPilot's Helper actually does)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PAL_EXAMPLE, PAL_SCHEMA, PAL_SYSTEM, formatNumber, runSteps } from "../server/src/lib/math/pal.ts";

const WORK = path.join(path.dirname(fileURLToPath(import.meta.url)), "work");
const arg = (name: string, d: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const model = arg("model", "qwen2.5:1.5b");
const method = arg("method", "direct");
const n = Number(arg("n", "150"));
const OLLAMA = process.env.OLLAMA_HOST ?? "http://localhost:11434";

const problems = fs.readFileSync(path.join(WORK, "eval", "gsm8k-test.jsonl"), "utf8").trim().split("\n").slice(0, n).map((l) => JSON.parse(l));

async function chat(messages: { role: string; content: string }[], opts: { temperature: number; schema?: object }) {
  const res = await fetch(`${OLLAMA}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages, stream: false, ...(opts.schema ? { format: opts.schema } : {}), options: { temperature: opts.temperature, num_predict: 700, seed: 7 } }),
    signal: AbortSignal.timeout(300_000),
  });
  const data = (await res.json()) as { message?: { content?: string } };
  return data.message?.content ?? "";
}

const DIRECT_SYSTEM = "Solve the math word problem. Think step by step, then finish with a final line of the form: Answer: <number>";

async function direct(q: string): Promise<number | null> {
  const out = await chat([{ role: "system", content: DIRECT_SYSTEM }, { role: "user", content: q }], { temperature: 0 });
  const m = /answer\s*[:=]?\s*\**\s*\$?\s*(-?[\d,]*\.?\d+)/i.exec(out.split("\n").reverse().join("\n")) ?? null;
  const nums = out.replace(/,(?=\d{3})/g, "").match(/-?\d*\.?\d+/g);
  const raw = m ? m[1] : nums?.[nums.length - 1];
  return raw ? Number(raw.replace(/,/g, "")) : null;
}

async function steps(q: string, temperature: number): Promise<number | null> {
  const out = await chat(
    [
      { role: "system", content: PAL_SYSTEM },
      { role: "user", content: PAL_EXAMPLE.user },
      { role: "assistant", content: PAL_EXAMPLE.assistant },
      { role: "user", content: q },
    ],
    { temperature, schema: PAL_SCHEMA }
  );
  try {
    const plan = JSON.parse(out);
    return Array.isArray(plan.steps) ? (runSteps(plan.steps.map(String))?.value ?? null) : null;
  } catch {
    return null;
  }
}

async function vote(q: string): Promise<number | null> {
  const values = (await Promise.all([steps(q, 0.1), steps(q, 0.7), steps(q, 0.7)])).filter((v): v is number => v !== null);
  if (!values.length) return null;
  const counts = new Map<string, number>();
  for (const v of values) counts.set(formatNumber(v), (counts.get(formatNumber(v)) ?? 0) + 1);
  const [best, count] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return count >= 2 ? Number(best) : values[0];
}

let correct = 0;
const started = Date.now();
const results: { question: string; gold: number; got: number | null; ok: boolean }[] = [];
for (const [i, p] of problems.entries()) {
  const got = method === "direct" ? await direct(p.question) : method === "steps" ? await steps(p.question, 0.1) : await vote(p.question);
  const ok = got !== null && Math.abs(got - p.gold) < 1e-4;
  if (ok) correct++;
  results.push({ question: p.question, gold: p.gold, got, ok });
  if ((i + 1) % 25 === 0) process.stderr.write(`  ${i + 1}/${problems.length}: ${correct} correct\n`);
}
const seconds = (Date.now() - started) / 1000;
const summary = { model, method, n: problems.length, correct, accuracy: Math.round((1000 * correct) / problems.length) / 10, secondsPerProblem: Math.round((10 * seconds) / problems.length) / 10 };
console.log(JSON.stringify(summary));
fs.mkdirSync(path.join(WORK, "results"), { recursive: true });
fs.writeFileSync(path.join(WORK, "results", `${model.replace(/[:/]/g, "_")}-${method}.json`), JSON.stringify({ summary, results }, null, 1));
