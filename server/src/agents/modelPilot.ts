import type { AgentFn } from "./base.js";
import { assertNotAborted, evidence, logAgentAction } from "./base.js";
import { agentLlmEnabled, agentModel, generateJson } from "../lib/llm.js";
import { aiUnavailableReason } from "../lib/groq.js";
import { db } from "../db.js";
import { floatingParts, groundModel, modelBounds, moleculeIn, moleculeModel, validateModel, MAX_PARTS, type Model3D } from "../lib/model3d.js";

// ModelPilot: interactive 3D models you can explore part by part ("build a 3D model of a Nintendo
// Switch you can explore through the parts", "a 3D model of a water molecule", "make the wheels
// red"). Known molecules are built exactly (real bond lengths and angles); everything else is
// designed by the AI as named parts, then checked: parts that float in the air are sent back for
// one repair round, and the model is placed on the floor. The app shows it with orbit controls, an
// exploded view, a clickable parts list, and STL/GLB export for 3D printing.
// Each conversation remembers its latest model, so follow-ups edit it instead of starting over.

db.exec(`CREATE TABLE IF NOT EXISTS models3d (conversation_id TEXT PRIMARY KEY, model TEXT NOT NULL, updated_at TEXT NOT NULL)`);

const saveModel = (conversationId: string | undefined, m: Model3D) => {
  if (conversationId) db.prepare(`INSERT OR REPLACE INTO models3d (conversation_id, model, updated_at) VALUES (?, ?, ?)`).run(conversationId, JSON.stringify(m), new Date().toISOString());
};
const lastModel = (conversationId: string | undefined): Model3D | null => {
  if (!conversationId) return null;
  const r = db.prepare(`SELECT model FROM models3d WHERE conversation_id = ?`).get(conversationId) as { model: string } | undefined;
  return r ? validateModel(JSON.parse(r.model)) : null;
};

/** "make the wheels red", "add a door", "remove the antenna" -- changes to the current model. */
const EDIT = /^(now\s+|please\s+|can you\s+|also\s+)?(make|add|remove|delete|change|turn|move|resize|scale|color|colour|paint|rotate|put|give|replace|swap|bigger|smaller|taller|shorter)\b/i;

const PART_SCHEMA = {
  type: "object",
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    description: { type: "string" },
    shape: { type: "string", enum: ["box", "sphere", "cylinder", "cone", "torus", "capsule"] },
    size: { type: "array", items: { type: "number" } },
    position: { type: "array", items: { type: "number" } },
    rotation: { type: "array", items: { type: "number" } },
    color: { type: "string" },
    material: { type: "string", enum: ["plastic", "metal", "glass", "rubber", "wood", "emissive", "matte"] },
    group: { type: "string" },
  },
  required: ["id", "name", "description", "shape", "size", "position", "rotation", "color", "material", "group"],
};
const MODEL_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    description: { type: "string" },
    units: { type: "string" },
    separate: { type: "boolean" },
    notes: { type: "array", items: { type: "string" } },
    real_size: { type: "array", items: { type: "number" } },
    parts: { type: "array", items: PART_SCHEMA },
  },
  required: ["title", "description", "units", "separate", "notes", "real_size", "parts"],
};

const DESIGN_SYSTEM = `You are an expert 3D modeller and engineer. Build the requested object from primitive parts so it is recognisable, well proportioned and educational to explore.
Coordinates: y is up, the object stands on y = 0, centred on x = 0, z = 0. Use real-world proportions in the stated units.
Shapes and size arrays: box [width, height, depth]; sphere [radius]; cylinder [radiusTop, height, radiusBottom] (axis along y); cone [radius, height] (axis along y, point up); torus [radius, tube] (ring in the x-y plane); capsule [radius, length] (axis along y).
rotation is [x, y, z] in degrees. Position is the part's centre.
Rules:
- 20 to 90 parts. Include the internal parts that make it interesting to explore (for devices: battery, circuit board, chips, fans, speakers; for machines: motor, gears, axles), each with a clear 1-2 sentence description of what it does.
- Every part must touch or overlap the part it attaches to: nothing floats unless the object is truly made of separate pieces (then set separate=true).
- Realistic colours (#rrggbb) and materials. Group parts into subsystems with a short group name.
- notes: 2-4 interesting facts about how the real object works.
- real_size: the real object's overall [width (x), height (y), depth (z)] in the stated units. The model's overall size must match it.`;

