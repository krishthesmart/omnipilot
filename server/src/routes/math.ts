import { Router } from "express";
import { z } from "zod";
import { mathStatus, setMathPaused } from "../lib/math/discovery.js";
import { checkIdentity, extractEquation } from "../lib/math/expr.js";
import { listDiscoveries } from "../db.js";

export const mathRouter = Router();

mathRouter.get("/math/status", (_req, res) => {
  res.json(mathStatus());
});

/** Newest first; `after` returns only discoveries with a larger id (for "new since I last looked"). */
mathRouter.get("/math/discoveries", (req, res) => {
  const limit = Math.min(500, Math.max(1, Number(req.query.limit ?? 100) || 100));
  const after = Math.max(0, Number(req.query.after ?? 0) || 0);
  res.json({ discoveries: listDiscoveries(limit, after) });
});

mathRouter.post("/math/pause", (req, res) => {
  const parsed = z.object({ paused: z.boolean() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_request" });
  setMathPaused(parsed.data.paused);
  res.json(mathStatus());
});

const checkSchema = z.union([
  z.object({ left: z.string().min(1).max(500), right: z.string().min(1).max(500) }),
  z.object({ equation: z.string().min(3).max(1000) }),
]);

mathRouter.post("/math/check", (req, res) => {
  const parsed = checkSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_request" });
  const eq = "equation" in parsed.data ? extractEquation(parsed.data.equation) : parsed.data;
  if (!eq) return res.status(400).json({ error: "no_equation", message: "Write it as left = right." });
  try {
    res.json(checkIdentity(eq.left, eq.right));
  } catch (err: any) {
    res.status(400).json({ error: "unreadable", message: err?.message ?? "couldn't read that" });
  }
});
