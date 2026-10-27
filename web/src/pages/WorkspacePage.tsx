import { useEffect, useState } from "react";
import { FolderGit2, MessageSquare, ShieldAlert } from "lucide-react";
import { fetchPendingChanges, fetchProjects, type CodeAlert, type PendingChange, type WorkspaceProject } from "../api";

/** Shortens text at a word boundary, with "…". */
const clip = (text: string, limit: number) => (text.length <= limit ? text : `${text.slice(0, limit - 1).replace(/\s+\S*$/, "").replace(/[.,;:\-–— ]+$/, "")}…`);
import { ApprovalCard } from "../components/ApprovalCard";

// The approved workspace folder: the projects in it (ones CodePilot built and your own), changes
// waiting for your approval, and CodePilot's always-on alerts.
export function WorkspacePage({ onUse, onDraft, onOpenChat, codeAlerts }: { onUse: (text: string) => void; onDraft: (text: string) => void; onOpenChat: (id: string) => void; codeAlerts: CodeAlert[] }) {
  const [projects, setProjects] = useState<WorkspaceProject[] | null>(null);
  const [pending, setPending] = useState<PendingChange[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    fetchProjects()
      .then((r) => setProjects(r.projects))
      .catch((e) => setError(e.message));
    fetchPendingChanges()
      .then(setPending)
      .catch(() => setPending([]));
  };
  useEffect(load, []);

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>
            <FolderGit2 size={20} /> Workspace
          </h1>
          <p>The folder OmniPilot may read and, with your approval, change. Projects CodePilot builds are created here.</p>
        </div>
        <button className="pill-btn primary" onClick={() => onDraft("Build ")}>
          New project…
        </button>
      </header>

      {error && (
        <p className="page-error" role="alert">
          {error}
        </p>
      )}

      {codeAlerts.length > 0 && (
        <div className="page-card alert-card">
          <ShieldAlert size={16} />
          <span>
            CodePilot found {codeAlerts.length} new issue{codeAlerts.length === 1 ? "" : "s"}: {codeAlerts.slice(0, 3).map((a) => `${a.title} (${a.file}:${a.line})`).join("; ")}
          </span>
          <button className="pill-btn" onClick={() => onUse(`Scan ${Array.from(new Set(codeAlerts.map((a) => a.file))).join(", ")} for security bugs and suggest fixes`)}>
            Fix with CodePilot
          </button>
        </div>
      )}

      <section className="page-section">
        <h3>Waiting for your approval</h3>
        {pending === null ? (
          <p className="page-meta">Loading…</p>
        ) : pending.length === 0 ? (
          <p className="page-meta">Nothing waiting.</p>
        ) : (
          <div className="card-list">
            {pending.map((p) => (
              <div key={p.id} className="pending-change">
                {p.request && (
                  <div className="page-meta pending-from">
                    From “{p.request.slice(0, 90)}”
                    {p.conversationId && (
                      <button className="link-btn" onClick={() => onOpenChat(p.conversationId!)}>
                        <MessageSquare size={12} /> open chat
                      </button>
                    )}
                  </div>
                )}
                <ApprovalCard agent={p.agent} action={p.action ?? { id: p.id, description: p.description, riskLevel: p.risk_level, requiresApproval: true }} onDecided={() => setTimeout(load, 1500)} collapsed />
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="page-section">
        <h3>Projects</h3>
        {projects === null ? (
          <p className="page-meta">Loading…</p>
        ) : projects.length === 0 ? (
          <p className="page-meta">No projects yet. Ask CodePilot to build one.</p>
        ) : (
          <div className="project-grid">
            {projects.map((p) => (
              <article key={p.folder} className="page-card project">
                <h2>{p.name}</h2>
                <span className="page-meta">
                  {p.folder}/ · {p.files} file{p.files === 1 ? "" : "s"}
                </span>
                {p.description && <p>{clip(p.description, 180)}</p>}
                <div className="page-actions">
                  <button className="pill-btn" onClick={() => onUse(`Explain how my ${p.name} project works`)}>
                    Explain
                  </button>
                  <button className="pill-btn" onClick={() => onUse(`Check my ${p.name} project for bugs`)}>
                    Check for bugs
                  </button>
                  <button className="pill-btn" onClick={() => onDraft(`Add a feature to my ${p.name} project: `)}>
                    Add a feature…
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