const EDIT_SYSTEM = `You edit an existing 3D model made of primitive parts (same format and rules as before: y up, standing on y = 0, size arrays per shape, rotation in degrees).
Apply exactly the requested change, keep every other part unchanged (same ids), keep attached parts touching, and return the COMPLETE updated model.`;

function summary(m: Model3D): string {
  const groups = new Map<string, number>();
  for (const p of m.parts) groups.set(p.group, (groups.get(p.group) ?? 0) + 1);
  const b = modelBounds(m);
  const dims = [0, 1, 2].map((k) => (b.max[k] - b.min[k]).toFixed(1)).join(" × ");
  return `${m.parts.length} parts in ${groups.size} group${groups.size === 1 ? "" : "s"} (${[...groups].map(([g, n]) => `${g}: ${n}`).join(", ")}); about ${dims} ${m.units} (width × height × depth).`;
}

async function design(system: string, user: string, signal: AbortSignal): Promise<(Model3D & { realSize?: number[] }) | null> {
  const raw = await generateJson<any>(system, user, { signal, schema: MODEL_SCHEMA, temperature: 0.3, maxTokens: 14_000, maxInput: 60_000, effort: "medium", patientMs: 60_000, preferBestMs: 45_000 });
  const m = validateModel(raw);
  const real = Array.isArray(raw?.real_size) ? raw.real_size.map(Number).filter((n: number) => Number.isFinite(n) && n > 0) : [];
  return m ? { ...m, ...(real.length === 3 ? { realSize: real } : {}) } : null;
}

/** The real object's overall dimensions, from a separate focused question to the AI. */
async function realDimensions(request: string, signal: AbortSignal): Promise<{ size: number[]; units: string } | null> {
  const r = await generateJson<{ object: string; width: number; height: number; depth: number; units: string; known: boolean }>(
    "What are the real overall dimensions of the object the user wants a 3D model of, as it normally stands or sits (width = left-right, height = up-down, depth = front-back)? Use well-known published dimensions when they exist. Choose sensible units (mm, cm or m). known=false if it's imaginary or has no typical size.",
    request,
    { signal, schema: { type: "object", properties: { object: { type: "string" }, width: { type: "number" }, height: { type: "number" }, depth: { type: "number" }, units: { type: "string", enum: ["mm", "cm", "m"] }, known: { type: "boolean" } }, required: ["object", "width", "height", "depth", "units", "known"] }, temperature: 0, maxTokens: 600, effort: "medium", preferBestMs: 45_000 }
  );
  const size = r ? [r.width, r.height, r.depth].map(Number) : [];
  return r?.known && size.every((n) => Number.isFinite(n) && n > 0) ? { size, units: r.units } : null;
}

/** How far the model's overall size is from the real object's (ignoring which way it's turned), or null if close. */
export function proportionProblem(m: Model3D, real: number[] | undefined): string | null {
  if (!real || real.length !== 3) return null;
  const b = modelBounds(m);
  const have = [0, 1, 2].map((k) => b.max[k] - b.min[k]);
  const [hs, rs] = [[...have].sort((x, y) => y - x), [...real].sort((x, y) => y - x)];
  // Very thin dimensions (under 5% of the largest) are compared loosely.
  const off = hs.some((h, i) => (rs[i] < rs[0] * 0.05 ? Math.abs(h - rs[i]) > rs[0] * 0.05 : Math.abs(h / rs[i] - 1) > 0.25));
  return off ? `The model measures ${have.map((n) => n.toFixed(1)).join(" x ")} ${m.units} (x by y by z), but the real object is ${real.join(" x ")} ${m.units}.` : null;
}

