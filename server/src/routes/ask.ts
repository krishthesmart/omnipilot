import { asyncRoute } from "../lib/security.js";
import { Router } from "express";
import { z } from "zod";
import { randomUUID as uuid } from "node:crypto";
import { executeRun } from "../pipeline.js";
import { grantRunKey } from "../db.js";
import { isSdk, sdkConversation } from "./chat.js";

// One request, one answer: the simplest way to use OmniPilot from a script,
// a Raspberry Pi or an ESP32 (see docs/SDK.md). Streaming clients use
// POST /api/chat + GET /api/runs/:id/events instead.

export const askRouter = Router();

const askSchema = z.object({
  message: z.string().min(1).max(4000),
  conversationId: z.string().min(1).max(100).optional(),
  /** Leave out attachments (pictures, diagrams) to keep the reply small for tiny devices. */
  textOnly: z.boolean().optional(),
});

askRouter.post("/ask", asyncRoute(async (req, res) => {
  const parsed = askSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
  const { message, textOnly } = parsed.data;
  const sdk = isSdk(res);
  const conversationId = sdk ? sdkConversation(parsed.data.conversationId) : parsed.data.conversationId;
  const runId = uuid();
  const runKey = sdk ? grantRunKey(runId) : undefined;
  const record = await executeRun(message, {}, runId, conversationId);
  const final = record.finalResponse;
  res.json({
    runId,
    ...(runKey ? { runKey } : {}),
    status: record.status,
    answer: final?.summary ?? record.review?.clarifyingQuestion ?? "",
    clarifyingQuestion: record.status === "needs_clarification" ? record.review?.clarifyingQuestion : undefined,
    confidence: final?.confidence ?? 0,
    agents: (record.agentResults ?? []).map((r) => ({ agent: r.agent, status: r.status })),
    limitations: final?.limitations ?? [],
    ...(textOnly ? {} : { attachments: final?.attachments ?? [] }),
  });
}));
