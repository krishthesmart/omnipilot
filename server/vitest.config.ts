import os from "node:os";
import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // A private copy of the starter workspace (tests/setup/workspace.ts); the live workspace's own files are never run as tests.
    globalSetup: ["tests/setup/workspace.ts"],
    exclude: ["**/node_modules/**", "workspace/**", "dist/**"],
    env: {
      OMNIPILOT_DB_PATH: ":memory:",
      // Tests mock Groq per test; a cached answer from an earlier test would hide what they check.
      OMNIPILOT_AI_CACHE: "off",
      OMNIPILOT_WORKSPACE: path.join(os.tmpdir(), "omnipilot-test-workspace"),
      // Keep the full test suite deterministic/offline by default; the local-model
      // path is exercised explicitly (with a mocked fetch) in router/route.test.ts.
      ROUTER_MODE: "heuristic",
      // Agents fall back to their deterministic paths; no Ollama generation in tests.
      AGENT_LLM: "off",
      MATHPILOT: "off",
      // A fake Groq key so model-on tests can run; every test that turns the model on mocks fetch,
      // so nothing ever reaches Groq (and server/.env's real key is never used).
      GROQ_API_KEY: "gsk_test",
      // Tests never depend on a locally built encyclopedia; knowledge.test.ts builds its own.
      OMNIPILOT_KNOWLEDGE: "/nonexistent/knowledge.sqlite",
    },
    testTimeout: 15000,
  },
});
