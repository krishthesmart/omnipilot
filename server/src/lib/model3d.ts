// ModelPilot's 3D models: a scene made of named parts (primitive shapes), which the app renders
// with three.js so it can be rotated, taken apart (exploded view), clicked part by part, and
// exported for 3D printing (STL) or other 3D tools (GLB).
// Everything an AI writes is validated and clamped here, and checked for parts that float in the
// air (not touching anything), which is the most common mistake in generated models.

export type Shape = "box" | "sphere" | "cylinder" | "cone" | "torus" | "capsule";
export type Material = "plastic" | "metal" | "glass" | "rubber" | "wood" | "emissive" | "matte";

export interface Part {
  id: string;
  name: string;
  /** What this part is and what it does (shown when the part is clicked). */
  description: string;
  shape: Shape;
  /**
   * box: [width, height, depth] · sphere: [radius] · cylinder: [radiusTop, height, radiusBottom]
   * cone: [radius, height] · torus: [radius, tube] · capsule: [radius, length]
   */
  size: number[];
  position: [number, number, number];
  /** Degrees around x, y, z (applied in that order). */
  rotation: [number, number, number];
  color: string;
  material: Material;
  /** The subsystem it belongs to ("engine", "landing gear"), for the parts list. */
  group: string;
}

export interface Model3D {
  title: string;
  description: string;
  units: string;
  parts: Part[];
  /** Separate pieces are intended (molecules, solar systems, exploded kits): skip the floating-parts check. */
  separate?: boolean;
  notes?: string[];
}

const SHAPES: Shape[] = ["box", "sphere", "cylinder", "cone", "torus", "capsule"];
const MATERIALS: Material[] = ["plastic", "metal", "glass", "rubber", "wood", "emissive", "matte"];
export const MAX_PARTS = 150;

const num = (v: unknown, fallback: number, min = -1e4, max = 1e4) => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
const vec3 = (v: unknown, fallback: number): [number, number, number] => {
  const a = Array.isArray(v) ? v : [];
  return [num(a[0], fallback), num(a[1], fallback), num(a[2], fallback)];
};
const SIZE_LEN: Record<Shape, number> = { box: 3, sphere: 1, cylinder: 3, cone: 2, torus: 2, capsule: 2 };
const DEFAULT_SIZE: Record<Shape, number[]> = { box: [1, 1, 1], sphere: [0.5], cylinder: [0.5, 1, 0.5], cone: [0.5, 1], torus: [0.5, 0.15], capsule: [0.3, 1] };

/** A safe, complete model from whatever the AI returned (or null if there's nothing usable). */
export function validateModel(raw: any): Model3D | null {
  if (!raw || !Array.isArray(raw.parts)) return null;
  const ids = new Set<string>();
  const parts: Part[] = [];
  for (const [i, p] of raw.parts.slice(0, MAX_PARTS).entries()) {
    if (!p || typeof p !== "object") continue;
    const shape: Shape = SHAPES.includes(p.shape) ? p.shape : "box";
    const sizeIn = Array.isArray(p.size) ? p.size : [];
    const size = DEFAULT_SIZE[shape].map((d, k) => num(sizeIn[k], d, 0.001, 1e4)).slice(0, SIZE_LEN[shape]);
    let id = String(p.id ?? p.name ?? `part-${i + 1}`).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || `part-${i + 1}`;
    while (ids.has(id)) id = `${id}-${i + 1}`;
    ids.add(id);
    parts.push({
      id,
      name: String(p.name ?? id).slice(0, 60),
      description: String(p.description ?? "").slice(0, 400),
      shape,
      size,
      position: vec3(p.position, 0),
      rotation: vec3(p.rotation, 0).map((d) => ((d % 360) + 360) % 360) as [number, number, number],
      color: /^#[0-9a-f]{6}$/i.test(String(p.color)) ? String(p.color) : /^#[0-9a-f]{3}$/i.test(String(p.color)) ? `#${String(p.color).slice(1).split("").map((c) => c + c).join("")}` : "#9aa4b2",
      material: MATERIALS.includes(p.material) ? p.material : "plastic",
      group: String(p.group ?? "parts").slice(0, 40),
    });
  }
  if (!parts.length) return null;
  return {
    title: String(raw.title ?? "3D model").slice(0, 80),
    description: String(raw.description ?? "").slice(0, 600),
    units: String(raw.units ?? "cm").slice(0, 10),
    parts,
    separate: Boolean(raw.separate),
    notes: Array.isArray(raw.notes) ? raw.notes.slice(0, 8).map((n: unknown) => String(n).slice(0, 300)) : [],
  };
}

