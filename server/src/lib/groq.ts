import { recordUsage } from "./aiBudget.js";
// OmniPilot's AI: Groq's free tier (https://console.groq.com). GROQ_API_KEY in server/.env.
// The key is only ever sent to Groq, in the Authorization header; it's never logged or returned.
// Requests (and web pages agents read) are sent to Groq to be answered.
//
// The free tier limits tokens per minute per model, so calls go to the smartest model first and
// move down the list when one is rate-limited (that model is skipped until its limit resets).

const GROQ_API = "https://api.groq.com/openai/v1";
const timeoutMs = () => Number(process.env.GROQ_TIMEOUT_MS ?? 45_000);

export const groqKey = (): string | null => process.env.GROQ_API_KEY?.trim() || null;

/** Smartest first. GROQ_MODEL picks the main model; the others are used when it's rate-limited. */
export function groqModels(): string[] {
  const main = process.env.GROQ_MODEL?.trim() || "openai/gpt-oss-120b";
  const backups = (process.env.GROQ_FALLBACK_MODELS ?? "qwen/qwen3.8-27b,openai/gpt-oss-20b").split(",").map((m) => m.trim()).filter(Boolean);
  return [main, ...backups.filter((m) => m !== main)];
}

/** How hard reasoning models think before answering: low, medium or high (GROQ_REASONING). */
const reasoningEffort = () => (["low", "medium", "high"].includes(process.env.GROQ_REASONING ?? "") ? process.env.GROQ_REASONING! : "medium");
const isReasoningModel = (model: string) => /gpt-oss/i.test(model);

/** A rate-limited model is skipped until this time. */
const pausedUntil = new Map<string, number>();
/** The model that answered most recently (for "written by ..." notes and the status line). */
let lastModel: string | null = null;
export const lastGroqModel = () => lastModel ?? groqModels()[0];

export interface ChatMessage {
  role: string;
  content: string;
}

export interface GroqOptions {
  /** A JSON schema, or "json" for any JSON object. */
  format?: Record<string, unknown> | "json";
  temperature: number;
  maxTokens: number;
  signal?: AbortSignal;
  onToken?: (text: string) => void;
  /** Overrides GROQ_REASONING for this call. */
  effort?: "low" | "medium" | "high";
  /** Long jobs (building a project): when every model is rate-limited, wait for the first to reset (up to `patientMs` in all) instead of giving up. */
  patientMs?: number;
  /** Quality matters more than speed (whole projects, 3D models): if the strongest model is only briefly rate-limited (up to this long), wait for it instead of using a weaker backup. */
  preferBestMs?: number;
}

/** About how many tokens a call used, when Groq doesn't say (4 characters per token). */
const estimateTokens = (messages: ChatMessage[], output: string) => Math.ceil((messages.reduce((n, m) => n + m.content.length, 0) + output.length) / 4);

/** "3h41m22.27s" -> seconds. */
function durationSeconds(s: string): number {
  const m = /(?:(\d+)h)?(?:(\d+)m)?(?:([\d.]+)s)?/.exec(s);
  const secs = (Number(m?.[1] ?? 0) || 0) * 3600 + (Number(m?.[2] ?? 0) || 0) * 60 + (Number(m?.[3] ?? 0) || 0);
  return secs > 0 ? secs : 60;
}

/** Models whose free daily allowance is used up, and when it resets. */
const dailyLimited = new Map<string, number>();

/**
 * Why the AI can't answer right now, in plain words, when every model has hit Groq's daily limit
 * (otherwise null).
 */
export function aiUnavailableReason(): string | null {
  const now = Date.now();
  const models = groqModels();
  const resets = models.map((m) => dailyLimited.get(m) ?? 0);
  if (!resets.every((t) => t > now)) return null;
  const mins = Math.ceil((Math.min(...resets) - now) / 60_000);
  const when = mins >= 60 ? `about ${Math.floor(mins / 60)} h ${mins % 60} min` : `about ${mins} min`;
  return `Groq's free daily limit is used up for every model (200,000 tokens per model per day), so the AI can't answer until it resets in ${when}. A paid Groq tier removes this limit.`;
}

