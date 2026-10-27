import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";

// A tiny encyclopedia with the same layout `npm run knowledge` builds.
const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "kb-")), "knowledge.sqlite");
beforeAll(() => {
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
  const db = new DatabaseSync(file);
  db.exec("CREATE VIRTUAL TABLE kb USING fts5(title, body, tokenize = 'porter unicode61')");
  const add = db.prepare("INSERT INTO kb (title, body) VALUES (?, ?)");
  add.run("Australia", "Australia is a country in the southern hemisphere. Its capital city is Canberra.");
  add.run("Liberal Party of Australia", "The Liberal Party of Australia is a political party.");
  add.run("Vaccine", "A vaccine is a biological preparation given to prevent a disease.");
  add.run("Romeo and Juliet", "Romeo and Juliet is a play written by William Shakespeare.");
  add.run("Romeo and Juliet (1908 movie)", "Romeo and Juliet is a 1908 silent movie.");
  add.run("C&P Telephone", "The Chesapeake and Potomac Telephone Company is a company.");
  add.run("Telephone", "A telephone is a communication tool. Alexander Graham Bell patented it in 1876.");
  db.close();
  vi.stubEnv("OMNIPILOT_KNOWLEDGE", file);
});

afterEach(() => vi.unstubAllGlobals());

describe("Offline encyclopedia", () => {
  it("finds the article a question is about", async () => {
    const { lookUp } = await import("../src/lib/knowledge.js");
    expect(lookUp("What is the capital of Australia?")[0].title).toBe("Australia");
    expect(lookUp("How do vaccines work?")[0].title).toBe("Vaccine"); // plural-insensitive
    expect(lookUp("Who wrote Romeo and Juliet?")[0].title).toBe("Romeo and Juliet"); // main article first
    expect(lookUp("Who invented the telephone?")[0].title).toBe("Telephone"); // not "C&P Telephone"
    expect(lookUp("What is quantum chromodynamics?")).toEqual([]);
  });

  it("Helper answers from the passages and cites the article", async () => {
    vi.stubEnv("AGENT_LLM", "on");
    const { helperAgent } = await import("../src/agents/helper.js");
    const bodies: string[] = [];
    const replies = [{ reasoning: "", answer: "Canberra is the capital (Wikipedia: Australia)." }, { answer: "Canberra" }, { answer: "Canberra" }];
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body: string }) => {
        bodies.push(init.body);
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(replies[call++]) } }] }), { status: 200 });
      })
    );
    const r = await helperAgent({ runId: "t", requestText: "What is the capital of Australia?", context: {} }, { signal: new AbortController().signal, workspaceRoot: process.env.OMNIPILOT_WORKSPACE! });
    expect(bodies[0]).toContain("Its capital city is Canberra");
    expect(r.findings[0]).toContain("Wikipedia: Australia");
    expect(r.evidence.some((e) => e.source === "encyclopedia:Australia")).toBe(true);
    expect(r.confidence).toBeGreaterThan(0.7);
  });
});
