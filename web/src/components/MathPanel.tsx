import { useEffect, useState } from "react";
import { Bell, BellOff, Pause, Play, Sigma, X } from "lucide-react";
import { checkEquation, fetchDiscoveries, setMathPaused } from "../api";
import type { Discovery, IdentityCheck, MathStatus } from "../types";

const VERDICT: Record<IdentityCheck["verdict"], string> = { true: "✅ True", false: "❌ Not true", unclear: "⚠️ Can't tell" };

export function MathPanel({
  open,
  onClose,
  status,
  onStatus,
  seenId,
  notify,
  onToggleNotify,
}: {
  open: boolean;
  onClose: () => void;
  status: MathStatus | null;
  onStatus: (s: MathStatus) => void;
  /** Discoveries with a larger id are highlighted as new. */
  seenId: number;
  notify: boolean;
  onToggleNotify: () => void;
}) {
  const [list, setList] = useState<Discovery[]>([]);
  const [equation, setEquation] = useState("");
  const [result, setResult] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    fetchDiscoveries(0, 200).then(setList);
    const id = setInterval(() => fetchDiscoveries(0, 200).then(setList), 15_000);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => {
      clearInterval(id);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  if (!open) return null;

  async function check(e: React.FormEvent) {
    e.preventDefault();
    if (!equation.trim()) return;
    const r = await checkEquation(equation);
    setResult("verdict" in r ? `${VERDICT[r.verdict]}: ${r.detail}` : r.message ?? "Write it as left = right, e.g. sin(x)^2 + cos(x)^2 = 1");
  }

  const pct = status ? Math.round(status.stageProgress * 100) : 0;
  const state = !status
    ? "Connecting…"
    : !status.enabled
      ? "Turned off on this computer (MATHPILOT=off)"
      : status.finished
        ? "Finished every search stage"
        : status.paused
          ? "Paused"
          : "Searching in the background";

  return (
    <div className="integrations-overlay" onClick={onClose}>
      <div className="integrations-panel math-panel" role="dialog" aria-label="Math discoveries" onClick={(e) => e.stopPropagation()}>
        <div className="integrations-header">
          <h3>
            <Sigma size={17} /> Math discoveries
          </h3>
          <button className="close-btn" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <p className="integrations-sub">
          OmniPilot hunts for new formulas for famous constants (π, e, ζ(3), Catalan's G…) all the time, on your computer. Each hit is
          re-checked to at least 20 digits with high-precision arithmetic. These are strong conjectures, not proofs, and many turn out to
          be known already, so check the literature before calling one new.
        </p>

        {status && (
          <>
            <div className="math-stats">
              <span>
                <strong>{state}</strong>
              </span>
              <span>
                <strong>{status.checked.toLocaleString()}</strong> formulas checked
              </span>
              {status.running && status.perSecond > 0 && <span>{status.perSecond.toLocaleString()}/second</span>}
              <span>
                <strong>{status.discoveries}</strong> verified
              </span>
            </div>
            {!status.finished && (
              <>
                <div className="math-progress" aria-label={`Stage ${status.stage} of ${status.stages}, ${pct}% done`}>
                  <div style={{ width: `${pct}%` }} />
                </div>
                <div className="math-meta" style={{ marginBottom: 12 }}>
                  Stage {status.stage} of {status.stages}: {status.stageLabel} ({pct}%)
                </div>
              </>
            )}
            <div className="math-actions">
              {status.enabled && !status.finished && (
                <button className="pill-btn" onClick={async () => onStatus(await setMathPaused(!status.paused))}>
                  {status.paused ? <Play size={13} /> : <Pause size={13} />} {status.paused ? "Resume" : "Pause"}
                </button>
              )}
              {"Notification" in window && (
                <button className={notify ? "pill-btn on" : "pill-btn"} onClick={onToggleNotify}>
                  {notify ? <Bell size={13} /> : <BellOff size={13} />} {notify ? "Notifying me" : "Notify me of discoveries"}
                </button>
              )}
            </div>
          </>
        )}

        <form className="math-check" onSubmit={check}>
          <input value={equation} onChange={(e) => setEquation(e.target.value)} placeholder="Check an identity, e.g. sum(1/n^2, n, 1, inf) = pi^2/6" aria-label="Identity to check" />
          <button className="pill-btn" type="submit">
            Check
          </button>
        </form>
        {result && <p className="math-check-result">{result}</p>}

        <div className="math-list">
          {list.length === 0 && <p className="math-meta">Nothing verified yet. The first results usually appear within a few minutes.</p>}
          {list.map((d) => {
            const [formula, coeffs] = d.text.split("   [");
            return (
              <div key={d.id} className={d.id > seenId ? "math-item new" : "math-item"}>
                <div className="math-formula">{formula}</div>
                <div className="math-meta">
                  {coeffs ? coeffs.replace(/\]$/, "") : ""} · {d.digits} digits · value {d.value.slice(0, 18)}…
                  {d.variants > 1 && ` · ${d.variants - 1} related`} · {new Date(d.at).toLocaleString()}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
