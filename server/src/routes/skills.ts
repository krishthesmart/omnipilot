import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { deleteSkill, getSkill, listSkills, parseTime, saveSkill, setDailyAt, skillRequest, slug } from "../lib/skills.js";
import { executeRun } from "../pipeline.js";
import { runDueRoutines } from "../lib/routines.js";
import { logAudit } from "../lib/audit.js";
import { workspaceIndex } from "../lib/fileIndex.js";
import { WORKSPACE_ROOT } from "../lib/workspace.js";

// The Routines and Skills pages: list, create, change, delete and run skills, custom agents and
// daily routines (the same ones InfraPilot creates from chat), and the Workspace page's projects.
export const skillsRouter = Router();

/** Where a skill's results collect: one chat per routine or skill. */
export const skillConversation = (name: string) => `routine-${slug(name)}`;

skillsRouter.get("/skills", (_req, res) => {
  res.json({ skills: listSkills().map((s) => ({ ...s, conversationId: skillConversation(s.name) })) });
});

const time = z.union([z.string().max(20), z.null()]);
const createSchema = z.object({
  name: z.string().min(2).max(60),
  kind: z.enum(["skill", "agent"]).default("skill"),
  instructions: z.string().min(3).max(2000),
  dailyAt: time.optional(),
});

/** "7:30", "07:30", "7am" -> "07:30"; invalid -> undefined. */
function normalizeTime(t: string | null | undefined): string | null | undefined {
  if (t === null) return null;
  if (t === undefined || t === "") return t === "" ? null : undefined;
  if (/^\d{1,2}:\d{2}$/.test(t)) {
    const [h, m] = t.split(":").map(Number);
    return h < 24 && m < 60 ? `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}` : undefined;
  }
  return parseTime(t) ?? undefined;
}

skillsRouter.post("/skills", (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_request", message: "Give it a name and say what it should do." });
  const { name, kind, instructions } = parsed.data;
  const dailyAt = normalizeTime(parsed.data.dailyAt);
  if (parsed.data.dailyAt && dailyAt === undefined) return res.status(400).json({ error: "invalid_time", message: 'Use a time like "07:30" or "7am".' });
  try {
    const s = saveSkill({ name, label: name.trim(), kind, instructions });
    if (dailyAt !== undefined && kind === "skill") setDailyAt(s.name, dailyAt);
    logAudit({ runId: "n/a", agent: "InfraPilot", action: "save_skill", parameters: { name: s.name, kind, dailyAt }, outcome: "saved" });
    res.json({ skill: { ...getSkill(s.name)!, conversationId: skillConversation(s.name) } });
  } catch (e: any) {
    res.status(400).json({ error: "invalid_request", message: e?.message ?? "couldn't save it" });
  }
});

const patchSchema = z.object({ instructions: z.string().min(3).max(2000).optional(), dailyAt: time.optional() });

skillsRouter.patch("/skills/:name", (req, res) => {
  const s = getSkill(req.params.name);
  if (!s) return res.status(404).json({ error: "not_found" });
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_request" });
  if (parsed.data.instructions) saveSkill({ name: s.name, label: s.label, kind: s.kind, instructions: parsed.data.instructions });
  if (parsed.data.dailyAt !== undefined) {
    const t = normalizeTime(parsed.data.dailyAt);
    if (t === undefined) return res.status(400).json({ error: "invalid_time", message: 'Use a time like "07:30" or "7am".' });
    if (s.kind === "agent") return res.status(400).json({ error: "invalid_request", message: "Custom agents can't run on a schedule; make a skill for that." });
    setDailyAt(s.name, t);
  }
  res.json({ skill: { ...getSkill(s.name)!, conversationId: skillConversation(s.name) } });
});

skillsRouter.delete("/skills/:name", (req, res) => {
  if (!deleteSkill(req.params.name)) return res.status(404).json({ error: "not_found" });
  logAudit({ runId: "n/a", agent: "InfraPilot", action: "delete_skill", parameters: { name: req.params.name }, outcome: "deleted" });
  res.json({ ok: true });
});

/** Runs a skill or routine now; the result appears in its chat (returned right away, while it runs). */
skillsRouter.post("/skills/:name/run", (req, res) => {
  const s = getSkill(req.params.name);
  if (!s) return res.status(404).json({ error: "not_found" });
  if (s.kind !== "skill") return res.status(400).json({ error: "invalid_request", message: "Custom agents are talked to in chat." });
  const runId = randomUUID();
  const conversationId = skillConversation(s.name);
  executeRun(skillRequest(s, ""), {}, runId, conversationId).catch((err) => console.error(`Skill ${s.name} failed:`, err));
  res.json({ runId, conversationId });
});

/**
 * Runs routines that are due now. OmniPilot checks every 30 seconds while it's running; this is for
 * hosts that put it to sleep when idle (Cloudflare Containers): their scheduler wakes it with this.
 */
skillsRouter.post("/routines/run-due", async (_req, res) => {
  const ran = await runDueRoutines();
  res.json({ ran });
});

/** The Workspace page: projects OmniPilot recognises in the approved folder. */
skillsRouter.get("/workspace/projects", (_req, res) => {
  const index = workspaceIndex(WORKSPACE_ROOT);
  res.json({
    projects: index.listProjects().map((p) => ({ folder: p.folder, name: p.name, description: p.description, files: p.files.length, sample: p.files.slice(0, 8) })),
    files: index.size(),
  });
});
