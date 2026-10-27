import { afterEach, describe, expect, it, vi } from "vitest";
import { flushLangfuse, traceGeneration } from "../src/lib/langfuse.js";

describe("Langfuse tracing", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("sends each AI call as an OpenTelemetry generation span under its request's trace", async () => {
    vi.stubEnv("LANGFUSE_PUBLIC_KEY", "pk-lf-1");
    vi.stubEnv("LANGFUSE_SECRET_KEY", "sk-lf-1");
    vi.stubEnv("LANGFUSE_BASE_URL", "https://lf.example");
    const spans: any[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url: any, init: any) => {
      expect(String(url)).toBe("https://lf.example/api/public/otel/v1/traces");
      expect(init.headers.Authorization).toBe(`Basic ${Buffer.from("pk-lf-1:sk-lf-1").toString("base64")}`);
      expect(init.headers["x-langfuse-ingestion-version"]).toBe("4");
      spans.push(...JSON.parse(init.body).resourceSpans[0].scopeSpans[0].spans);
      return new Response("{}", { status: 200 });
    });
    const t = new Date();
    const runId = "708e44c1-41fd-4df1-ab05-d8d49d24a808";
    for (const out of ["Paris", null]) traceGeneration({ runId, model: "m", messages: [{ role: "system", content: "Answer briefly." }, { role: "user", content: "Capital of France?" }], output: out, startTime: t, endTime: t });
    await flushLangfuse();
    expect(spans).toHaveLength(2);
    expect(spans.every((s) => s.traceId === "708e44c141fd4df1ab05d8d49d24a808" && /^[0-9a-f]{16}$/.test(s.spanId))).toBe(true);
    const attrs = Object.fromEntries(spans[0].attributes.map((a: any) => [a.key, a.value.stringValue]));
    expect(attrs).toMatchObject({ "langfuse.observation.type": "generation", "langfuse.observation.model.name": "m", "langfuse.observation.output": "Paris" });
    expect(spans[0].name).toBe("Answer briefly.");
    expect(spans[1].status.code).toBe(2);
  });

  it("does nothing without keys", async () => {
    vi.stubEnv("LANGFUSE_PUBLIC_KEY", "");
    const f = vi.spyOn(globalThis, "fetch");
    traceGeneration({ runId: "r", model: "m", messages: [], output: "x", startTime: new Date(), endTime: new Date() });
    await flushLangfuse();
    expect(f).not.toHaveBeenCalled();
  });
});
