import type { AuditLogEntry } from "../types";

export function AuditPanel({ entries }: { entries: AuditLogEntry[] }) {
  if (entries.length === 0) return <p className="empty-note">No activity recorded yet.</p>;
  return (
    <ul className="audit-list">
      {entries.map((e) => (
        <li key={e.id}>
          <span className="audit-time">{new Date(e.timestamp).toLocaleTimeString()}</span>
          <span className="audit-agent">{e.agent}</span>
          <span className="audit-action">{e.action}</span>
          <span className="audit-outcome">→ {e.outcome}</span>
        </li>
      ))}
    </ul>
  );
}
