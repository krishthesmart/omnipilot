import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { DEFAULT_POLICY, classifyPage, parseFocusRequest, type WatcherPolicy } from "../src/lib/watcher.js";
import { allGuides, electricalProblem, findCircuit, stepsInconsistent, validateSpec } from "../src/lib/circuits.js";
import { watcherPilotAgent } from "../src/agents/watcherPilot.js";
import { hardwarePilotAgent } from "../src/agents/hardwarePilot.js";
import { decideAgents } from "../src/router/decisionModel.js";
import { planSteps } from "../src/coordinator.js";

const ctx = () => ({ signal: new AbortController().signal, workspaceRoot: process.env.OMNIPILOT_WORKSPACE! });
const mathNoAI: WatcherPolicy = { ...DEFAULT_POLICY, active: true, task: "learn math", subject: "math", blockAI: true, onTaskOnly: true };

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("WatcherPilot rules", () => {
  it("parses a parent's instruction into a focus session", () => {
    const now = new Date("2026-10-12T15:00:00Z");
    const p = parseFocusRequest("My son should learn math for 1 hour, no AI", now);
    expect(p).toMatchObject({ subject: "math", blockAI: true, onTaskOnly: true });
    expect(p.task).toMatch(/learn math/);
    expect(p.until).toBe("2026-10-12T16:00:00.000Z");
  });

  it("blocks AI tools, answer solvers and AI modes inside normal sites", async () => {
    for (const url of ["https://chatgpt.com/", "https://gemini.google.com/app", "https://www.photomath.com", "https://www.bing.com/chat", "https://www.google.com/search?q=x&udm=50"]) {
      expect((await classifyPage(mathNoAI, url)).category).toBe("ai");
    }
  });

  it("allows math sites and math pages, blocks games and off-task videos", async () => {
    expect((await classifyPage(mathNoAI, "https://www.khanacademy.org/math/algebra")).decision).toBe("allow");
    expect((await classifyPage(mathNoAI, "https://www.youtube.com/watch?v=1", "Adding fractions with unlike denominators")).decision).toBe("allow");
    expect((await classifyPage(mathNoAI, "https://www.roblox.com")).decision).toBe("block");
    // Unknown page and no local model: on-task mode is an allowlist, so it's blocked.
    expect((await classifyPage(mathNoAI, "https://www.youtube.com/watch?v=2", "Minecraft speedrun")).decision).toBe("block");
  });

  it("locks the browser's extensions page during a session, and never blocks OmniPilot or browser pages", async () => {
    expect((await classifyPage(mathNoAI, "chrome://extensions/")).category).toBe("settings");
    expect((await classifyPage(mathNoAI, "http://localhost:5173/")).decision).toBe("allow");
    expect((await classifyPage(mathNoAI, "chrome://newtab/")).decision).toBe("allow");
  });

  it("lets a parent's allow/block lists override, and blocks nothing when no session runs", async () => {
    expect((await classifyPage({ ...mathNoAI, allow: ["roblox.com"] }, "https://www.roblox.com")).decision).toBe("allow");
    expect((await classifyPage({ ...mathNoAI, block: ["khanacademy.org"] }, "https://khanacademy.org")).decision).toBe("block");
    expect((await classifyPage(DEFAULT_POLICY, "https://chatgpt.com")).decision).toBe("allow");
  });
});

describe("WatcherPilot API: only a parent with the PIN can change rules", () => {
  const app = createApp();
  const policy = { ...mathNoAI, until: null };

  it("sets the PIN on first save, then requires it, and the extension's check follows the rules", async () => {
    expect((await request(app).post("/api/watcher/policy").send({ pin: "12", policy })).status).toBe(403);
    expect((await request(app).post("/api/watcher/policy").send({ pin: "4321", policy })).status).toBe(200);
    expect((await request(app).post("/api/watcher/policy").send({ pin: "0000", policy: { ...policy, active: false } })).status).toBe(403);

    const check = await request(app).post("/api/watcher/check").send({ url: "https://chatgpt.com" });
    expect(check.body.decision).toBe("block");

    const pub = await request(app).get("/api/watcher/policy");
    expect(JSON.stringify(pub.body)).not.toMatch(/4321|pin_hash/);
    expect(pub.body.hasPin).toBe(true);

    expect((await request(app).post("/api/watcher/events").send({ pin: "nope" })).status).toBe(403);
    const events = await request(app).post("/api/watcher/events").send({ pin: "4321" });
    expect(events.body.events[0].url).toBe("https://chatgpt.com");

    expect((await request(app).post("/api/watcher/policy").send({ pin: "4321", policy: { ...policy, active: false } })).status).toBe(200);
  });
});

