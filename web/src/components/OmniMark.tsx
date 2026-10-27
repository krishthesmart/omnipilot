import { useEffect, useRef } from "react";

// The OmniPilot mark: four rounded, overlapping shapes around a dark diamond.
// Still when idle; while OmniPilot works, the shapes turn around the center at a
// medium pace, and each one also moves on its own: it swings ahead of and behind
// the others, turns about itself, breathes, and drifts toward and away from the
// center.
//
// How it stays smooth: the individual movements are sine waves multiplied by one
// shared "energy" value, which eases up to 1 when work starts and back down to 0
// when it stops. The turning never jumps, speeds up or reverses: when work stops it
// carries on at its current speed until it nears the upright position, then slows
// evenly to rest exactly upright, so the mark always settles into the still pose. Animation runs on requestAnimationFrame
// and writes SVG transforms directly (no re-renders, no animation library), and
// stops completely once settled. With prefers-reduced-motion it never moves.

interface Shape {
  fill: string;
  d: string;
  /** The shape's middle, for turning and breathing about itself. */
  cx: number;
  cy: number;
  /** Where in each cycle this shape is, so the four don't move in lockstep. */
  phase: number;
}

// Back to front, as in the reference: violet, teal, lavender, then sky on top.
const SHAPES: Shape[] = [
  { fill: "#9381ff", cx: 79.5, cy: 49.5, phase: 0.25, d: "M86.8 30.9L87.2 31.1Q104 42 97 60L97 60Q90 78 72.5 68.3L71.5 67.7Q54 58 61.8 39.6L62.2 38.4Q70 20 86.8 30.9Z" },
  { fill: "#40d9cc", cx: 26.5, cy: 47.5, phase: 0.75, d: "M15 22L15 22Q30 20 41.3 38.9L42.7 41.1Q54 60 38 73L38 73Q22 86 14.6 65.3L7.4 44.7Q0 24 15 22Z" },
  { fill: "#b1a4ff", cx: 52, cy: 75, phase: 0.5, d: "M65 55L65 55Q88 58 74.1 77.6L67.9 86.4Q54 106 39 95L39 95Q24 84 33 68L33 68Q42 52 65 55Z" },
  { fill: "#6cbbf5", cx: 50.7, cy: 26.7, phase: 0, d: "M39.9 7.8L58.1 6.2Q84 4 72.7 27.4L65.3 42.6Q54 66 38.9 44.8L29.1 31.2Q14 10 39.9 7.8Z" },
];

const CENTER = 50;
// Movement sizes at full energy (degrees / viewBox units) and cycle lengths (seconds).
const ORBIT = { deg: 14, period: 2.6 };
const DRIFT = { units: 3.2, period: 2.1 };
const TURN = { deg: 18, period: 2.6 };
/** The shared turn around the center while working: one revolution every 3.6 seconds. */
const SPIN_SPEED = 360 / 3.6;
/** Stopping: the final slow-down lasts this long (seconds). */
const SLOW_DOWN = 1.0;
const BREATHE = { amount: 0.045, period: 2.4 };
/** How quickly energy rises when work starts and falls when it stops (seconds). */
const RISE = 0.45;
const FALL = 0.3;
/** Energy eases toward slightly below zero when stopping, so it reaches still in about 0.9 s instead of creeping. */
const UNDERSHOOT = -0.06;

const TAU = Math.PI * 2;
const wave = (t: number, period: number, phase: number) => Math.sin(TAU * (t / period + phase));

function transformFor(s: Shape, t: number, energy: number, spin: number): string {
  const orbit = spin + energy * ORBIT.deg * wave(t, ORBIT.period, s.phase);
  const drift = energy * DRIFT.units * wave(t, DRIFT.period, s.phase + 0.15);
  const turn = energy * TURN.deg * wave(t, TURN.period, s.phase + 0.4);
  const scale = 1 + energy * BREATHE.amount * wave(t, BREATHE.period, s.phase + 0.6);
  // Drift along the line from the center to the shape's middle.
  const len = Math.hypot(s.cx - CENTER, s.cy - CENTER) || 1;
  const dx = ((s.cx - CENTER) / len) * drift;
  const dy = ((s.cy - CENTER) / len) * drift;
  const f = (n: number) => n.toFixed(3);
  return `rotate(${f(orbit)} ${CENTER} ${CENTER}) translate(${f(dx)} ${f(dy)}) translate(${s.cx} ${s.cy}) rotate(${f(turn)}) scale(${f(scale)}) translate(${-s.cx} ${-s.cy})`;
}

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