// --- geometry ---

type V3 = [number, number, number];
const rad = (d: number) => (d * Math.PI) / 180;

function rotate([x, y, z]: V3, [rx, ry, rz]: V3): V3 {
  // Euler XYZ (three.js default): v' = Rx * Ry * Rz * v, applied as z first, then y, then x.
  let [a, b, c] = [x, y, z];
  [a, b] = [a * Math.cos(rad(rz)) - b * Math.sin(rad(rz)), a * Math.sin(rad(rz)) + b * Math.cos(rad(rz))];
  [a, c] = [a * Math.cos(rad(ry)) + c * Math.sin(rad(ry)), -a * Math.sin(rad(ry)) + c * Math.cos(rad(ry))];
  [b, c] = [b * Math.cos(rad(rx)) - c * Math.sin(rad(rx)), b * Math.sin(rad(rx)) + c * Math.cos(rad(rx))];
  return [a, b, c];
}

/** Half-extents of a part's shape before rotation. */
function halfExtents(p: Part): V3 {
  const s = p.size;
  switch (p.shape) {
    case "box":
      return [s[0] / 2, s[1] / 2, s[2] / 2];
    case "sphere":
      return [s[0], s[0], s[0]];
    case "cylinder": {
      const r = Math.max(s[0], s[2]);
      return [r, s[1] / 2, r];
    }
    case "cone":
      return [s[0], s[1] / 2, s[0]];
    case "torus":
      return [s[0] + s[1], s[0] + s[1], s[1]];
    case "capsule":
      return [s[0], s[1] / 2 + s[0], s[0]];
  }
}

/** Axis-aligned bounding box of a part, with its rotation. */
export function partBox(p: Part): { min: V3; max: V3 } {
  const [hx, hy, hz] = halfExtents(p);
  const min: V3 = [Infinity, Infinity, Infinity];
  const max: V3 = [-Infinity, -Infinity, -Infinity];
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
    const c = rotate([sx * hx, sy * hy, sz * hz], p.rotation);
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], c[k] + p.position[k]);
      max[k] = Math.max(max[k], c[k] + p.position[k]);
    }
  }
  return { min, max };
}

export function modelBounds(m: Model3D): { min: V3; max: V3; size: number } {
  const boxes = m.parts.map(partBox);
  const min = [0, 1, 2].map((k) => Math.min(...boxes.map((b) => b.min[k]))) as V3;
  const max = [0, 1, 2].map((k) => Math.max(...boxes.map((b) => b.max[k]))) as V3;
  return { min, max, size: Math.max(...[0, 1, 2].map((k) => max[k] - min[k])) };
}

/**
 * Parts that don't touch the main body: the model's parts are grouped into pieces that touch
 * (bounding boxes overlap, with a small tolerance); everything outside the biggest piece floats.
 */
export function floatingParts(m: Model3D): Part[] {
  if (m.separate || m.parts.length < 2) return [];
  const boxes = m.parts.map(partBox);
  const tol = modelBounds(m).size * 0.02;
  const touches = (a: number, b: number) => [0, 1, 2].every((k) => boxes[a].min[k] - tol <= boxes[b].max[k] && boxes[b].min[k] - tol <= boxes[a].max[k]);
  const piece = new Array(m.parts.length).fill(-1);
  let pieces = 0;
  for (let i = 0; i < m.parts.length; i++) {
    if (piece[i] >= 0) continue;
    const stack = [i];
    piece[i] = pieces;
    while (stack.length) {
      const a = stack.pop()!;
      for (let b = 0; b < m.parts.length; b++) if (piece[b] < 0 && touches(a, b)) (piece[b] = pieces), stack.push(b);
    }
    pieces++;
  }
  if (pieces < 2) return [];
  const sizes = new Array(pieces).fill(0);
  for (const p of piece) sizes[p]++;
  const main = sizes.indexOf(Math.max(...sizes));
  return m.parts.filter((_, i) => piece[i] !== main);
}