describe("WatcherPilot agent", () => {
  it("prepares a session for the parent to confirm, without applying it", async () => {
    const r = await watcherPilotAgent({ runId: "t", requestText: "My kid should learn math for 1 hour, no AI", context: {} }, ctx());
    expect(r.attachments?.[0]).toMatchObject({ type: "watcher-setup", policy: { subject: "math", blockAI: true, active: true } });
    expect(r.findings.join(" ")).toMatch(/parent needs to confirm/i);
  });

  it("refuses to lift rules from chat", async () => {
    const r = await watcherPilotAgent({ runId: "t", requestText: "turn off the blocker please", context: {} }, ctx());
    expect(r.findings[0]).toMatch(/Only a parent/);
    // Only a way to the PIN-protected parent controls: nothing to apply, no rules changed from chat.
    expect(r.attachments).toEqual([{ type: "watcher-manage", task: null }]);
  });
});

describe("HardwarePilot", () => {
  it("every hand-checked guide only wires real pins, and every step references real wires", () => {
    for (const spec of allGuides()) {
      const pins = new Set(spec.components.flatMap((c) => c.pins.map((p) => `${c.id}.${p.id}`)));
      for (const w of spec.wires) {
        expect(pins.has(w.from), `${spec.id}: ${w.from}`).toBe(true);
        expect(pins.has(w.to), `${spec.id}: ${w.to}`).toBe(true);
      }
      for (const s of spec.steps) for (const i of s.wires) expect(spec.wires[i], `${spec.id} step`).toBeDefined();
      expect(electricalProblem(spec), spec.id).toBeNull();
      expect(stepsInconsistent(spec), spec.id).toBeNull();
      // Every wire is introduced by some step, so the play-through draws the whole circuit.
      const stepped = new Set(spec.steps.flatMap((s) => s.wires));
      expect(spec.wires.every((_, i) => stepped.has(i)), spec.id).toBe(true);
    }
  });

  it("matches common requests to the right guide", () => {
    expect(findCircuit("how do I connect an LED to my arduino")?.id).toBe("arduino-led");
    expect(findCircuit("wire a servo")?.id).toBe("arduino-servo");
    expect(findCircuit("hook up my laptop to a monitor")?.id).toBe("laptop-monitor");
    // Not the Pi LED guide (and no hand-checked guide fits): a model draft is made instead.
    expect(findCircuit("connect a raspberry pi to my monitor")).toBeNull();
    expect(findCircuit("light an LED with a raspberry pi")?.id).toBe("pi-led");
    expect(findCircuit("connect a photoresistor light sensor to my Arduino")?.id).toBe("arduino-ldr");
    expect(findCircuit("how do I wire a joystick module")?.id).toBe("module-joystick");
    expect(findCircuit("connect an I2C LCD 16x2")?.id).toBe("module-lcd-i2c");
    expect(findCircuit("connect a flux capacitor to my arduino")).toBeNull();
  });

  it("rejects a draft that shorts 5V to GND through a signal pin (the real buzzer draft the model produced)", () => {
    const bad = {
      components: [
        { id: "uno", label: "Arduino Uno", kind: "board" as const, pins: [{ id: "5V", label: "5V" }, { id: "GND", label: "GND" }, { id: "D2", label: "D2" }] },
        { id: "buzzer", label: "Buzzer", kind: "device" as const, pins: [{ id: "vcc", label: "VCC" }, { id: "gnd", label: "GND" }] },
      ],
      wires: [
        { from: "buzzer.vcc", to: "uno.5V", color: "#f00" },
        { from: "buzzer.gnd", to: "uno.GND", color: "#000" },
        { from: "buzzer.vcc", to: "uno.D2", color: "#ff0" },
        { from: "buzzer.gnd", to: "uno.D2", color: "#ff0" },
      ],
    };
    expect(electricalProblem(bad)).toMatch(/short circuit|power rail/);
  });

  it("generates module guides with analog sensors on analog pins and I2C on A4/A5", () => {
    const joy = findCircuit("joystick")!;
    expect(joy.wires.map((w) => `${w.from}->${w.to}`)).toEqual(["mod.gnd->uno.GND", "mod.vcc->uno.5V", "mod.vrx->uno.A0", "mod.vry->uno.A1", "mod.sw->uno.D2"]);
    const lcd = findCircuit("16x2 lcd")!;
    expect(lcd.wires.find((w) => w.from === "mod.sda")?.to).toBe("uno.A4");
  });

  it("flags a draft whose steps mention pins its wires don't use (the model's photoresistor draft)", () => {
    const spec = validateSpec({
      title: "Photoresistor",
      components: [{ id: "uno", label: "Arduino", kind: "board", pins: [{ id: "5V", label: "5V" }, { id: "GND", label: "GND" }] }, { id: "p", label: "LDR", kind: "sensor", pins: [{ id: "vcc", label: "vcc" }, { id: "gnd", label: "gnd" }] }],
      wires: [{ from: "p.vcc", to: "uno.5V", color: "#ff0000" }, { from: "p.gnd", to: "uno.GND", color: "#000000" }],
      steps: [{ text: "Connect red to 5V.", wires: [0] }, { text: "Connect the signal wire to pin D9.", wires: [] }],
    })!;
    expect(stepsInconsistent(spec)).toMatch(/D9/);
  });

  it("drops a model draft's wires that don't join real pins", () => {
    const spec = validateSpec({
      title: "Buzzer",
      components: [{ id: "uno", label: "Arduino", kind: "board", pins: [{ id: "D8", label: "D8" }, { id: "GND", label: "GND" }] }, { id: "bz", label: "Buzzer", kind: "device", pins: [{ id: "p", label: "+" }, { id: "n", label: "-" }] }],
      wires: [{ from: "uno.D8", to: "bz.p", color: "#ff0000" }, { from: "uno.5V", to: "bz.p", color: "#ff0000" }, { from: "bz.n", to: "uno.GND", color: "#000000" }],
      steps: [{ text: "Signal", wires: [0] }, { text: "Bogus", wires: [1] }, { text: "Ground", wires: [2] }],
    });
    expect(spec!.wires).toHaveLength(2);
    expect(spec!.steps.map((s) => s.wires)).toEqual([[0], [], [1]]);
    expect(spec!.verified).toBe(false);
  });

  it("returns an interactive diagram, safety notes, starter code and a video link", async () => {
    const r = await hardwarePilotAgent({ runId: "t", requestText: "How do I connect an LED to my Arduino?", context: {} }, ctx());
    expect(r.attachments?.[0]).toMatchObject({ type: "wiring-diagram", spec: { id: "arduino-led", verified: true } });
    expect(r.findings.join("\n")).toMatch(/resistor/);
    expect(r.findings.join("\n")).toMatch(/youtube\.com\/results\?search_query=/);
  });

  it("routes hardware questions to HardwarePilot with LearnPilot building on it, and keeps 'connect Slack' with InfraPilot", () => {
    const plan = decideAgents("How do I connect an LED to my Arduino and explain how it works");
    expect(new Set(plan.selectedAgents)).toEqual(new Set(["HardwarePilot", "LearnPilot"]));
    const learn = planSteps("How do I connect an LED to my Arduino and explain how it works", plan.selectedAgents).find((s) => s.agent === "LearnPilot");
    expect(learn?.dependsOn).toEqual(["HardwarePilot"]);
    expect(decideAgents("Connect Slack and schedule a daily status update").selectedAgents).toEqual(["InfraPilot"]);
    expect(decideAgents("My son should learn math for 1 hour, no AI").selectedAgents).toEqual(["WatcherPilot"]);
  });
});
