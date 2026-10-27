import { useState } from "react";

interface Props {
  kind: "cycle" | "steps";
  title: string;
  nodes: { label: string; detail: string }[];
}

/**
 * LearnPilot's interactive diagram: a cycle (parts around a ring, arrows going round) or a
 * sequence of steps. Clicking a part, or focusing it with the keyboard, shows its explanation.
 */
export function ConceptDiagram({ kind, title, nodes }: Props) {
  const [active, setActive] = useState(0);
  const pick = (i: number) => setActive(i);
  const n = nodes.length;

  return (
    <figure className="concept-diagram">
      <figcaption className="concept-title">{title}</figcaption>
      {kind === "cycle" ? (
        <div className="cycle-wrap">
          <svg viewBox="0 0 320 320" className="cycle-svg" aria-hidden="true">
            <defs>
              <marker id="cd-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0,0 L10,5 L0,10 z" fill="currentColor" />
              </marker>
            </defs>
            {nodes.map((_, i) => {
              // Arrows along the ring, from just after one part to just before the next.
              const a1 = (-90 + (360 / n) * i + 360 / n / 4) * (Math.PI / 180);
              const a2 = (-90 + (360 / n) * (i + 1) - 360 / n / 4) * (Math.PI / 180);
              const r = 118;
              return (
                <path
                  key={i}
                  d={`M ${160 + r * Math.cos(a1)} ${160 + r * Math.sin(a1)} A ${r} ${r} 0 0 1 ${160 + r * Math.cos(a2)} ${160 + r * Math.sin(a2)}`}
                  className="cycle-arrow"
                  markerEnd="url(#cd-arrow)"
                />
              );
            })}
          </svg>
          {nodes.map((node, i) => {
            const angle = (-90 + (360 / n) * i) * (Math.PI / 180);
            return (
              <button
                key={i}
                className={i === active ? "cd-node on" : "cd-node"}
                style={{ left: `${50 + 37 * Math.cos(angle)}%`, top: `${50 + 37 * Math.sin(angle)}%` }}
                onClick={() => pick(i)}
                onFocus={() => pick(i)}
                aria-pressed={i === active}
              >
                {node.label}
              </button>
            );
          })}
        </div>
      ) : (
        <ol className="steps-row">
          {nodes.map((node, i) => (
            <li key={i}>
              <button className={i === active ? "cd-node on" : "cd-node"} onClick={() => pick(i)} onFocus={() => pick(i)} aria-pressed={i === active}>
                <span className="cd-num">{i + 1}</span> {node.label}
              </button>
              {i < n - 1 && <span className="steps-arrow" aria-hidden="true">→</span>}
            </li>
          ))}
        </ol>
      )}
      <p className="cd-detail" aria-live="polite">
        <strong>{nodes[active].label}:</strong> {nodes[active].detail}
      </p>
    </figure>
  );
}
