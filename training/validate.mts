// Stage 2: keep only examples whose steps run in OmniPilot's own step runner and
// give the right answer, then write chat-format training files using the exact
// prompt and schema OmniPilot sends at runtime.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PAL_EXAMPLE, PAL_SYSTEM, runSteps } from "../server/src/lib/math/pal.ts";

const WORK = path.join(path.dirname(fileURLToPath(import.meta.url)), "work");
const read = (f: string) => fs.readFileSync(path.join(WORK, "candidates", f), "utf8").trim().split("\n").map((l) => JSON.parse(l));

let seed = 7;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const shuffle = <T,>(a: T[]) => {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

const pal = (r: any) => ({
  messages: [
    { role: "system", content: PAL_SYSTEM },
    { role: "user", content: PAL_EXAMPLE.user },
    { role: "assistant", content: PAL_EXAMPLE.assistant },
    { role: "user", content: r.question },
    { role: "assistant", content: JSON.stringify({ reasoning: r.reasoning, steps: r.steps }) },
  ],
});

const checked = read("gsm8k-train.jsonl").filter((r) => {
  const out = runSteps(r.steps);
  return out !== null && Math.abs(out.value - r.gold) < 1e-6;
});
console.log(`gsm8k train: ${checked.length} examples verified by the step runner`);

const general = read("general.jsonl").map((g) => ({
  messages: [
    { role: "system", content: "You are a helpful assistant." },
    { role: "user", content: g.user },
    { role: "assistant", content: g.assistant },
  ],
}));

// Recorded OmniPilot calls (record.mts + filter.mts): every job the model does, when available.
const recordedPath = path.join(WORK, "recorded.jsonl");
const recorded: { kind: string; messages: unknown[] }[] = fs.existsSync(recordedPath)
  ? fs.readFileSync(recordedPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
  : [];
// Each job appears at least ~40 times (rare jobs repeated, up to 8 copies), so a handful of
// verified examples still teach the format; common jobs appear 2x so 7k word problems don't drown them.
const byJob = new Map<string, { kind: string; messages: unknown[] }[]>();
for (const r of recorded) byJob.set(r.kind, [...(byJob.get(r.kind) ?? []), r]);
const recordedExamples = [...byJob.entries()].flatMap(([kind, list]) => {
  const copies = Math.min(8, Math.max(2, Math.ceil(40 / list.length)));
  console.log(`  ${kind}: ${list.length} verified x${copies}`);
  return Array.from({ length: copies }, () => list.map((r) => ({ messages: r.messages }))).flat();
});
console.log(`recorded OmniPilot calls: ${recorded.length} -> ${recordedExamples.length} training examples`);

const all = shuffle([...checked.map(pal), ...general, ...recordedExamples]);
const nValid = 200;
const outDir = path.join(WORK, "dataset");
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "valid.jsonl"), all.slice(0, nValid).map((x) => JSON.stringify(x)).join("\n") + "\n");
fs.writeFileSync(path.join(outDir, "train.jsonl"), all.slice(nValid).map((x) => JSON.stringify(x)).join("\n") + "\n");
console.log(`wrote ${all.length - nValid} training and ${nValid} validation examples`);

// Held-out benchmark: GSM8K test problems the model never sees.
const test = shuffle(read("gsm8k-test-all.jsonl"));
fs.mkdirSync(path.join(WORK, "eval"), { recursive: true });
fs.writeFileSync(path.join(WORK, "eval", "gsm8k-test.jsonl"), test.map((x) => JSON.stringify(x)).join("\n") + "\n");
console.log(`benchmark: ${test.length} held-out test problems`);
