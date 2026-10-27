import { Router } from "express";
import { conversationRuns, deleteConversation, listConversations } from "../db.js";
import { cancelRun } from "../lib/runControl.js";

// Chat history for the sidebar, and the Stop button.

export const conversationsRouter = Router();

conversationsRouter.get("/conversations", (_req, res) => {
  res.json({ conversations: listConversations() });
});

conversationsRouter.get("/conversations/:id", (req, res) => {
  res.json({ id: req.params.id, turns: conversationRuns(req.params.id) });
});

conversationsRouter.delete("/conversations/:id", (req, res) => {
  res.json({ deleted: deleteConversation(req.params.id) });
});

conversationsRouter.post("/runs/:id/cancel", (req, res) => {
  res.json({ cancelled: cancelRun(req.params.id) });
});
