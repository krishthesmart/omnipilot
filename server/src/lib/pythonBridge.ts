import type { Express, Request, Response } from "express";
import express from "express";
import { AGENTS } from "../agents/index.js";
import { WORKSPACE_ROOT } from "./workspace.js";
import { createWebTools } from "./web/webTools.js";
import { runEventBus } from "./eventBus.js";
import { withRunContext } from "./recorder.js";
import { AGENT_NAMES, type AgentName, type RunEvent, type RunRecord } from "../types.js";

// While OmniPilot moves to Python (docs/PYTHON_PORT.md, stage 3), the Python engine owns every run:
// it routes, coordinates, composes and reviews, and asks this engine to run the agents that haven't
// been ported yet, one at a time. Only the Python front door can call these routes (per-launch
// internal secret; it never forwards /api/internal/* from clients).

const engineUrl = () => process.env.OMNIPILOT_ENGINE_URL;
const token = () => process.env.OMNIPILOT_INTERNAL_TOKEN ?? "";

/** Runs are owned by the Python engine when the launcher started it in front of this one. */
export const pythonOwnsRuns = () => Boolean(engineUrl() && token() && process.env.OMNIPILOT_BEHIND_FRONT_DOOR === "1" && process.env.OMNIPILOT_RUNS !== "node");

/** Hands a run started here (a skill, a daily routine) to the Python engine and waits for its result. */
export async function runInPython(message: string, context: Record<string, unknown>, runId: string, conversationId?: string): Promise<RunRecord> {
  const res = await fetch(`${engineUrl()}/api/internal/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-omnipilot-internal": token() },
    body: JSON.stringify({ message, context, runId, conversationId, wait: true }),
    signal: AbortSignal.timeout(30 * 60_000),
  });
  if (!res.ok) throw new Error(`The Python engine couldn't run this (HTTP ${res.status}).`);
  return (await res.json()) as RunRecord;
}

function forward(event: RunEvent) {
  fetch(`${engineUrl()}/api/internal/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-omnipilot-internal": token() },
    body: JSON.stringify(event),
    signal: AbortSignal.timeout(5000),
  }).catch(() => {});
}

export function registerPythonBridge(app: Express) {
  // One agent, for a run the Python engine owns. Returns the agent's raw result; the Python side adds
  // timing, retries, approvals and events. Closing the request (Stop, or Python's timeout) stops the agent.
  app.post("/api/internal/agent/:name", express.json({ limit: "4mb" }), async (req: Request, res: Response) => {
    if (!res.locals.viaFrontDoor) return res.status(404).json({ error: "not_found" });
    const name = req.params.name as AgentName;
    if (!AGENT_NAMES.includes(name)) return res.status(404).json({ error: "unknown_agent" });
    const input = req.body?.input;
    if (!input?.runId || typeof input.requestText !== "string") return res.status(400).json({ error: "invalid_request" });
    const controller = new AbortController();
    res.on("close", () => !res.writableFinished && controller.abort());
    const timeoutMs = Math.min(Number(req.body?.timeoutMs) || 60_000, 30 * 60_000);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    // This run's activity-log entries go to the Python engine's live stream.
    const onEvent = (e: RunEvent) => e.runId === input.runId && forward(e);
    runEventBus.on("*", onEvent);
    try {
      const raw = await withRunContext(input.runId, () =>
        Promise.race([
          AGENTS[name](input, { signal: controller.signal, workspaceRoot: WORKSPACE_ROOT, web: createWebTools(input.runId, name, controller.signal) }),
          new Promise<never>((_, reject) => controller.signal.addEventListener("abort", () => reject(Object.assign(new Error("timeout"), { name: "TimeoutError" })))),
        ])
      );
      res.json({ result: raw });
    } catch (err: any) {
      if (!res.headersSent && !res.destroyed) res.status(200).json({ error: err?.name === "TimeoutError" || err?.name === "AbortError" ? "timeout" : "failed", message: String(err?.message ?? "").slice(0, 300) });
    } finally {
      clearTimeout(timer);
      runEventBus.off("*", onEvent);
    }
  });
}
