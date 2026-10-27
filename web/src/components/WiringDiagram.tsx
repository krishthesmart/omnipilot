import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Pause, Play, PlayCircle, AlertTriangle } from "lucide-react";
import type { DiagramSpec } from "../types";

// Interactive wiring diagram: parts and pins are laid out automatically, and
// stepping through the build draws each step's wires in. "Play" runs the
// steps like a short video.

const HEADER_H = 30;
const PIN_H = 24;
const GAP = 22;
const LEFT_X = 20;

/** Box width and column spacing: roomy on wide screens, compact so it still fits on a phone. */
interface Dims {
  boxW: number;
  rightX: number;
  compact: boolean;
}
const WIDE: Dims = { boxW: 210, rightX: 400, compact: false };
const COMPACT: Dims = { boxW: 165, rightX: 255, compact: true };
const STEP_MS = 2800;

const KIND_COLOR: Record<string, string> = {
  board: "#0d9488",
  breadboard: "#64748b",
  led: "#dc2626",
  resistor: "#a16207",
  button: "#2563eb",
  sensor: "#16a34a",
  motor: "#7c3aed",
  device: "#4f46e5",
  port: "#0891b2",
  power: "#475569",
};

interface Placed {
  id: string;
  label: string;
  kind: string;
  x: number;
  y: number;
  h: number;
  side: "left" | "right";
  pins: { id: string; label: string; y: number }[];
}

function layout(spec: DiagramSpec, d: Dims): { placed: Placed[]; height: number } {
  const columns = { left: LEFT_X, right: d.rightX };
  const heights = { left: 0, right: 0 };
  const placed = spec.components.map((c, i) => {
    const side: "left" | "right" = i === 0 ? "left" : "right";
    const h = HEADER_H + c.pins.length * PIN_H + 8;
    const y = heights[side] + 10;
    heights[side] = y + h + GAP - 10;
    return {
      id: c.id,
      label: c.label,
      kind: c.kind,
      x: columns[side],
      y,
      h,
      side,
      pins: c.pins.map((p, j) => ({ ...p, y: y + HEADER_H + j * PIN_H + PIN_H / 2 })),
    };
  });
  // Vertically center the shorter column.
  const diff = heights.left - heights.right;
  for (const p of placed) {
    if (diff > 0 && p.side === "right") shift(p, diff / 2);
    if (diff < 0 && p.side === "left") shift(p, -diff / 2);
  }
  return { placed, height: Math.max(heights.left, heights.right) + 10 };
}

function shift(p: Placed, dy: number) {
  p.y += dy;
  p.pins = p.pins.map((pin) => ({ ...pin, y: pin.y + dy }));
}

function endpoint(placed: Placed[], ref: string, boxW: number) {
  const [cid, pid] = ref.split(".");
  const comp = placed.find((c) => c.id === cid);
  const pin = comp?.pins.find((p) => p.id === pid);
  if (!comp || !pin) return null;
  return { side: comp.side, x: comp.side === "left" ? comp.x + boxW : comp.x, y: pin.y };
}

function wirePath(a: NonNullable<ReturnType<typeof endpoint>>, b: NonNullable<ReturnType<typeof endpoint>>): string {
  if (a.side !== b.side) {
    const [l, r] = a.side === "left" ? [a, b] : [b, a];
    const pull = (r.x - l.x) * 0.45;
    return `M ${l.x} ${l.y} C ${l.x + pull} ${l.y}, ${r.x - pull} ${r.y}, ${r.x} ${r.y}`;
  }
  // Both ends in the same column: leave from the real pin dots and loop through the gap between the columns.
  const toGap = a.side === "right" ? -1 : 1;
  const bulge = 45 + Math.abs(a.y - b.y) * 0.2;
  return `M ${a.x} ${a.y} C ${a.x + toGap * bulge} ${a.y}, ${b.x + toGap * bulge} ${b.y}, ${b.x} ${b.y}`;
}

