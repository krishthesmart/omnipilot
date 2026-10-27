"""Deciding an approval (shared by the classic app's API and the workspace). Approving carries the change out;
if it can't be done, nothing is recorded as approved, so the cause can be fixed and it can be approved again.
Denying discards it. Approval authority only ever comes from a person's request, never from model output.

Approvals are bound to exactly what was shown: code changes by the files' checksums (patches.py), external
actions by the payload fingerprint (actions.payload_sha256). A caller that showed a preview passes the
fingerprint it showed; if the stored action differs, it doesn't run."""
from __future__ import annotations

from . import actions, patches, store


class ApprovalError(Exception):
    def __init__(self, status: int, code: str, message: str = ""):
        super().__init__(message or code)
        self.status, self.code, self.message = status, code, message or code


async def decide(id: str, decision: str, expected_sha256: str | None = None, actor: str = "owner") -> dict:
    approval = store.get_approval(id)
    if not approval:
        raise ApprovalError(404, "not_found")
    if approval["status"] != "pending":
        raise ApprovalError(409, "already_decided")
    if decision not in ("approved", "denied"):
        raise ApprovalError(400, "invalid_request")
    run = store.q1("SELECT project_id FROM runs WHERE id = ?", approval["run_id"])
    if run and run["project_id"]:  # inside a project, deciding needs the approve role there
        from . import projects

        try:
            projects.require(run["project_id"], "approve", actor, allow_archived=decision == "denied")
        except projects.ProjectError as e:
            raise ApprovalError(e.status, e.code, e.message) from None
    files = patches.patch_set(id)
    action = actions.get_action(id)
    applied = outcome = None
    if decision == "approved":
        if files:
            result = patches.apply_patch(id)
            store.audit(approval["run_id"], "CodePilot", "apply_fix", {"files": [f["file"] for f in files]}, "applied" if result["ok"] else f"not applied: {result['error']}")
            if not result["ok"]:
                raise ApprovalError(409, result["error"], result["message"])
            applied = {"file": result["file"], "files": result["files"]}
        elif action:
            outcome = await actions.execute_action(id, expected_sha256)
            store.audit(approval["run_id"], approval["agent"], f"run_{action['kind']}", action["params"], outcome["message"] if outcome["ok"] else f"failed: {outcome['message']}")
            if not outcome["ok"]:
                raise ApprovalError(409, outcome.get("code") or "action_failed", outcome["message"])
    else:
        if files:
            patches.reject_patch(id)
        if action:
            actions.reject_action(id)
    store.decide_approval(id, decision)
    store.audit(approval["run_id"], approval["agent"], "approval_decision", {"approvalId": id, "description": approval["description"], "riskLevel": approval["risk_level"]}, decision)
    from . import work

    work.after_approval(id, approval["run_id"], decision, applied, outcome, actor)
    settle_run(approval["run_id"])
    return {**store.get_approval(id), "applied": applied, "outcome": outcome}


def settle_run(run_id: str) -> str | None:
    """A run waits at "needs_approval" only while something is actually waiting. Once the last approval is
    decided, the run is finished: it says so, instead of looking stuck for ever."""
    run = store.get_run(run_id)
    if not run or run["status"] != "needs_approval":
        return None
    if store.q1("SELECT 1 AS x FROM approvals WHERE run_id = ? AND status = 'pending'", run_id):
        return None  # others are still waiting
    data = {**run["data"], "status": "completed"}
    store.save_run(run_id, run["request"], run["created_at"], "completed", data)
    store.audit(run_id, "System", "run_settled", {}, "every approval was decided")
    return "completed"


def preview(id: str) -> dict | None:
    """Permission Preview: exactly what approving will do, to what, what it won't touch, and whether it can be undone.
    The fingerprint shown is what the decision must send back for an external action."""
    approval = store.get_approval(id)
    if not approval:
        return None
    files = patches.patch_set(id)
    if files:
        return {"id": id, "kind": "code_change", "action": "Write code changes to files", "target": [f["file"] for f in files],
                "changes": [{"file": f["file"], "isNew": f["isNew"], "diff": f["diff"]} for f in files],
                "scope": "Only the files listed, all together or not at all",
                "will_not_change": "Any other file; nothing is sent outside this computer",
                "recoverability": "Can be undone from the approval while the files haven't been changed since",
                "binding": "Each file's current checksum is checked before writing; if a file changed since this was proposed, nothing is written",
                "payload_sha256": None, "status": approval["status"], "description": approval["description"], "risk": approval["risk_level"]}
    p = actions.preview(id)
    if p:
        return {**p, "binding": "Approval runs exactly this payload; if it changes, it needs fresh approval", "description": approval["description"], "risk": approval["risk_level"]}
    return {"id": id, "kind": "none", "action": "Nothing to carry out (record only)", "target": "", "changes": [], "scope": "", "will_not_change": "Everything",
            "recoverability": "Nothing to undo", "payload_sha256": None, "status": approval["status"], "description": approval["description"], "risk": approval["risk_level"]}
