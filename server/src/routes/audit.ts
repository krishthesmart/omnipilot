import { Router } from "express";
import { listAudit } from "../db.js";

export const auditRouter = Router();

auditRouter.get("/audit", (req, res) => {
  const runId = typeof req.query.runId === "string" ? req.query.runId : undefined;
  res.json({ entries: listAudit(runId) });
});
