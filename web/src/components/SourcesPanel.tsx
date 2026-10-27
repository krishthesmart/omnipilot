import type { Evidence } from "../types";

export function SourcesPanel({ sources }: { sources: Evidence[] }) {
  const real = sources.filter((s) => !s.source.startsWith("connector:"));
  if (real.length === 0) return <p className="empty-note">No evidence was attached to this response.</p>;
  return (
    <ul className="sources-list">
      {real.map((s, i) => (
        <li key={i}>
          <code className="source-tag">{s.source}</code>
          <span className="source-detail">{s.detail}</span>
        </li>
      ))}
    </ul>
  );
}
