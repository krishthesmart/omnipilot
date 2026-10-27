import { lazy, Suspense, useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import { WiringDiagram } from "./WiringDiagram";
import type { WatcherPolicy } from "../types";
import { AlertTriangle, Download, Square } from "lucide-react";
import { cancelRun, fetchApprovals } from "../api";
import { useRun } from "../hooks/useRun";
import { ApprovalCard } from "./ApprovalCard";
import { ConnectorCard, extractConnectorEntries, type ConnectorEntry } from "./ConnectorCard";
import { OmniMark } from "./OmniMark";
import { Feedback } from "./Feedback";
import { ConceptDiagram } from "./ConceptDiagram";
import { CodeProject } from "./CodeProject";
// three.js is large: load the 3D viewer only when a model is shown.
const Model3DViewer = lazy(() => import("./Model3DViewer"));
import type { Connector } from "../types";

// Plain progress words: which specialists run is the backend's business, not something to show.
const PHASE_LABEL: Record<string, string> = {
  planning: "Thinking…",
  running_agents: "Working on it…",
  synthesizing: "Writing the answer…",
  reviewing: "Checking the answer…",
  clarification_needed: "I need a bit more information.",
  done: "Done",
  failed: "The run failed unexpectedly.",
  cancelled: "Stopped",
};

const ACTIVE_PHASES = new Set(["planning", "running_agents", "synthesizing", "reviewing"]);


export function ChatTurn({
  runId,
  request,
  onFollowUp,
  onOpenWatcher,
  onAnswer,
}: {
  runId: string;
  request: string;
  onFollowUp: (text: string) => void;
  onOpenWatcher: (prefill?: Partial<WatcherPolicy>) => void;
  /** Called once when the answer (or a clarifying question) is ready -- voice mode reads it aloud. */
  onAnswer?: (runId: string, text: string) => void;
}) {
  const state = useRun(runId, request);
  const announced = useRef(false);
  const answerText = state.finalResponse?.summary ?? (state.phase === "clarification_needed" ? state.clarifyingQuestion : undefined);
  useEffect(() => {
    if (answerText && !announced.current) {
      announced.current = true;
      onAnswer?.(runId, answerText);
    }
  }, [answerText, runId, onAnswer]);
  const [clarifyText, setClarifyText] = useState("");
  const [connectorOverrides, setConnectorOverrides] = useState<Record<string, Connector>>({});

  const connectorEntries: ConnectorEntry[] = Object.values(state.agents)
    .flatMap((a) => (a.result ? extractConnectorEntries(a.result.evidence) : []))
    .filter((c, i, arr) => arr.findIndex((x) => x.name === c.name) === i)
    .map((c) => {
      const override = connectorOverrides[c.name];
      return override ? { name: c.name, status: override.status, kind: override.kind, verification: override.verification, accountLabel: override.account_label } : c;
    });

  const pendingActions = Object.values(state.agents).flatMap((a) =>
    a.result ? a.result.proposedActions.filter((act) => act.requiresApproval).map((act) => ({ agent: a.result!.agent, action: act })) : []
  );
  // Decisions already made (in this tab, another tab or before a reload), so a decided change isn't offered again.
  const [decided, setDecided] = useState<Record<string, "approved" | "denied">>({});
  const hasApprovals = pendingActions.length > 0;
  useEffect(() => {
    if (!hasApprovals) return;
    let live = true;
    fetchApprovals(runId)
      .then((list) => live && setDecided(Object.fromEntries(list.filter((a) => a.status !== "pending").map((a) => [a.id, a.status as "approved" | "denied"]))))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [runId, hasApprovals]);

  // Real run state from the server's event stream (useRun): planning, agents and tools running,
  // writing (the answer streams in here), reviewing. Done, stopped, failed or waiting for an answer is not working.
  const working = ACTIVE_PHASES.has(state.phase);
  // Long jobs (deep research, building a project) report what they've done so far.
  const progress = working ? state.audit.filter((e) => e.action.endsWith("_progress")).at(-1)?.outcome : undefined;
  const statusText = working
    ? "OmniPilot is working."
    : state.phase === "done"
      ? "OmniPilot finished."
      : state.phase === "cancelled"
        ? "OmniPilot stopped."
        : state.phase === "failed"
          ? "OmniPilot couldn't finish this answer."
          : state.phase === "clarification_needed"
            ? "OmniPilot needs more information."
            : "";

  return (
    <div className="chat-turn">
      <div className="user-bubble">{request}</div>
      <div className="assistant-turn">
      {/* The mark is decorative: the status line below says what's happening. */}
      <OmniMark size={30} active={working} className="assistant-mark" />
      <div className="assistant-body">
      <span className="sr-only" role="status" aria-live="polite">
        {statusText}
      </span>

      {/* Progress only while working (or when stopped); a finished answer speaks for itself. */}
      {(ACTIVE_PHASES.has(state.phase) || state.phase === "cancelled") && !(state.streamingAnswer && state.phase === "synthesizing") && (
        <div className="pipeline-status">
          <span className={`phase-pill phase-${state.phase}`}>
            {PHASE_LABEL[state.phase] ?? state.phase}
          </span>
          {ACTIVE_PHASES.has(state.phase) && (
            <button className="stop-btn" onClick={() => cancelRun(runId)} aria-label="Stop this answer">
              <Square size={10} fill="currentColor" /> Stop
            </button>
          )}
          {progress && <span className="progress-note">{progress}</span>}
        </div>
      )}



      {connectorEntries.length > 0 && (
        <div className="connectors-row">
          {connectorEntries.map((c) => (
            <ConnectorCard
              key={c.name}
              name={c.name}
              status={c.status}
              kind={c.kind}
              verification={c.verification}
              accountLabel={c.accountLabel}
              onChanged={(updated) => setConnectorOverrides((prev) => ({ ...prev, [updated.name]: updated }))}
            />
          ))}
        </div>
      )}

      {pendingActions.length > 0 && (
        <div className="approvals-row">
          <h4>
            <AlertTriangle size={14} /> Approval needed before any write action
          </h4>
          {pendingActions.map(({ agent, action }) => (
            <ApprovalCard key={action.id} agent={agent} action={action} decidedAs={decided[action.id]} />
          ))}
        </div>
      )}

      {state.phase === "clarification_needed" && state.clarifyingQuestion && (
        <div className="clarification-box">
          <p>{state.clarifyingQuestion}</p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (clarifyText.trim()) onFollowUp(clarifyText.trim());
              setClarifyText("");
            }}
          >
            <input value={clarifyText} onChange={(e) => setClarifyText(e.target.value)} placeholder="Your answer…" autoFocus />
            <button type="submit">Send</button>
          </form>
        </div>
      )}

      {state.phase === "failed" && <div className="error-box">{state.error?.startsWith("OmniPilot was restarted") ? state.error : `Run failed: ${state.error}`}</div>}

      {state.streamingAnswer && !state.finalResponse && (
        <div className="final-answer-block">
          <div className="tab-panel">
            <div className="final-summary markdown streaming">
              <Markdown>{state.streamingAnswer}</Markdown>
            </div>
          </div>
        </div>
      )}

      {state.finalResponse && (
        <div className="final-answer-block">
          <div className="tab-panel">
            <div className="final-summary markdown">
              <Markdown>{state.finalResponse.summary}</Markdown>
            </div>
            {state.finalResponse.attachments?.map((a, i) =>
              a.type === "wiring-diagram" ? (
                <WiringDiagram key={i} spec={a.spec} />
              ) : a.type === "picture" ? (
                <figure key={i} className="picture-card">
                  <img src={a.src} alt={a.title} />
                  <figcaption>
                    <span>
                      <strong>{a.title}</strong>
                      {" · illustration"}
                    </span>
                    <a className="pill-btn" href={a.src} download={`${a.title.replace(/[^\w -]+/g, "").trim() || "picture"}.svg`}>
                      <Download size={13} /> Save
                    </a>
                  </figcaption>
                </figure>
              ) : a.type === "model-3d" ? (
                <Suspense key={i} fallback={<div className="model3d-loading">Loading the 3D viewer…</div>}>
                  <Model3DViewer model={a.model} />
                </Suspense>
              ) : a.type === "code-project" ? (
                <CodeProject key={i} title={a.title} folder={a.folder} files={a.files} checks={a.checks} run={a.run} test={a.test} />
              ) : a.type === "concept-diagram" ? (
                <ConceptDiagram key={i} kind={a.kind} title={a.title} nodes={a.nodes} />
              ) : a.type === "html-preview" ? (
                <figure key={i} className="html-preview">
                  {/* Served by the engine with a sandboxing CSP; this sandbox (no allow-same-origin) isolates it a second time. */}
                  <iframe title={`Preview: ${a.title}`} sandbox="allow-scripts allow-forms allow-modals" src={`/api/runs/${runId}/preview/${i}`} referrerPolicy="no-referrer" />
                  <figcaption>
                    <span>Live preview</span>
                    <a className="pill-btn" href={`data:text/html;charset=utf-8,${encodeURIComponent(a.html)}`} download="page.html">
                      <Download size={13} /> Save .html
                    </a>
                  </figcaption>
                </figure>
              ) : a.type === "watcher-manage" ? (
                <div key={i} className="watcher-setup">
                  <div className="watcher-setup-text">
                    <strong>{a.task ? `Focus session running: "${a.task}"` : "Focus session controls"}</strong>
                    <div>A parent can change or stop it with their PIN.</div>
                  </div>
                  <button className="pill-btn primary" onClick={() => onOpenWatcher()}>
                    Open parent controls
                  </button>
                </div>
              ) : (
                <div key={i} className="watcher-setup">
                  <div className="watcher-setup-text">
                    <strong>Focus session ready: "{a.policy.task}"</strong>
                    <div>A parent confirms it with their PIN{a.blockedExamples.length ? `; it would block ${a.blockedExamples.join(", ")}` : ""}.</div>
                  </div>
                  <button className="pill-btn primary" onClick={() => onOpenWatcher(a.policy)}>
                    Review &amp; confirm
                  </button>
                </div>
              )
            )}
          </div>
          <Feedback runId={runId} />
        </div>
      )}
      </div>
      </div>
    </div>
  );
}
