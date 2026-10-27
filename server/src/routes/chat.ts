import { Router } from "express";
import { z } from "zod";
import { randomUUID as uuid } from "node:crypto";
import { executeRun } from "../pipeline.js";
import { getRun, grantRunKey, listRuns, runKeyMatches } from "../db.js";
import type { Response } from "express";
import { recordFeedback } from "../lib/learning.js";
import { logAgentAction } from "../agents/base.js";

/**
 * SDK clients (token holders) are a different party from the person at this computer: they may
 * read only runs they started (proved by the run's key, sent as x-run-key), and their conversations
 * are kept apart from the local user's.
 */
export const isSdk = (res: Response) => res.locals.principal === "sdk";
export const sdkConversation = (conversationId: string | undefined) => (conversationId ? `sdk:${conversationId}` : undefined);
const runKeyHeader = "x-run-key";
import { runEventBus } from "../lib/eventBus.js";
import type { RunEvent, RunRecord } from "../types.js";

/** The events a finished run would have sent, rebuilt from its saved record. */
function replayEvents(run: RunRecord): RunEvent[] {
  const runId = run.id;
  const events: RunEvent[] = [{ type: "run_started", runId, request: run.request }];
  if (run.standaloneRequest) events.push({ type: "followup_resolved", runId, original: run.request, standalone: run.standaloneRequest });
  if (run.plan) events.push({ type: "router_plan", runId, plan: run.plan });
  if (run.steps) events.push({ type: "coordinator_plan", runId, steps: run.steps });
  for (const result of run.agentResults ?? []) events.push({ type: "agent_complete", runId, result });
  if (run.review) events.push({ type: "router_review", runId, review: run.review });
  if (run.finalResponse) events.push({ type: "final_response", runId, response: run.finalResponse });
  else if (run.status === "needs_clarification" && run.review?.clarifyingQuestion) events.push({ type: "clarification_needed", runId, question: run.review.clarifyingQuestion });
  else if (run.status === "cancelled") events.push({ type: "run_cancelled", runId });
  else if (run.status === "failed") events.push({ type: "run_failed", runId, error: "This run failed." });
  // Still "running" but not in memory: the server restarted mid-run.
  else events.push({ type: "run_failed", runId, error: "OmniPilot was restarted before this answer finished. Ask again." });
  return events;
}

export const chatRouter = Router();

const chatRequestSchema = z.object({
  message: z.string().min(1).max(4000),
  context: z.record(z.unknown()).optional(),
  /** Groups messages into one conversation so follow-ups can refer back. */
  conversationId: z.string().min(1).max(100).optional(),
  /** A text file the user attached (lesson notes, a chapter...): agents can teach and quiz from it. */
  attachment: z.object({ name: z.string().min(1).max(120), text: z.string().min(1).max(60_000) }).optional(),
});

/** Context keys OmniPilot sets itself; a client can't supply them. */
const RESERVED_CONTEXT = ["customAgent", "previousTurn", "originalRequest", "attachedFile", "priorResults", "conversationId"];

chatRouter.post("/chat", (req, res) => {
  const parsed = chatRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
  }
  const { message } = parsed.data;
  const context: Record<string, unknown> = Object.fromEntries(Object.entries(parsed.data.context ?? {}).filter(([k]) => !RESERVED_CONTEXT.includes(k)));
  if (parsed.data.attachment) context.attachedFile = parsed.data.attachment;
  const sdk = isSdk(res);
  const conversationId = sdk ? sdkConversation(parsed.data.conversationId) : parsed.data.conversationId;

  // Generate the runId here (synchronously) so the client can attach to the
  // SSE stream for it immediately -- the pipeline is kicked off afterwards
  // and reported on in the background, never blocking this response.
  const runId = uuid();
  res.status(202).json(sdk ? { runId, runKey: grantRunKey(runId) } : { runId });
  executeRun(message, context, runId, conversationId).catch((err) => {
    console.error(`Run ${runId} failed unexpectedly:`, err);
  });
});