export function WiringDiagram({ spec }: { spec: DiagramSpec }) {
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(false);
  const canvasRef = useRef<HTMLDivElement>(null);
  const [dims, setDims] = useState<Dims>(WIDE);
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setDims(entry.contentRect.width < 560 ? COMPACT : WIDE));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const boxW = dims.boxW;
  // Roughly how many characters of a pin label fit beside its dot.
  const maxLabel = Math.floor((boxW - 26) / (dims.compact ? 5.6 : 6.2));
  const { placed, height } = useMemo(() => layout(spec, dims), [spec, dims]);
  const last = spec.steps.length - 1;

  useEffect(() => {
    if (!playing) return;
    if (step >= last) {
      setPlaying(false);
      return;
    }
    const t = setTimeout(() => setStep((s) => Math.min(s + 1, last)), STEP_MS);
    return () => clearTimeout(t);
  }, [playing, step, last]);

  const inSomeStep = new Set(spec.steps.flatMap((s) => s.wires));
  const shown = new Set(spec.steps.slice(0, step + 1).flatMap((s) => s.wires));
  const current = new Set(spec.steps[step]?.wires ?? []);
  const viewW = dims.rightX + boxW + 20;

  function play() {
    if (step >= last) setStep(0);
    setPlaying(true);
  }

  return (
    <div className="wiring">
      <div className="wiring-header">
        <strong>{spec.title}</strong>
        {!spec.verified && (
          <span className="wiring-unverified" title="Drafted by the AI model; check each connection against your parts.">
            <AlertTriangle size={12} /> draft, check connections
          </span>
        )}
      </div>

      <div className={dims.compact ? "wiring-canvas compact" : "wiring-canvas"} ref={canvasRef}>
        <svg viewBox={`0 0 ${viewW} ${height}`} role="img" aria-label={`Wiring diagram: ${spec.title}`}>
          {placed.map((c) => (
            <g key={c.id}>
              <rect x={c.x} y={c.y} width={boxW} height={c.h} rx={10} className="wiring-box" />
              <rect x={c.x} y={c.y} width={boxW} height={HEADER_H} rx={10} fill={KIND_COLOR[c.kind] ?? KIND_COLOR.device} />
              <rect x={c.x} y={c.y + HEADER_H - 10} width={boxW} height={10} fill={KIND_COLOR[c.kind] ?? KIND_COLOR.device} />
              <text x={c.x + 12} y={c.y + 20} className="wiring-title">
                {c.label}
              </text>
              {c.pins.map((p) => (
                <g key={p.id}>
                  <text
                    x={c.side === "left" ? c.x + boxW - 14 : c.x + 14}
                    y={p.y + 4}
                    textAnchor={c.side === "left" ? "end" : "start"}
                    className="wiring-pin"
                  >
                    {p.label.length > maxLabel ? `${p.label.slice(0, maxLabel - 1)}…` : p.label}
                    <title>{p.label}</title>
                  </text>
                  <circle cx={c.side === "left" ? c.x + boxW : c.x} cy={p.y} r={4.5} className="wiring-dot" />
                </g>
              ))}
            </g>
          ))}
          {spec.wires.map((w, i) => {
            const a = endpoint(placed, w.from, boxW);
            const b = endpoint(placed, w.to, boxW);
            if (!a || !b) return null;
            const visible = shown.has(i) || !inSomeStep.has(i);
            if (!visible) return null;
            const active = current.has(i);
            return (
              <path
                key={`${i}-${active ? step : "done"}`}
                d={wirePath(a, b)}
                stroke={w.color}
                strokeWidth={active ? 5 : 3}
                fill="none"
                strokeLinecap="round"
                pathLength={1}
                className={active ? "wiring-wire drawing" : "wiring-wire"}
                opacity={active || current.size === 0 ? 1 : 0.55}
              >
                {w.label && <title>{w.label}</title>}
              </path>
            );
          })}
        </svg>
      </div>

      <div className="wiring-step">
        <div className="wiring-step-count">
          Step {step + 1} of {spec.steps.length}
        </div>
        <p>{spec.steps[step]?.text}</p>
        {spec.steps[step]?.tip && <p className="wiring-tip">💡 {spec.steps[step].tip}</p>}
      </div>

      <div className="wiring-controls">
        <button onClick={() => { setPlaying(false); setStep((s) => Math.max(0, s - 1)); }} disabled={step === 0} aria-label="Previous step">
          <ChevronLeft size={16} />
        </button>
        {playing ? (
          <button onClick={() => setPlaying(false)} aria-label="Pause">
            <Pause size={16} /> Pause
          </button>
        ) : (
          <button onClick={play} aria-label="Play all steps">
            <Play size={16} /> {step >= last ? "Replay" : "Play"}
          </button>
        )}
        <button onClick={() => { setPlaying(false); setStep((s) => Math.min(last, s + 1)); }} disabled={step >= last} aria-label="Next step">
          <ChevronRight size={16} />
        </button>
        <input
          type="range"
          min={0}
          max={last}
          value={step}
          onChange={(e) => { setPlaying(false); setStep(Number(e.target.value)); }}
          aria-label="Jump to step"
        />
        <a href={`https://www.youtube.com/results?search_query=${encodeURIComponent(spec.videoQuery)}`} target="_blank" rel="noreferrer" className="wiring-video">
          <PlayCircle size={15} /> Real videos
        </a>
      </div>
    </div>
  );
}