/** Puts the model's lowest point at y = 0 and centres it, so it sits on the viewer's floor. */
export function groundModel(m: Model3D): Model3D {
  const b = modelBounds(m);
  const dx = -(b.min[0] + b.max[0]) / 2;
  const dy = -b.min[1];
  const dz = -(b.min[2] + b.max[2]) / 2;
  const r = (n: number) => Math.round(n * 1e4) / 1e4;
  return { ...m, parts: m.parts.map((p) => ({ ...p, position: [r(p.position[0] + dx), r(p.position[1] + dy), r(p.position[2] + dz)] as V3 })) };
}

// --- molecules, with real bond lengths and angles ---

/** CPK colours and (scaled) radii, in Ångström. */
const ATOMS: Record<string, { color: string; r: number; name: string }> = {
  H: { color: "#f5f5f5", r: 0.31, name: "hydrogen" },
  C: { color: "#333333", r: 0.7, name: "carbon" },
  N: { color: "#3050f8", r: 0.65, name: "nitrogen" },
  O: { color: "#ff0d0d", r: 0.6, name: "oxygen" },
  Cl: { color: "#1ff01f", r: 0.99, name: "chlorine" },
  Na: { color: "#ab5cf2", r: 1.0, name: "sodium" },
  S: { color: "#ffff30", r: 1.0, name: "sulfur" },
};

interface MoleculeSpec {
  title: string;
  formula: string;
  atoms: { el: string; at: V3 }[];
  bonds: [number, number, number][]; // a, b, order
  facts: string;
}

const TETRA = Math.acos(-1 / 3); // 109.47°
function polar(len: number, theta: number, phi: number): V3 {
  return [len * Math.sin(theta) * Math.cos(phi), len * Math.cos(theta), len * Math.sin(theta) * Math.sin(phi)];
}

function benzene(): MoleculeSpec {
  const atoms: { el: string; at: V3 }[] = [];
  const bonds: [number, number, number][] = [];
  for (let i = 0; i < 6; i++) {
    const a = (i * Math.PI) / 3;
    atoms.push({ el: "C", at: [1.39 * Math.cos(a), 0, 1.39 * Math.sin(a)] });
  }
  for (let i = 0; i < 6; i++) {
    const a = (i * Math.PI) / 3;
    atoms.push({ el: "H", at: [2.48 * Math.cos(a), 0, 2.48 * Math.sin(a)] });
    bonds.push([i, (i + 1) % 6, i % 2 ? 1 : 2], [i, i + 6, 1]);
  }
  return { title: "Benzene", formula: "C6H6", atoms, bonds, facts: "A flat ring of six carbons; every C–C bond is 1.39 Å (between a single and a double bond, because the electrons are shared around the ring) and every angle is 120°." };
}