chatRouter.get("/runs", (_req, res) => {
  if (isSdk(res)) return res.status(403).json({ error: "forbidden_for_token" });
  res.json({ runs: listRuns() });
});

chatRouter.get("/runs/:id", (req, res) => {
  // Not found (rather than forbidden), so a token can't even probe which run IDs exist.
  if (isSdk(res) && !runKeyMatches(req.params.id, req.headers[runKeyHeader])) return res.status(404).json({ error: "not_found" });
  const run = getRun(req.params.id);
  if (!run) return res.status(404).json({ error: "not_found" });
  res.json(run.data);
});

// Thumbs up/down on an answer: OmniPilot learns from it (see lib/learning.ts).
chatRouter.post("/runs/:id/feedback", async (req, res) => {
  if (isSdk(res)) return res.status(403).json({ error: "forbidden_for_token" });
  const rating = req.body?.rating === 1 ? 1 : req.body?.rating === -1 ? -1 : null;
  if (!rating) return res.status(400).json({ error: "bad_rating", message: "rating must be 1 or -1" });
  const run = getRun(req.params.id);
  if (!run?.data?.finalResponse) return res.status(404).json({ error: "not_found" });
  const comment = typeof req.body?.comment === "string" ? req.body.comment : "";
  const lesson = await recordFeedback(req.params.id, rating, comment, run.data.standaloneRequest ?? run.request, run.data.finalResponse.summary ?? "");
  logAgentAction(req.params.id, "System", "feedback", { rating }, lesson ? `learned: ${lesson.lesson}` : rating === 1 ? "thumbs up" : "thumbs down");
  res.json({ ok: true, lesson: lesson ? { id: lesson.id, lesson: lesson.lesson } : null });
});

// A web page CodePilot wrote in this run, for the chat's sandboxed preview frame (headers: PREVIEW_CSP).
chatRouter.get("/runs/:id/preview/:n", (req, res) => {
  if (isSdk(res)) return res.status(404).json({ error: "not_found" });
  const attachments = (getRun(req.params.id)?.data?.finalResponse?.attachments ?? []) as { type: string; html?: string }[];
  const page = attachments[Number(req.params.n)];
  if (page?.type !== "html-preview" || typeof page.html !== "string") return res.status(404).json({ error: "not_found" });
  res.type("html").send(page.html);
});

const TERMINAL = new Set(["final_response", "clarification_needed", "run_cancelled", "run_failed"]);

/**
 * The same events as a plain JSON list, for connections that can't stream (Cloudflare's free quick
 * tunnels don't pass server-sent events): the app asks for what's new every second.
 */
chatRouter.get("/runs/:id/events.json", (req, res) => {
  const runId = req.params.id;
  if (isSdk(res) && !runKeyMatches(runId, req.headers[runKeyHeader])) return res.status(404).json({ error: "not_found" });
  const after = Math.max(0, Number(req.query.after) || 0);
  let events = runEventBus.getHistory(runId);
  if (events.length === 0) {
    const saved = getRun(runId)?.data as RunRecord | undefined;
    if (!saved) return res.status(404).json({ error: "not_found" });
    events = replayEvents(saved);
  }
  res.setHeader("Cache-Control", "no-store");
  res.json({ events: events.slice(after), next: events.length, done: events.some((e) => TERMINAL.has(e.type)) });
});

chatRouter.get("/runs/:id/events", (req, res) => {
  const runId = req.params.id;
  if (isSdk(res) && !runKeyMatches(runId, req.headers[runKeyHeader])) return res.status(404).json({ error: "not_found" });
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const send = (data: unknown) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const history = runEventBus.getHistory(runId);
  for (const evt of history) send(evt);
  // A run from before a restart (a chat reopened from history): replay it from the database.
  if (history.length === 0) {
    const saved = getRun(runId)?.data as RunRecord | undefined;
    if (saved) {
      // (A live run always has events in memory, so a saved run without them is finished or was cut off.)
      for (const evt of replayEvents(saved)) send(evt);
      return res.end();
    }
  }

  const unsubscribe = runEventBus.subscribe(runId, send);
  const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 15000);

  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});
