// The AI model every agent uses: Groq (see groq.ts). Every call returns null instead of throwing,
// so each agent keeps its deterministic fallback path when the model can't answer (no key, no
// internet, rate-limited on every model).

import { cacheGet, cacheKey, cachePut } from "./aiBudget.js";
import { traceGeneration } from "./langfuse.js";
import { groqChat, groqKey, groqModels, lastGroqModel, type ChatMessage } from "./groq.js";
import { currentRunId, recordCall } from "./recorder.js";
import { lessonNote } from "./learning.js";

/** AGENT_LLM=off disables model calls entirely (tests, fully deterministic runs). */
export const agentLlmEnabled = () => process.env.AGENT_LLM !== "off" && Boolean(groqKey());

/** The model answering right now (for "written by ..." notes and logs). */
export const agentModel = (): string => lastGroqModel();

// Agents fire several calls at once (votes, checks); a few at a time keeps a run inside Groq's
// per-minute token limit instead of tripping it in one burst. OMNIPILOT_AI_PARALLEL changes it.
const maxParallel = () => Math.max(1, Number(process.env.OMNIPILOT_AI_PARALLEL ?? 3) || 3);
let running = 0;
const waiting: (() => void)[] = [];

/** Waits for a free slot; null if the run was stopped while waiting. */
async function takeTurn(signal?: AbortSignal): Promise<(() => void) | null> {
  if (signal?.aborted) return null;
  if (running >= maxParallel()) {
    const go = await new Promise<boolean>((resolve) => {
      const next = () => {
        signal?.removeEventListener("abort", stop);
        resolve(true);
      };
      const stop = () => {
        const i = waiting.indexOf(next);
        if (i >= 0) waiting.splice(i, 1);
        resolve(false);
      };
      waiting.push(next);
      signal?.addEventListener("abort", stop, { once: true });
    });
    if (!go) return null;
  }
  running++;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    running--;
    waiting.shift()?.();
  };
}

export interface GenerateOptions {
  json?: boolean;
  /** JSON Schema the output must match (structured outputs). */
  schema?: Record<string, unknown>;
  /** Few-shot examples, sent as prior user/assistant turns. */
  examples?: { user: string; assistant: string }[];
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  /** How hard a reasoning model thinks first. Default: low for short structured jobs, medium for answers. */
  effort?: "low" | "medium" | "high";
  /** How much of `user` to send (default 12,000 characters); code jobs send whole files. */
  maxInput?: number;
  /** Wait out rate limits for up to this long (long jobs like building a project). */
  patientMs?: number;
  /** Wait up to this long for the strongest model rather than use a weaker backup (quality-critical jobs). */
  preferBestMs?: number;
  /** Always ask afresh (never reuse a cached answer). */
  noCache?: boolean;
}

/** The prompt as chat messages: instructions, worked examples, then the request. */
function chatMessages(system: string, user: string, opts: GenerateOptions): ChatMessage[] {
  return [
    // JSON mode needs the word "JSON" in the prompt.
    { role: "system", content: opts.json && !/json/i.test(system) ? `${system}\nReply in JSON.` : system },
    ...(opts.examples ?? []).flatMap((ex) => [
      { role: "user", content: ex.user },
      { role: "assistant", content: ex.assistant },
    ]),
    { role: "user", content: user.slice(0, opts.maxInput ?? 12_000) },
  ];
}

async function ask(system: string, user: string, opts: GenerateOptions, onToken?: (text: string) => void): Promise<string | null> {
  if (!agentLlmEnabled()) return null;
  const release = await takeTurn(opts.signal);
  if (!release) return null;
  try {
    const format = opts.schema ?? (opts.json ? ("json" as const) : undefined);
    const temperature = opts.temperature ?? 0.3;
    // Lessons learned from feedback on similar requests, if any (see learning.ts).
    const messages = chatMessages(system + lessonNote(currentRunId()), user, opts);
    // Structured jobs (classify, check, plan) carry their own reasoning field and need little extra thought.
    const effort = opts.effort ?? (format ? "low" : undefined);
    // The same question with the same instructions: reuse the answer (steady, low-temperature jobs only).
    const cacheable = !opts.noCache && temperature <= 0.35;
    const key = cacheable ? cacheKey({ messages, format: format ?? null, temperature, maxTokens: opts.maxTokens ?? 400, effort: effort ?? null }) : "";
    const cached = cacheable ? cacheGet(key) : null;
    if (cached) {
      onToken?.(cached.text);
      recordCall({ model: `${cached.model} (cached)`, messages, format, temperature, output: cached.text });
      const now = new Date();
      traceGeneration({ runId: currentRunId(), model: cached.model, messages, output: cached.text, startTime: now, endTime: now, temperature, cached: true });
      return cached.text;
    }
    const startTime = new Date();
    // Behind the Python front door, answers come from its local-first model service (the model on this
    // computer first, Groq only for hard jobs or when the local answer isn't usable). Otherwise, Groq directly.
    const viaEngine = await engineChat(messages, { format, temperature, maxTokens: opts.maxTokens ?? 400, signal: opts.signal, effort, hard: Boolean(opts.preferBestMs) || (opts.maxTokens ?? 0) >= 4000 || opts.effort === "high" });
    if (viaEngine) onToken?.(viaEngine.text);
    const reply = viaEngine ?? (await groqChat(messages, { format, temperature, maxTokens: opts.maxTokens ?? 400, signal: opts.signal, onToken, effort, patientMs: opts.patientMs, preferBestMs: opts.preferBestMs }));
    recordCall({ model: reply?.model ?? groqModels()[0], messages, format, temperature, output: reply?.text ?? null });
    traceGeneration({ runId: currentRunId(), model: reply?.model ?? groqModels()[0], messages, output: reply?.text ?? null, startTime, endTime: new Date(), temperature });
    if (cacheable && reply?.text) cachePut(key, reply.text, reply.model);
    return reply?.text ?? null;
  } finally {
    release();
  }
}