export const MOLECULES: Record<string, () => MoleculeSpec> = {
  water: () => {
    const half = rad(104.5 / 2);
    return { title: "Water", formula: "H2O", atoms: [{ el: "O", at: [0, 0, 0] }, { el: "H", at: [0.958 * Math.sin(half), -0.958 * Math.cos(half), 0] }, { el: "H", at: [-0.958 * Math.sin(half), -0.958 * Math.cos(half), 0] }], bonds: [[0, 1, 1], [0, 2, 1]], facts: "Bent shape: the H–O–H angle is 104.5° and each O–H bond is 0.96 Å. The two lone pairs on oxygen push the hydrogens closer together than a perfect tetrahedron (109.5°)." };
  },
  "carbon dioxide": () => ({ title: "Carbon dioxide", formula: "CO2", atoms: [{ el: "C", at: [0, 0, 0] }, { el: "O", at: [1.16, 0, 0] }, { el: "O", at: [-1.16, 0, 0] }], bonds: [[0, 1, 2], [0, 2, 2]], facts: "Linear (180°), with two C=O double bonds of 1.16 Å. The molecule is symmetric, so it has no overall polarity." }),
  methane: () => {
    const atoms: { el: string; at: V3 }[] = [{ el: "C", at: [0, 0, 0] }, { el: "H", at: [0, 1.09, 0] }];
    for (let i = 0; i < 3; i++) atoms.push({ el: "H", at: polar(1.09, TETRA, (i * 2 * Math.PI) / 3) });
    return { title: "Methane", formula: "CH4", atoms, bonds: [[0, 1, 1], [0, 2, 1], [0, 3, 1], [0, 4, 1]], facts: "Tetrahedral: four C–H bonds of 1.09 Å, all 109.5° apart -- as far from each other as four bonds can get." };
  },
  ammonia: () => {
    const theta = Math.PI - rad(68); // gives an H–N–H angle of about 107°
    const atoms: { el: string; at: V3 }[] = [{ el: "N", at: [0, 0, 0] }];
    for (let i = 0; i < 3; i++) atoms.push({ el: "H", at: polar(1.01, theta, (i * 2 * Math.PI) / 3) });
    return { title: "Ammonia", formula: "NH3", atoms, bonds: [[0, 1, 1], [0, 2, 1], [0, 3, 1]], facts: "Trigonal pyramid: three N–H bonds of 1.01 Å at about 107°, with a lone pair on top of the nitrogen." };
  },
  oxygen: () => ({ title: "Oxygen", formula: "O2", atoms: [{ el: "O", at: [-0.604, 0, 0] }, { el: "O", at: [0.604, 0, 0] }], bonds: [[0, 1, 2]], facts: "Two oxygen atoms joined by a double bond 1.21 Å long." }),
  nitrogen: () => ({ title: "Nitrogen", formula: "N2", atoms: [{ el: "N", at: [-0.55, 0, 0] }, { el: "N", at: [0.55, 0, 0] }], bonds: [[0, 1, 3]], facts: "A triple bond (1.10 Å), one of the strongest bonds in chemistry, which is why nitrogen gas is so unreactive." }),
  hydrogen: () => ({ title: "Hydrogen", formula: "H2", atoms: [{ el: "H", at: [-0.37, 0, 0] }, { el: "H", at: [0.37, 0, 0] }], bonds: [[0, 1, 1]], facts: "The simplest molecule: two hydrogen atoms sharing two electrons, 0.74 Å apart." }),
  "hydrogen chloride": () => ({ title: "Hydrogen chloride", formula: "HCl", atoms: [{ el: "H", at: [-0.64, 0, 0] }, { el: "Cl", at: [0.64, 0, 0] }], bonds: [[0, 1, 1]], facts: "A polar bond 1.27 Å long; dissolved in water it becomes hydrochloric acid." }),
  benzene,
};

const MOLECULE_NAMES: Record<string, string> = { h2o: "water", co2: "carbon dioxide", ch4: "methane", nh3: "ammonia", o2: "oxygen", n2: "nitrogen", h2: "hydrogen", hcl: "hydrogen chloride", c6h6: "benzene" };

/** The molecule a request names ("a model of water", "CO2 molecule"), if ModelPilot knows it exactly. */
export function moleculeIn(text: string): string | null {
  if (!/\b(molecule|molecular|atoms?|bonds?|chemical|compound)\b/i.test(text) && !/\b(h2o|co2|ch4|nh3|c6h6|hcl)\b/i.test(text)) return null;
  const formula = /\b(h2o|co2|ch4|nh3|o2|n2|h2|hcl|c6h6)\b/i.exec(text)?.[1]?.toLowerCase();
  if (formula) return MOLECULE_NAMES[formula];
  return Object.keys(MOLECULES).find((name) => new RegExp(`\\b${name}\\b`, "i").test(text)) ?? null;
}

