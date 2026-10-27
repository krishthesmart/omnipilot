import { afterEach, describe, expect, it, vi } from "vitest";
import { budgetWarning, cacheGet, cachePut, recordUsage, usageToday } from "../src/lib/aiBudget.js";
import { resetGroqState } from "../src/lib/groq.js";

describe("Groq budget and cache", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    resetGroqState();
  });

  it("tracks tokens per model over the last 24 hours and warns when little is left", () => {
    recordUsage("m1", 150_000);
    recordUsage("m2", 190_000);
    const u = usageToday(["m1", "m2"]);
    expect(u.map((x) => x.used)).toEqual([150_000, 190_000]);
    expect(budgetWarning(["m1", "m2"])).toMatch(/About 15% of today's free Groq allowance is left/);
    expect(budgetWarning(["fresh-model"])).toBeNull();
  });

  it("caches answers only when enabled", () => {
    vi.stubEnv("OMNIPILOT_AI_CACHE", "off");
    cachePut("k1", "hello", "m");
    expect(cacheGet("k1")).toBeNull();
    vi.stubEnv("OMNIPILOT_AI_CACHE", "on");
    cachePut("k1", "hello", "m");
    expect(cacheGet("k1")).toEqual({ text: "hello", model: "m" });
  });

  it("a repeated question is answered from the cache without calling Groq again; creative ones always ask", async () => {
    vi.stubEnv("OMNIPILOT_AI_CACHE", "on");
    vi.stubEnv("AGENT_LLM", "on");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ choices: [{ message: { content: "Paris" } }], usage: { total_tokens: 42 } }), { status: 200 }));
    const { generateText } = await import("../src/lib/llm.js");
    expect(await generateText("Answer briefly.", "Capital of France?", { temperature: 0.2 })).toBe("Paris");
    expect(await generateText("Answer briefly.", "Capital of France?", { temperature: 0.2 })).toBe("Paris");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await generateText("Write a poem.", "About the sea", { temperature: 0.9 });
    await generateText("Write a poem.", "About the sea", { temperature: 0.9 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(usageToday(["openai/gpt-oss-120b"])[0].used).toBeGreaterThanOrEqual(42);
  });
});
