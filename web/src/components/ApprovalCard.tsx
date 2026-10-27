import { useEffect, useState } from "react";
import { Check, RotateCcw, X } from "lucide-react";
import { ApprovalError, decideApproval, undoApproval } from "../api";
import type { ProposedAction } from "../types";

/** One line of a unified diff, coloured by what happens to it. */
function DiffLine({ line }: { line: string }) {
  const kind = line.startsWith("+++") || line.startsWith("---") ? "file" : line.startsWith("@@") ? "hunk" : line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "ctx";
  return <span className={`diff-${kind}`}>{line || " "}</span>;
}

export function ApprovalCard({ agent, action, onDecided, collapsed = false, decidedAs }: { agent: string; action: ProposedAction; onDecided?: (decision: "approved" | "denied") => void; /** Start with the preview closed (lists of many changes). */ collapsed?: boolean; /** What the server says was already decided. */ decidedAs?: "approved" | "denied" }) {
  const [decision, setDecision] = useState<"pending" | "approved" | "denied" | "undone">(decidedAs ?? "pending");
  useEffect(() => {
    if (decidedAs) setDecision((d) => (d === "pending" ? decidedAs : d));
  }, [decidedAs]);
  const [applied, setApplied] = useState<string[] | null>(null);
  const [outcome, setOutcome] = useState<{ message: string; url?: string } | null>(null);
  // What kind of change this is: a code diff, a new project, or an action in another service.
  const kind = action.preview?.startsWith("--- a/") || action.preview?.includes("\n--- a/") ? "diff" : action.preview?.startsWith("New folder:") ? "project" : "action";
  const approveLabel = kind === "diff" ? "Apply change" : kind === "project" ? "Create project" : "Approve & run";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function decide(d: "approved" | "denied") {
    setBusy(true);
    setError(null);
    try {
      const r = await decideApproval(action.id, d);
      setDecision(d);
      setApplied(r.applied ? (r.applied.files ?? [r.applied.file]) : null);
      setOutcome(r.outcome ?? null);
      onDecided?.(d);
    } catch (err) {
      setError(err instanceof ApprovalError ? err.message : "Couldn't save your decision. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function undo() {
    setBusy(true);
    setError(null);
    try {
      await undoApproval(action.id);
      setDecision("undone");
    } catch (err) {
      setError(err instanceof ApprovalError ? err.message : "Couldn't undo that.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`approval-card risk-${action.riskLevel} ${decision}`}>
      <div className="approval-main">
        <span className={`approval-risk-pill risk-${action.riskLevel}`}>{action.riskLevel} risk</span>
        <span className="approval-description">{action.description}</span>
      </div>
      {decision === "pending" ? (
        <div className="approval-buttons">
          <button disabled={busy} className="approve-btn" onClick={() => decide("approved")}>
            <Check size={13} /> {approveLabel}
          </button>
          <button disabled={busy} className="deny-btn" onClick={() => decide("denied")}>
            <X size={13} /> {kind === "action" ? "Deny" : "Discard"}
          </button>
        </div>
      ) : (
        <span className={`decision-pill ${decision === "undone" ? "denied" : decision}`}>
          {decision === "undone" ? "Undone" : decision === "approved" ? (applied ? "Applied" : outcome ? "Done" : "Approved") : kind === "action" ? "Denied" : "Discarded"}
        </span>
      )}
      {action.preview && (
        <details className="approval-preview" open={decision === "pending" && !collapsed}>
          <summary>{kind === "action" ? (decision === "pending" ? "Exactly what will be sent" : "What was sent") : decision === "pending" ? "The change it will make" : "The change"}</summary>
          {kind === "action" ? (
            <pre className="approval-plain">{action.preview}</pre>
          ) : (
            <pre className="diff">
              {action.preview.split("\n").map((l, i) => (
                <DiffLine key={i} line={l} />
              ))}
            </pre>
          )}
        </details>
      )}
      {decision === "approved" && applied && (
        <span className="approval-note">
          {applied.length === 1 ? (
            <>
              Applied to <code>{applied[0]}</code>.
            </>
          ) : (
            <>Applied to {applied.length} files.</>
          )}{" "}
          <button className="link-btn" onClick={undo} disabled={busy}>
            <RotateCcw size={12} /> Undo
          </button>
        </span>
      )}
      {decision === "approved" && outcome && (
        <span className="approval-note">
          {outcome.message.split("\n")[0]}{" "}
          {outcome.url && (
            <a href={outcome.url} target="_blank" rel="noreferrer">
              Open
            </a>
          )}
          {outcome.message.includes("\n") && <pre className="approval-plain">{outcome.message.split("\n").slice(1).join("\n").trim()}</pre>}
        </span>
      )}
      {decision === "approved" && !applied && !outcome && <span className="approval-note">Recorded.</span>}
      {decision === "undone" && <span className="approval-note">{applied && applied.length > 1 ? "Every file is back as it was." : "The original file is back."}</span>}
      {error && (
        <span className="approval-note error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
