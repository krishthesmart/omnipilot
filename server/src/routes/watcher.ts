import { asyncRoute } from "../lib/security.js";
import { Router } from "express";
import { z } from "zod";
import { listWatcherEvents, logWatcherEvent } from "../db.js";
import { logAudit } from "../lib/audit.js";
import {
  AI_DOMAINS,
  AI_EXTENSION_PATTERN,
  DEFAULT_POLICY,
  classifyPage,
  getPolicy,
  hasPin,
  pinLocked,
  savePolicy,
  verifyPin,
  type WatcherPolicy,
} from "../lib/watcher.js";

export const watcherRouter = Router();

/** Public: the extension and the UI read the current rules (never the PIN). */
watcherRouter.get("/watcher/policy", (_req, res) => {
  res.json({ policy: getPolicy(), hasPin: hasPin(), locked: pinLocked(), aiDomains: AI_DOMAINS, aiExtensionPattern: AI_EXTENSION_PATTERN });
});

const policySchema = z.object({
  pin: z.string().max(8),
  newPin: z.string().max(8).optional(),
  policy: z.object({
    active: z.boolean(),
    task: z.string().max(120),
    subject: z.enum(["math", "reading", "writing", "science", "coding", "history", "languages"]).nullable(),
    blockAI: z.boolean(),
    blockAIExtensions: z.boolean(),
    onTaskOnly: z.boolean(),
    allow: z.array(z.string().max(100)).max(100),
    block: z.array(z.string().max(100)).max(100),
    until: z.string().datetime().nullable(),
  }),
});

const normalizeDomain = (d: string) => d.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];

/** Parent only: change the rules. The first save sets the PIN; every later change needs it. */
watcherRouter.post("/watcher/policy", (req, res) => {
  const parsed = policySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
  const { pin, newPin, policy } = parsed.data;
  const clean: WatcherPolicy = {
    ...DEFAULT_POLICY,
    ...policy,
    allow: policy.allow.map(normalizeDomain).filter(Boolean),
    block: policy.block.map(normalizeDomain).filter(Boolean),
  };
  const result = savePolicy(clean, pin, newPin);
  if (!result.ok) return res.status(result.error === "locked" ? 429 : 403).json({ error: result.error });
  logAudit({ runId: "watcher", agent: "WatcherPilot", action: "policy_saved", parameters: { task: clean.task, active: clean.active, until: clean.until }, outcome: "saved" });
  res.json({ policy: getPolicy() });
});

const checkSchema = z.object({ url: z.string().max(2000), title: z.string().max(300).optional() });

/** The extension asks this for every page. */
watcherRouter.post("/watcher/check", asyncRoute(async (req, res) => {
  const parsed = checkSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_request" });
  const decision = await classifyPage(getPolicy(), parsed.data.url, parsed.data.title);
  if (decision.decision === "block") logWatcherEvent({ url: parsed.data.url, title: parsed.data.title, decision: decision.decision, reason: decision.reason });
  res.json(decision);
}));

/** Parent only: what was blocked (it's the child's browsing, so it's behind the PIN). */
watcherRouter.post("/watcher/events", (req, res) => {
  const pin = typeof req.body?.pin === "string" ? req.body.pin : "";
  if (pinLocked()) return res.status(429).json({ error: "locked" });
  if (!verifyPin(pin)) return res.status(403).json({ error: "wrong_pin" });
  res.json({ events: listWatcherEvents(100) });
});