/**
 * The Python front door's model service (OMNIPILOT_ENGINE_URL, set by the launcher). Null when it isn't
 * there or couldn't answer, so the caller falls back to Groq directly. (Temporary: this TypeScript engine
 * is being ported to Python, where the model service lives.)
 */
async function engineChat(
  messages: ChatMessage[],
  o: { format: unknown; temperature: number; maxTokens: number; signal?: AbortSignal; effort?: string; hard: boolean }
): Promise<{ text: string; model: string } | null> {
  const base = process.env.OMNIPILOT_ENGINE_URL;
  const token = process.env.OMNIPILOT_INTERNAL_TOKEN;
  if (!base || !token || o.signal?.aborted) return null;
  try {
    const res = await fetch(`${base}/api/internal/llm`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-omnipilot-internal": token },
      body: JSON.stringify({ messages, format: o.format ?? null, temperature: o.temperature, maxTokens: o.maxTokens, effort: o.effort ?? null, hard: o.hard, timeoutS: 120, runId: currentRunId() }),
      signal: o.signal ? AbortSignal.any([o.signal, AbortSignal.timeout(180_000)]) : AbortSignal.timeout(180_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { text?: string; model?: string; where?: string };
    return body.text ? { text: body.text, model: body.where === "local" ? `${body.model} (on this computer)` : String(body.model) } : null;
  } catch {
    return null;
  }
}

/** One answer from the model, or null. */
export const generateText = (system: string, user: string, opts: GenerateOptions = {}) => ask(system, user, opts);

/** Like generateText, but `onToken` receives each piece of text as the model writes it. */
export const streamText = (system: string, user: string, onToken: (text: string) => void, opts: GenerateOptions = {}) => ask(system, user, opts, onToken);

// A model that writes its answer before its reasoning decides before it thinks, and some engines
// emit a schema's fields alphabetically ("answer" before "reasoning"). Field names get
// order-preserving prefixes ("00_reasoning", "01_answer") for the model and lose them when parsed.
const ORDER_PREFIX = /^\d{2}_/;

function orderFields(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(orderFields);
  if (!schema || typeof schema !== "object") return schema;
  const s = schema as Record<string, unknown>;
  const out: Record<string, unknown> = { ...s };
  if (s.properties && typeof s.properties === "object") {
    const keys = Object.keys(s.properties as object);
    const name = (k: string) => `${String(keys.indexOf(k)).padStart(2, "0")}_${k}`;
    out.properties = Object.fromEntries(keys.map((k) => [name(k), orderFields((s.properties as Record<string, unknown>)[k])]));
    if (Array.isArray(s.required)) out.required = (s.required as string[]).filter((k) => keys.includes(k)).map(name);
  }
  if (s.items) out.items = orderFields(s.items);
  return out;
}

/** Puts the prefixes on an example's keys too, so few-shot examples match what the model must write. */
function prefixKeys(value: unknown, schema: unknown): unknown {
  const s = schema as Record<string, any> | undefined;
  if (Array.isArray(value)) return value.map((v) => prefixKeys(v, s?.items));
  if (!value || typeof value !== "object" || !s?.properties) return value;
  const keys = Object.keys(s.properties);
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([k, v]) => [keys.includes(k) ? `${String(keys.indexOf(k)).padStart(2, "0")}_${k}` : k, prefixKeys(v, s.properties[k])])
  );
}

function unprefixKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(unprefixKeys);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k.replace(ORDER_PREFIX, ""), unprefixKeys(v)]));
}

/** generateText + JSON.parse; null on any failure. With a schema, fields come back in the order the schema lists them. */
export async function generateJson<T>(system: string, user: string, opts: GenerateOptions = {}): Promise<T | null> {
  const schema = opts.schema ? (orderFields(opts.schema) as Record<string, unknown>) : undefined;
  const examples = opts.schema
    ? opts.examples?.map((ex) => {
        try {
          return { ...ex, assistant: JSON.stringify(prefixKeys(JSON.parse(ex.assistant), opts.schema)) };
        } catch {
          return ex;
        }
      })
    : opts.examples;
  const raw = await generateText(system, user, { ...opts, json: true, schema, examples });
  if (!raw) return null;
  try {
    // Tolerate a fenced reply: ```json {...} ```
    return unprefixKeys(JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, ""))) as T;
  } catch {
    return null;
  }
}

/**
 * Self-consistency: ask the same question up to `samples` times and keep the majority answer.
 * Returns null without a strict majority, which callers treat as "the model isn't sure".
 */
export async function majorityVote(ask: () => Promise<string | null>, samples = 3): Promise<string | null> {
  // One after another, stopping as soon as the outcome is settled: two matching answers out of
  // three need only two questions.
  const need = Math.floor(samples / 2) + 1;
  const counts = new Map<string, number>();
  for (let asked = 0; asked < samples; asked++) {
    const a = await ask();
    if (a !== null) counts.set(a, (counts.get(a) ?? 0) + 1);
    const top = Math.max(0, ...counts.values());
    if (top >= need) return [...counts.entries()].find(([, n]) => n === top)![0];
    if (top + (samples - asked - 1) < need) return null; // no answer can reach a majority any more
  }
  return null;
}

export const modelLimitation = () =>
  `Part of this answer was written by an AI model (${agentModel()} on Groq) and hasn't been verified against a source; double-check important facts.`;
