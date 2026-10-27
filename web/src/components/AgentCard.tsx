import { useEffect, useState } from "react";
import { ChevronRight, ChevronDown, RotateCcw } from "lucide-react";
import type { AgentResult, AgentStatus, AgentName, CoordinatorStep } from "../types";
import { AGENT_META } from "../agentMeta";
import { STATUS_CLASS, STATUS_LABEL } from "../statusMeta";

export function AgentCard({
  agent,
  status,
  startedAt,
  result,
  step,
}: {
  agent: string;
  status: AgentStatus;
  startedAt?: number;
  result?: AgentResult;
  step?: CoordinatorStep;
}) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (status !== "running") return;
    const id = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(id);
  }, [status]);

  const elapsedMs = result ? result.elapsedMs : startedAt ? now - startedAt : 0;
  const [expanded, setExpanded] = useState(false);
  const meta = AGENT_META[agent as AgentName];
  const Icon = meta?.icon;

  return (
    <div className="agent-card" style={{ ["--agent-color" as any]: meta?.accent }}>
      <div className="agent-card-header" onClick={() => result && setExpanded((e) => !e)}>
        {Icon && (
          <span className="agent-icon">
            <Icon size={15} />
          </span>
        )}
        <span className="agent-name">{agent}</span>
        {(result?.skill ?? step?.skill) && <span className="agent-skill">{result?.skill ?? step?.skill}</span>}
        {status === "running" && <span className="running-dot" />}
        {result?.stopped ? (
          <span className="agent-status-pill">Stopped</span>
        ) : (
          <span className={`agent-status-pill ${STATUS_CLASS[status] ?? ""}`}>{STATUS_LABEL[status] ?? status}</span>
        )}
        <span className="agent-elapsed">{(elapsedMs / 1000).toFixed(1)}s</span>
        {result && <span className="agent-confidence">conf {(result.confidence * 100).toFixed(0)}%</span>}
        {result && <span className="expand-chevron">{expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</span>}
      </div>
      {(step || result?.task) && (
        <div className="agent-task">
          <span className="agent-task-text">{result?.task ?? step?.task}</span>
          {result?.coveringFor && <span className="agent-link">covering for {result.coveringFor}</span>}
          {result?.usedResultsFrom?.length ? (
            <span className="agent-link">used {result.usedResultsFrom.join(", ")}</span>
          ) : !result && step?.dependsOn.length ? (
            <span className="agent-link">waiting for {step.dependsOn.join(", ")}</span>
          ) : !result && step?.afterAll ? (
            <span className="agent-link">runs after the others</span>
          ) : null}
        </div>
      )}
      {expanded && result && (
        <div className="agent-card-body">
          <ul className="findings-list">
            {result.findings.map((f, i) => (
              <li key={i}>{f}</li>
            ))}
          </ul>
          {result.limitations.length > 0 && (
            <div className="limitations">
              <strong>Limitations:</strong>
              <ul>
                {result.limitations.map((l, i) => (
                  <li key={i}>{l}</li>
                ))}
              </ul>
            </div>
          )}
          {result.retries > 0 && (
            <div className="retry-note">
              <RotateCcw size={11} style={{ verticalAlign: "-1px", marginRight: 4 }} />
              Retried {result.retries} time(s) before this result.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
