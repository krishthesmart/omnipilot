import { randomUUID } from "node:crypto";

// Optional tracing with Langfuse (https://langfuse.com): every request becomes a trace, and every
// AI call inside it a "generation" (prompt, answer, model, how long it took), so you can see
// exactly what each agent asked the model and why an answer came out the way it did.
// On when LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY are set (LANGFUSE_BASE_URL for self-hosted or
// the US region; LANGFUSE=off turns it off). Prompts and answers are sent to your Langfuse project.
// Calls are sent as OpenTelemetry spans (OTLP over HTTP, JSON) to Langfuse's OTel endpoint, batched in
// the background; tracing never slows down or breaks an answer.

export const langfuseEnabled = () => Boolean(process.env.LANGFUSE_PUBLIC_KEY?.trim() && process.env.LANGFUSE_SECRET_KEY?.trim()) && process.env.LANGFUSE !== "off";
const base = () => (process.env.LANGFUSE_BASE_URL?.trim() || process.env.LANGFUSE_HOST?.trim() || "https://cloud.langfuse.com").replace(/\/$/, "");

interface Span {
  traceId: string;
  spanId: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: { key: string; value: { stringValue: string } }[];
  status: { code: number };
}

let queue: Span[] = [];
let timer: NodeJS.Timeout | null = null;

const hex = (bytes: number) => randomUUID().replace(/-/g, "").slice(0, bytes * 2);
const nanos = (d: Date) => `${BigInt(d.getTime()) * 1_000_000n}`;
const attr = (key: string, value: unknown) => ({ key, value: { stringValue: typeof value === "string" ? value : JSON.stringify(value) } });

/** Sends what's queued (in the background; failures are dropped, never retried forever). */
export async function flushLangfuse(): Promise<void> {
  if (timer) clearTimeout(timer);
  timer = null;
  if (!queue.length || !langfuseEnabled()) return;
  const spans = queue.splice(0, 100);
  const auth = Buffer.from(`${process.env.LANGFUSE_PUBLIC_KEY!.trim()}:${process.env.LANGFUSE_SECRET_KEY!.trim()}`).toString("base64");
  try {
    await fetch(`${base()}/api/public/otel/v1/traces`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Basic ${auth}`, "x-langfuse-ingestion-version": "4" },
      body: JSON.stringify({
        resourceSpans: [{ resource: { attributes: [attr("service.name", "omnipilot")] }, scopeSpans: [{ scope: { name: "omnipilot" }, spans }] }],
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // Tracing is best effort.
  }
  if (queue.length) schedule();
}

function schedule() {
  if (timer) return;
  timer = setTimeout(() => void flushLangfuse(), 3000);
  timer.unref?.();
}

/** Records one AI call as a generation under its request's trace. */
export function traceGeneration(g: {
  runId: string | null;
  model: string;
  messages: { role: string; content: string }[];
  output: string | null;
  startTime: Date;
  endTime: Date;
  temperature?: number;
  cached?: boolean;
}) {
  if (!langfuseEnabled()) return;
  // One trace per request: the run id is already a 128-bit id.
  const traceId = g.runId?.replace(/-/g, "").toLowerCase().match(/^[0-9a-f]{32}$/)?.[0] ?? hex(16);
  const system = g.messages.find((m) => m.role === "system")?.content ?? "";
  queue.push({
    traceId,
    spanId: hex(8),
    // A readable name: the first words of the instructions ("Summarize this document…").
    name: system.replace(/\s+/g, " ").slice(0, 60) || "AI call",
    kind: 1,
    startTimeUnixNano: nanos(g.startTime),
    endTimeUnixNano: nanos(g.endTime),
    attributes: [
      attr("langfuse.trace.name", "OmniPilot request"),
      attr("langfuse.observation.type", "generation"),
      attr("langfuse.observation.model.name", g.model),
      attr("gen_ai.request.model", g.model),
      attr("langfuse.observation.input", g.messages.map((m) => ({ role: m.role, content: m.content.slice(0, 20_000) }))),
      attr("langfuse.observation.output", g.output?.slice(0, 20_000) ?? null),
      ...(g.temperature !== undefined ? [attr("langfuse.observation.model.parameters", { temperature: g.temperature })] : []),
      attr("langfuse.observation.metadata.cached", String(Boolean(g.cached))),
      ...(g.output === null ? [attr("langfuse.observation.level", "WARNING")] : []),
    ],
    status: { code: g.output === null ? 2 : 1 },
  });
  if (queue.length >= 50) void flushLangfuse();
  else schedule();
}