/** Euler angles (degrees, XYZ) that turn the +y axis to point along `v`. */
export function alignY(v: V3): V3 {
  const len = Math.hypot(...v) || 1;
  const [x, y, z] = [v[0] / len, v[1] / len, v[2] / len];
  // Quaternion from (0,1,0) to (x,y,z).
  const dot = y;
  let q: [number, number, number, number];
  if (dot < -0.999999) q = [1, 0, 0, 0];
  else {
    const axis: V3 = [z, 0, -x]; // (0,1,0) x v
    const w = 1 + dot;
    const n = Math.hypot(axis[0], axis[1], axis[2], w);
    q = [axis[0] / n, axis[1] / n, axis[2] / n, w / n];
  }
  const [qx, qy, qz, qw] = q;
  // Rotation matrix -> Euler XYZ (as three.js does).
  const m11 = 1 - 2 * (qy * qy + qz * qz), m12 = 2 * (qx * qy - qz * qw), m13 = 2 * (qx * qz + qy * qw);
  const m22 = 1 - 2 * (qx * qx + qz * qz), m23 = 2 * (qy * qz - qx * qw);
  const m32 = 2 * (qy * qz + qx * qw), m33 = 1 - 2 * (qx * qx + qy * qy);
  const ry = Math.asin(Math.max(-1, Math.min(1, m13)));
  const [rx, rz] = Math.abs(m13) < 0.9999999 ? [Math.atan2(-m23, m33), Math.atan2(-m12, m11)] : [Math.atan2(m32, m22), 0];
  const deg = (r: number) => Math.round(((r * 180) / Math.PI) * 1000) / 1000;
  return [deg(rx), deg(ry), deg(rz)];
}

/** A ball-and-stick model of a known molecule. */
export function moleculeModel(name: string): Model3D | null {
  const make = MOLECULES[name];
  if (!make) return null;
  const spec = make();
  const counts: Record<string, number> = {};
  const parts: Part[] = spec.atoms.map((a, i) => {
    const info = ATOMS[a.el];
    counts[a.el] = (counts[a.el] ?? 0) + 1;
    return { id: `${a.el.toLowerCase()}${counts[a.el]}`, name: `${info.name[0].toUpperCase()}${info.name.slice(1)} atom ${counts[a.el]}`, description: `A ${info.name} atom (${a.el}).`, shape: "sphere", size: [info.r * 0.55], position: a.at.map((n) => Math.round(n * 1e4) / 1e4) as V3, rotation: [0, 0, 0], color: info.color, material: "plastic", group: "atoms" };
  });
  for (const [a, b, order] of spec.bonds) {
    const pa = spec.atoms[a].at;
    const pb = spec.atoms[b].at;
    const v: V3 = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]];
    const len = Math.hypot(...v);
    const rot = alignY(v);
    // A double/triple bond is drawn as 2/3 thin parallel sticks.
    const perp = rotate([1, 0, 0], rot);
    for (let k = 0; k < order; k++) {
      const off = (k - (order - 1) / 2) * 0.12;
      parts.push({
        id: `bond-${a}-${b}-${k}`,
        name: `${spec.atoms[a].el}${order === 2 ? "=" : order === 3 ? "≡" : "–"}${spec.atoms[b].el} bond`,
        description: `A ${order === 1 ? "single" : order === 2 ? "double" : "triple"} bond, ${len.toFixed(2)} Å long.`,
        shape: "cylinder",
        size: [0.06, len, 0.06],
        position: [0, 1, 2].map((i) => Math.round(((pa[i] + pb[i]) / 2 + perp[i] * off) * 1e4) / 1e4) as V3,
        rotation: rot,
        color: "#b0b6c0",
        material: "plastic",
        group: "bonds",
      });
    }
  }
  return { title: `${spec.title} (${spec.formula})`, description: spec.facts, units: "Å", parts, separate: true, notes: ["Bond lengths and angles are real measured values; atom sizes are scaled down so the bonds are visible."] };
}

/** Bond angle in degrees between atoms b-a-c (for checking molecule geometry). */
export function angleAt(a: V3, b: V3, c: V3): number {
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const cos = (u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / (Math.hypot(...u) * Math.hypot(...v));
  return (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
}