export const modelPilotAgent: AgentFn = async (input, ctx) => {
  assertNotAborted(ctx);
  const text = input.requestText;
  const conversationId = typeof input.context.conversationId === "string" ? input.context.conversationId : undefined;

  // Exact molecules, no AI needed.
  const molecule = moleculeIn(text);
  if (molecule) {
    const m = moleculeModel(molecule)!;
    saveModel(conversationId, m);
    logAgentAction(input.runId, "ModelPilot", "molecule_model", { molecule }, "completed");
    return {
      status: "success",
      findings: [`**${m.title}**: ${m.description}`, "Drag to rotate, scroll to zoom, click an atom or bond to see what it is. Use the exploded view to pull the atoms apart."],
      evidence: [evidence("molecule-geometry", "Measured bond lengths and angles (built exactly, not by the AI).")],
      confidence: 0.95,
      limitations: m.notes ?? [],
      proposedActions: [],
      attachments: [{ type: "model-3d", model: m }],
    };
  }

  if (!agentLlmEnabled()) {
    return { status: "partial_success", findings: ["Designing a 3D model needs the AI model (Groq), which isn't available right now. (Molecules like water, CO2, methane, ammonia and benzene work without it.)"], evidence: [], confidence: 0.1, limitations: [], proposedActions: [] };
  }

  const previous = EDIT.test(text) ? lastModel(conversationId) : null;
  // The real object's size, looked up on its own first (so the check below isn't the designer grading itself).
  const target = previous ? null : await realDimensions(text, ctx.signal);
  let model = previous
    ? await design(EDIT_SYSTEM, `Current model:\n${JSON.stringify(previous)}\n\nChange: ${text}`, ctx.signal)
    : await design(DESIGN_SYSTEM, `${text}${target ? `\n\nThe real object's overall size is ${target.size.join(" x ")} ${target.units} (width x height x depth): match it.` : ""}`, ctx.signal);
  assertNotAborted(ctx);
  if (model && target) {
    model.units = target.units;
    model.realSize = target.size;
  }
  if (!model) {
    return { status: "partial_success", findings: [aiUnavailableReason() ?? "The AI didn't return a usable 3D model this time. Try again, or describe the object in a little more detail."], evidence: [], confidence: 0.1, limitations: [], proposedActions: [] };
  }

  // Checks: parts floating in the air, and overall size/proportions against the real object.
  // Problems get one repair round, kept only if it's actually better.
  const realSize = model.realSize;
  let floating = floatingParts(model);
  let proportion = proportionProblem(model, realSize);
  const repairs: string[] = [];
  if (floating.length || proportion) {
    const problems = [
      ...(floating.length ? [`These parts float without touching the rest of the object: ${floating.map((p) => `${p.id} (${p.name})`).join(", ")}. Move or resize them so each touches the part it attaches to.`] : []),
      ...(proportion ? [`${proportion} Scale and reposition parts so the overall size and proportions match the real object (keep it standing on y = 0).`] : []),
    ];
    const fixed = await design(EDIT_SYSTEM, `Current model:\n${JSON.stringify(model)}\n\nFix these problems and change nothing else:\n- ${problems.join("\n- ")}`, ctx.signal);
    if (fixed) {
      const [f2, p2] = [floatingParts(fixed), proportionProblem(fixed, realSize)];
      if (f2.length + (p2 ? 1 : 0) < floating.length + (proportion ? 1 : 0) || (f2.length <= floating.length && !p2 && proportion)) {
        if (proportion && !p2) repairs.push("corrected its size and proportions");
        if (f2.length < floating.length) repairs.push("attached parts that were floating");
        model = fixed;
        floating = f2;
        proportion = p2;
      }
    }
  }
  const repaired = repairs.length > 0;
  delete (model as { realSize?: number[] }).realSize;
  model = groundModel(model);
  saveModel(conversationId, model);
  logAgentAction(input.runId, "ModelPilot", previous ? "edit_model" : "design_model", { parts: model.parts.length, floating: floating.length, proportionOk: !proportion, repairs, model: agentModel() }, "completed");

  return {
    status: "success",
    findings: [
      `**${model.title}**${previous ? " (updated)" : ""}: ${model.description}`,
      summary(model),
      ...(model.notes?.length ? [`**How it works:**\n${model.notes.map((n) => `- ${n}`).join("\n")}`] : []),
      `Drag to rotate, scroll to zoom, click any part (or pick it in the list) to see what it does, and slide **Explode** to take it apart. Download it as STL for 3D printing or GLB for other 3D apps. Ask for changes like "make it blue" or "add a kickstand".${repaired ? ` (Checked and ${repairs.join(" and ")}.)` : ""}`,
    ],
    evidence: [evidence(`ai-model:${agentModel()}`, "Designed by the AI model from primitive shapes.")],
    confidence: floating.length || proportion ? 0.55 : 0.8,
    limitations: [
      "Built from simple shapes (boxes, cylinders, spheres...), so it shows the structure and parts, not exact curved surfaces.",
      ...(floating.length ? [`${floating.length} part(s) may not be attached: ${floating.slice(0, 5).map((p) => p.name).join(", ")}.`] : []),
      ...(proportion ? [`Its proportions may be off: ${proportion}`] : []),
      ...(model.parts.length >= MAX_PARTS ? [`Limited to ${MAX_PARTS} parts.`] : []),
    ],
    proposedActions: [],
    attachments: [{ type: "model-3d", model }],
  };
};
