import { Router } from "express";
import { applyPatch, patchSet, rejectPatch, undoPatch } from "../lib/patches.js";
import { executeAction, getAction, rejectAction } from "../lib/actions.js";
import { asyncRoute } from "../lib/security.js";
import { WORKSPACE_ROOT } from "../orchestrator.js";
import { z } from "zod";
import { decideApproval, getApproval, getRun, listApprovals } from "../db.js";
import { logAudit } from "../lib/audit.js";

export const approvalsRouter = Router();

approvalsRouter.get("/approvals", (req, res) => {
  const runId = typeof req.query.runId === "string" ? req.query.runId : undefined;
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  let approvals = listApprovals(runId);
  if (status) approvals = approvals.filter((a: any) => a.status === status);
  // The Workspace page shows pending changes with their full preview and a link to their chat.
  if (status === "pending") {
    // Only changes OmniPilot can actually carry out (a code change or a stored action); old
    // record-only approvals from earlier versions aren't "waiting" for anything.
    approvals = approvals.filter((a: any) => patchSet(a.id).length > 0 || getAction(a.id));
    approvals = approvals.slice(0, 50).map((a: any) => {
      const run = getRun(a.run_id);
      const action = run?.data?.finalResponse?.nextActions?.find((x: any) => x.id === a.id) ?? run?.data?.agentResults?.flatMap((r: any) => r.proposedActions ?? []).find((x: any) => x.id === a.id);
      return { ...a, action: action ?? null, conversationId: run?.data?.conversationId ?? null, request: run?.request ?? null };
    });
  }
  res.json({ approvals });
});

const decisionSchema = z.object({ decision: z.enum(["approved", "denied"]) });

approvalsRouter.post("/approvals/:id/decision", asyncRoute(async (req, res) => {
  const approval = getApproval(req.params.id);
  if (!approval) return res.status(404).json({ error: "not_found" });
  if (approval.status !== "pending") return res.status(409).json({ error: "already_decided" });

  const parsed = decisionSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_request" });

  // Approving carries the action out: a code change is written (only if every file is unchanged and
  // in the workspace), anything else (Slack, GitHub, Notion, Gmail draft, MCP) runs once with the
  // parameters stored when it was proposed. If it can't be done, nothing is recorded as approved,
  // so the user can fix the cause and approve again. Denying discards it.
  const files = patchSet(req.params.id);
  const action = getAction(req.params.id);
  let applied: { file: string; files: string[] } | null = null;
  let outcome: { ok: boolean; message: string; url?: string } | null = null;
  if (parsed.data.decision === "approved") {
    if (files.length) {
      const result = applyPatch(req.params.id, WORKSPACE_ROOT);
      logAudit({ runId: approval.run_id, agent: "CodePilot", action: "apply_fix", parameters: { files: files.map((f) => f.file) }, outcome: result.ok ? "applied" : `not applied: ${result.error}` });
      if (!result.ok) return res.status(409).json({ error: result.error, message: result.message });
      applied = { file: result.file, files: result.files };
    } else if (action) {
      outcome = await executeAction(req.params.id);
      logAudit({ runId: approval.run_id, agent: approval.agent, action: `run_${action.kind}`, parameters: action.params, outcome: outcome.ok ? outcome.message : `failed: ${outcome.message}` });
      if (!outcome.ok) return res.status(409).json({ error: "action_failed", message: outcome.message });
    }
  } else {
    if (files.length) rejectPatch(req.params.id);
    if (action) rejectAction(req.params.id);
  }

  decideApproval(req.params.id, parsed.data.decision);
  logAudit({
    runId: approval.run_id,
    agent: approval.agent,
    action: "approval_decision",
    parameters: { approvalId: req.params.id, description: approval.description, riskLevel: approval.risk_level },
    outcome: parsed.data.decision,
  });

  res.json({ ...getApproval(req.params.id), applied, outcome });
}));

// Undo an applied CodePilot fix: the original file comes back (if nobody edited it since).
approvalsRouter.post("/approvals/:id/undo", (req, res) => {
  const result = undoPatch(req.params.id, WORKSPACE_ROOT);
  logAudit({ runId: getApproval(req.params.id)?.run_id ?? "n/a", agent: "CodePilot", action: "undo_fix", parameters: { approvalId: req.params.id }, outcome: result.ok ? "undone" : `not undone: ${result.error}` });
  if (!result.ok) return res.status(result.error === "not_found" ? 404 : 409).json({ error: result.error, message: result.message });
  res.json({ ok: true, file: result.file, files: result.files });
});
