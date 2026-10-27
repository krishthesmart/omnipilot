import { describe, expect, it } from "vitest";
import { alignY, angleAt, floatingParts, groundModel, modelBounds, moleculeIn, moleculeModel, partBox, validateModel } from "../src/lib/model3d.js";
import { modelPilotAgent } from "../src/agents/modelPilot.js";
import { decideAgents } from "../src/router/decisionModel.js";

const ctx = () => ({ signal: new AbortController().signal, workspaceRoot: process.env.OMNIPILOT_WORKSPACE! }) as any;

describe("3D models", () => {
  it("validates and clamps whatever the AI returns", () => {
    const m = validateModel({ title: "x", parts: [{ name: "Body", shape: "blob", size: [-1, "2"], position: [0, "a", 1], rotation: [370, 0, -90], color: "red" }, { name: "Body" }, null] })!;
    expect(m.parts).toHaveLength(2);
    expect(m.parts[0]).toMatchObject({ shape: "box", position: [0, 0, 1], rotation: [10, 0, 270], color: "#9aa4b2" });
    expect(m.parts[0].size[0]).toBeGreaterThan(0);
    expect(new Set(m.parts.map((p) => p.id)).size).toBe(2);
    expect(validateModel({ parts: [] })).toBeNull();
  });

  it("finds parts that float in the air", () => {
    const m = validateModel({
      parts: [
        { id: "base", shape: "box", size: [2, 1, 2], position: [0, 0.5, 0] },
        { id: "pole", shape: "cylinder", size: [0.1, 2, 0.1], position: [0, 2, 0] },
        { id: "balloon", shape: "sphere", size: [0.5], position: [5, 5, 5] },
      ],
    })!;
    expect(floatingParts(m).map((p) => p.id)).toEqual(["balloon"]);
    expect(floatingParts({ ...m, separate: true })).toEqual([]);
  });

  it("accounts for rotation and puts the model on the floor", () => {
    const lying = validateModel({ parts: [{ shape: "cylinder", size: [0.5, 4, 0.5], position: [0, 3, 0], rotation: [0, 0, 90] }] })!;
    const b = partBox(lying.parts[0]);
    expect(b.max[0] - b.min[0]).toBeCloseTo(4, 3);
    expect(b.max[1] - b.min[1]).toBeCloseTo(1, 3);
    expect(modelBounds(groundModel(lying)).min[1]).toBeCloseTo(0, 3);
  });

  it("builds molecules with real geometry", () => {
    expect(moleculeIn("show me a 3d model of a water molecule")).toBe("water");
    expect(moleculeIn("CO2 molecule in 3D")).toBe("carbon dioxide");
    expect(moleculeIn("a 3d model of a rocket")).toBeNull();
    const water = moleculeModel("water")!;
    const [o, h1, h2] = water.parts.filter((p) => p.group === "atoms").map((p) => p.position);
    expect(angleAt(o, h1, h2)).toBeCloseTo(104.5, 1);
    expect(Math.hypot(h1[0] - o[0], h1[1] - o[1], h1[2] - o[2])).toBeCloseTo(0.958, 3);
    const methane = moleculeModel("methane")!;
    const [c, ...hs] = methane.parts.filter((p) => p.group === "atoms").map((p) => p.position);
    for (let i = 0; i < hs.length; i++) for (let j = i + 1; j < hs.length; j++) expect(angleAt(c, hs[i], hs[j])).toBeCloseTo(109.47, 1);
    expect(moleculeModel("carbon dioxide")!.parts.filter((p) => p.group === "bonds")).toHaveLength(4); // two double bonds
  });

  it("bond sticks point from atom to atom", () => {
    const rot = alignY([1, 0, 0]);
    // A cylinder along y, rotated, should lie along x.
    const box = partBox({ id: "b", name: "b", description: "", shape: "cylinder", size: [0.05, 2, 0.05], position: [0, 0, 0], rotation: rot, color: "#000000", material: "plastic", group: "bonds" });
    expect(box.max[0] - box.min[0]).toBeCloseTo(2, 2);
  });

  it("ModelPilot returns an explorable molecule without the AI, and routing finds it", async () => {
    const r = await modelPilotAgent({ runId: "m", requestText: "a 3D model of a methane molecule", context: {} } as any, ctx());
    expect(r.status).toBe("success");
    expect(r.attachments![0].type).toBe("model-3d");
    expect(decideAgents("build a 3d model of a nintendo switch you can explore through the parts").selectedAgents).toContain("ModelPilot");
    expect(decideAgents("show me a water molecule in 3d").selectedAgents).toContain("ModelPilot");
  });
});

import { proportionProblem } from "../src/agents/modelPilot.js";
describe("proportion check", () => {
  const m = validateModel({ units: "cm", parts: [{ shape: "box", size: [35.9, 1.4, 15.3], position: [0, 0.7, 0] }] })!;
  it("flags a model whose size doesn't match the real object", () => {
    expect(proportionProblem(m, [23.9, 10.2, 1.4])).toMatch(/real object is 23.9 x 10.2 x 1.4/);
  });
  it("accepts a match in any orientation", () => {
    const ok = validateModel({ units: "cm", parts: [{ shape: "box", size: [24, 1.4, 10] }] })!;
    expect(proportionProblem(ok, [23.9, 10.2, 1.4])).toBeNull();
  });
});