export function OmniMark({
  size = 28,
  active = false,
  label,
  className,
}: {
  size?: number;
  /** True while OmniPilot is really working on this answer (thinking, using tools or streaming). */
  active?: boolean;
  /** Give the mark a name when it stands alone (the sidebar). Leave it out when status text nearby says what's happening. */
  label?: string;
  className?: string;
}) {
  const groups = useRef<(SVGGElement | null)[]>([]);
  const activeRef = useRef(active);
  activeRef.current = active;
  const frame = useRef<number | null>(null);
  const energy = useRef(0);
  const clock = useRef(0);
  // The shared turn (degrees) and its speed (degrees per second).
  const spin = useRef(0);
  const spinSpeed = useRef(0);
  /** While settling: the upright angle to stop at, and the steady slow-down that lands there. */
  const settle = useRef<{ to: number; speed: number; brake: number } | null>(null);

  useEffect(() => {
    const reduce = prefersReducedMotion();
    if (reduce || frame.current !== null || (!active && energy.current === 0 && spin.current === 0)) return;
    let last = performance.now();
    const tick = (now: number) => {
      // A hidden tab pauses requestAnimationFrame; never jump ahead when it comes back.
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      clock.current += dt;
      const target = activeRef.current ? 1 : UNDERSHOOT;
      energy.current += (target - energy.current) * (1 - Math.exp(-dt / (activeRef.current ? RISE : FALL)));
      if (energy.current < 0) energy.current = 0;

      let settled = false;
      if (activeRef.current) {
        // Working: ease up to (or back to) medium speed from whatever speed it has now.
        settle.current = null;
        spinSpeed.current += (SPIN_SPEED - spinSpeed.current) * (1 - Math.exp(-dt / RISE));
        spin.current += spinSpeed.current * dt;
      } else {
        // Stopping: the next upright angle at or beyond where an even slow-down from the current speed
        // would end. Keep turning at that speed until the slow-down must begin, then brake evenly.
        if (!settle.current) {
          const speed = Math.max(spinSpeed.current, 0);
          const brakeDistance = (speed * SLOW_DOWN) / 2;
          const to = speed < 5 ? Math.round(spin.current / 360) * 360 : Math.ceil((spin.current + brakeDistance) / 360) * 360;
          settle.current = { to, speed, brake: speed < 5 ? 0 : (speed * speed) / (2 * brakeDistance) };
        }
        const { to, speed, brake } = settle.current;
        const left = to - spin.current;
        if (brake === 0) {
          // Barely started: glide the few degrees back to upright.
          spin.current += left * (1 - Math.exp(-dt / 0.15));
          if (Math.abs(left) < 0.05) spin.current = to;
          spinSpeed.current = 0;
        } else {
          // Under constant braking, the speed that still stops exactly at `to` is sqrt(2 * brake * distance left).
          spinSpeed.current = Math.min(speed, Math.sqrt(2 * brake * Math.max(left, 0)));
          spin.current = Math.min(to, spin.current + Math.max(spinSpeed.current, 0.5) * dt);
        }
        settled = spin.current === to && energy.current === 0;
      }
      // Upright (a whole number of turns) with no energy left is exactly the still pose.
      if (settled) {
        spin.current = 0;
        spinSpeed.current = 0;
        settle.current = null;
        groups.current.forEach((g) => g?.removeAttribute("transform"));
        frame.current = null;
        return;
      }
      SHAPES.forEach((s, i) => groups.current[i]?.setAttribute("transform", transformFor(s, clock.current, energy.current, spin.current)));
      frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);
  }, [active]);

  // Stop the loop if the mark goes away mid-animation.
  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
    },
    []
  );

  return (
    <svg
      className={className ? `omni-mark ${className}` : "omni-mark"}
      width={size}
      height={size}
      // A little room around the still mark; moving shapes may reach slightly past it (overflow is
      // visible), which never changes layout because the box itself has a fixed size.
      viewBox="-4 -4 108 108"
      xmlns="http://www.w3.org/2000/svg"
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true, focusable: false })}
    >
      {SHAPES.map((s, i) => (
        <g key={s.fill} ref={(el) => (groups.current[i] = el)}>
          <path d={s.d} fill={s.fill} />
        </g>
      ))}
      <rect x="44.8" y="44.8" width="10.4" height="10.4" fill="#101322" transform="rotate(45 50 50)" />
    </svg>
  );
}