/** Retry-After / reset headers give seconds or "1m30s"-style durations. */
function waitSeconds(res: Response): number {
  const raw = res.headers.get("retry-after") ?? res.headers.get("x-ratelimit-reset-tokens") ?? "";
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return n;
  const m = /(?:(\d+)m)?(?:([\d.]+)s)?/.exec(raw);
  const secs = (Number(m?.[1] ?? 0) || 0) * 60 + (Number(m?.[2] ?? 0) || 0);
  return secs > 0 ? secs : 20;
}

/** Some models cite as 【1†L31-L34】; OmniPilot's answers cite as [1]. */
export const tidyCitations = (text: string) => text.replace(/【(\d+)(?:†[^】]*)?】/g, "[$1]");

type Attempt = { text: string | null; retryNext: boolean };

async function askModel(model: string, messages: ChatMessage[], opts: GroqOptions, key: string): Promise<Attempt> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs());
  const onAbort = () => controller.abort();
  opts.signal?.addEventListener("abort", onAbort);
  const reasoning = isReasoningModel(model);
  let shown = "";
  let streamUsage: number | undefined;
  try {
    const res = await fetch(`${GROQ_API}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages,
        temperature: opts.temperature,
        // Reasoning models spend part of the budget thinking before they answer.
        max_completion_tokens: opts.maxTokens + (reasoning ? 1500 : 0),
        ...(reasoning ? { reasoning_effort: opts.effort ?? reasoningEffort() } : {}),
        ...(opts.format
          ? { response_format: opts.format === "json" ? { type: "json_object" } : { type: "json_schema", json_schema: { name: "reply", strict: false, schema: opts.format } } }
          : {}),
        stream: Boolean(opts.onToken),
        ...(opts.onToken ? { stream_options: { include_usage: true } } : {}),
      }),
    });
    if (res.status === 429) {
      // Per-minute limits pass quickly; the free tier's DAILY limit lasts hours, so that model is
      // skipped until it resets (and the user is told, instead of getting a vague failure).
      const body = await res.text().catch(() => "");
      const daily = /per day|\(TPD\)|\(RPD\)/i.test(body);
      const hint = /try again in ((?:\d+h)?(?:\d+m)?(?:[\d.]+s)?)/i.exec(body)?.[1];
      const secs = hint ? durationSeconds(hint) : waitSeconds(res);
      pausedUntil.set(model, Date.now() + Math.min(daily ? 6 * 3600 : 120, secs) * 1000);
      if (daily) dailyLimited.set(model, Date.now() + secs * 1000);
      return { text: null, retryNext: true };
    }
    // A model that's unavailable or rejects this request: the next one may still answer.
    if (!res.ok) return { text: null, retryNext: res.status !== 401 && res.status !== 403 };
    if (!opts.onToken) {
      const data = (await res.json()) as { choices?: { message?: { content?: string } }[]; usage?: { total_tokens?: number } };
      const text = data.choices?.[0]?.message?.content?.trim() || null;
      recordUsage(model, data.usage?.total_tokens ?? estimateTokens(messages, text ?? ""));
      return { text: text && !opts.format ? tidyCitations(text) : text, retryNext: !text };
    }
    // Server-sent events: data: {"choices":[{"delta":{"content":"..."}}]}
    const reader = res.body?.getReader();
    if (!reader) return { text: null, retryNext: true };
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const data = line.startsWith("data: ") ? line.slice(6).trim() : "";
        if (!data || data === "[DONE]") continue;
        try {
          const chunk = JSON.parse(data) as { choices?: { delta?: { content?: string } }[]; x_groq?: { usage?: { total_tokens?: number } }; usage?: { total_tokens?: number } };
          const usage = chunk.x_groq?.usage?.total_tokens ?? chunk.usage?.total_tokens;
          if (usage) streamUsage = usage;
          const piece = chunk.choices?.[0]?.delta?.content ?? "";
          if (piece) {
            shown += piece;
            opts.onToken(piece);
          }
        } catch {
          // keep-alive or partial line
        }
      }
    }
    recordUsage(model, streamUsage ?? estimateTokens(messages, shown));
    return { text: tidyCitations(shown.trim()) || null, retryNext: !shown.trim() };
  } catch {
    // If part of an answer was already shown, keep it rather than start over (it would repeat).
    return shown.trim() ? { text: tidyCitations(shown.trim()), retryNext: false } : { text: null, retryNext: !opts.signal?.aborted };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}

/** One chat completion: the first model that answers, or null (no key, all busy or failing, or stopped). */
export async function groqChat(messages: ChatMessage[], opts: GroqOptions): Promise<{ text: string; model: string } | null> {
  const deadline = Date.now() + (opts.patientMs ?? 0);
  // Wait briefly for the strongest model when it's only paused by a per-minute limit.
  const best = groqModels()[0];
  const bestWait = (pausedUntil.get(best) ?? 0) - Date.now();
  if (opts.preferBestMs && bestWait > 0 && bestWait <= opts.preferBestMs && !dailyLimited.has(best)) {
    await new Promise<void>((res) => {
      const t = setTimeout(res, bestWait + 250);
      opts.signal?.addEventListener("abort", () => (clearTimeout(t), res()), { once: true });
    });
  }
  for (;;) {
    const r = await groqChatOnce(messages, opts);
    if (r || !opts.patientMs || opts.signal?.aborted) return r;
    // Every model is busy: wait for the first rate limit to reset, then try again.
    const models = groqModels();
    const resetAt = Math.min(...models.map((m) => pausedUntil.get(m) ?? 0));
    const wait = Math.max(1000, resetAt - Date.now());
    if (!models.some((m) => (pausedUntil.get(m) ?? 0) > Date.now())) return null; // not a rate limit: a real failure
    if (Date.now() + wait > deadline) return null;
    await new Promise<void>((res) => {
      const t = setTimeout(res, wait);
      opts.signal?.addEventListener("abort", () => (clearTimeout(t), res()), { once: true });
    });
  }
}

async function groqChatOnce(messages: ChatMessage[], opts: GroqOptions): Promise<{ text: string; model: string } | null> {
  const key = groqKey();
  if (!key || opts.signal?.aborted) return null;
  const now = Date.now();
  const models = groqModels();
  // Skip rate-limited models; if every model is paused, try the one whose limit resets first.
  const ready = models.filter((m) => (pausedUntil.get(m) ?? 0) <= now);
  const order = ready.length ? ready : [...models].sort((a, b) => (pausedUntil.get(a) ?? 0) - (pausedUntil.get(b) ?? 0)).slice(0, 1);
  for (const model of order) {
    const { text, retryNext } = await askModel(model, messages, opts, key);
    if (text) {
      lastModel = model;
      return { text, model };
    }
    if (!retryNext || opts.signal?.aborted) return null;
  }
  return null;
}

export interface GroqStatus {
  configured: boolean;
  reachable: boolean;
  model: string;
  /** Plain-words problem, if any. */
  problem?: string;
}

let statusCache: { at: number; value: GroqStatus } | null = null;

/** Whether Groq is set up and answering (cached for a minute). */
export async function groqStatus(): Promise<GroqStatus> {
  const key = groqKey();
  const model = groqModels()[0];
  if (!key) return { configured: false, reachable: false, model, problem: "GROQ_API_KEY isn't set in server/.env" };
  if (statusCache && Date.now() - statusCache.at < 60_000) return statusCache.value;
  let value: GroqStatus;
  try {
    const res = await fetch(`${GROQ_API}/models`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(4000) });
    value =
      res.ok
        ? { configured: true, reachable: true, model }
        : { configured: true, reachable: false, model, problem: res.status === 401 ? "Groq rejected the API key" : `Groq answered ${res.status}` };
  } catch {
    value = { configured: true, reachable: false, model, problem: "Couldn't reach Groq (no internet?)" };
  }
  statusCache = { at: Date.now(), value };
  return value;
}

/** For tests: forget rate-limit pauses and cached status. */
export function resetGroqState() {
  pausedUntil.clear();
  statusCache = null;
  lastModel = null;
}
