import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { C, toDecimal } from "../src/lib/math/precise.js";
import { candidateAt, examine, expandedText, familyKey, LEVELS, levelSize, relationText, searchSlice, shiftPoly } from "../src/lib/math/discovery.js";
import { checkIdentity, extractEquation, parse, evaluate } from "../src/lib/math/expr.js";
import { mathPilotAgent } from "../src/agents/mathPilot.js";
import { picturePilotAgent } from "../src/agents/picturePilot.js";
import { kindsFromWords, planFromWords, renderSvg, safeColor, sceneFromWords, unsafePictureReason, validatePlan } from "../src/lib/picture.js";
import { decideAgents } from "../src/router/decisionModel.js";
import { planSteps } from "../src/coordinator.js";
import { countDiscoveries } from "../src/db.js";

const ctx = () => ({ signal: new AbortController().signal, workspaceRoot: process.env.OMNIPILOT_WORKSPACE! });
const input = (requestText: string) => ({ runId: "test", requestText, context: {} });

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("MathPilot: high-precision constants", () => {
  it("computes the constants to the published digits", () => {
    expect(toDecimal(C.pi, 40)).toBe("3.1415926535897932384626433832795028841971");
    expect(toDecimal(C.e, 40)).toBe("2.7182818284590452353602874713526624977572");
    expect(toDecimal(C.ln2, 30)).toBe("0.693147180559945309417232121458");
    expect(toDecimal(C.zeta3, 30)).toBe("1.202056903159594285399738161511");
    expect(toDecimal(C.catalan, 30)).toBe("0.915965594177219015054603514932");
    expect(toDecimal(C.phi, 30)).toBe("1.618033988749894848204586834365");
  });
});

describe("MathPilot: identity search", () => {
  it("verifies a classic continued fraction for 4/π to 60 digits", () => {
    const d = examine({ a: [1, 2], b: [0, 0, 1] }); // 1 + 1/(3 + 4/(5 + 9/(7 + ...)))
    expect(d).not.toBeNull();
    expect(d!.constant).toBe("π");
    expect(d!.digits).toBeGreaterThanOrEqual(50);
    expect(relationText(d!.relation, d!.constant)).toBe("4 / π");
    expect(expandedText(d!)).toBe("1 + 1/(3 + 4/(5 + 9/(7 + 16/(…))))");
  });

  it("rejects fractions that converge to a rational number", () => {
    expect(examine({ a: [1], b: [1] })).not.toBeNull(); // golden ratio: genuinely irrational
    expect(examine({ a: [2, 1], b: [0, 0, -1] })).toBeNull(); // converges to a rational
  });

  it("treats shifted copies of a fraction as one family", () => {
    expect(shiftPoly([1, 2], 1)).toEqual([3, 2]);
    expect(familyKey({ a: [1, 2], b: [0, 0, 1] })).toBe(familyKey({ a: [3, 2], b: [1, 2, 1] }));
  });

  it("enumerates every level without out-of-range indexes", () => {
    for (let level = 0; level < LEVELS.length; level++) {
      expect(levelSize(LEVELS[level])).toBeLessThan(Number.MAX_SAFE_INTEGER);
      for (const index of [0, 1, levelSize(LEVELS[level]) - 1]) candidateAt({ level, index });
    }
  });

  it("finds and stores verified identities in a short search", () => {
    const found = [];
    for (let i = 0; i < 20 && found.length === 0; i++) found.push(...searchSlice(200));
    expect(found.length).toBeGreaterThan(0);
    expect(found[0].digits).toBeGreaterThanOrEqual(20);
    expect(countDiscoveries()).toBeGreaterThan(0);
  });
});

describe("MathPilot: identity checker", () => {
  it("parses implicit multiplication, unicode and functions safely", () => {
    expect(evaluate(parse("2π"), {})).toBeCloseTo(2 * Math.PI);
    expect(evaluate(parse("√2 × √2"), {})).toBeCloseTo(2);
    expect(evaluate(parse("3(x+1)"), { x: 2 })).toBe(9);
    expect(evaluate(parse("5!"), {})).toBe(120);
    expect(evaluate(parse("-2^2"), {})).toBe(-4);
    expect(() => parse("process.exit()")).toThrow();
  });

  it("decides true and false identities, with counterexamples", () => {
    expect(checkIdentity("sin(x)^2 + cos(x)^2", "1").verdict).toBe("true");
    const wrong = checkIdentity("(a+b)^2", "a^2 + b^2");
    expect(wrong.verdict).toBe("false");
    expect(wrong.counterexample).toBeDefined();
    expect(checkIdentity("sum(k, k, 1, n)", "n(n+1)/2").verdict).toBe("true");
    expect(checkIdentity("sum(1/n^2, n, 1, inf)", "pi^2/6").verdict).toBe("true");
    expect(checkIdentity("sqrt(x^2)", "x").verdict).toBe("false");
    expect(checkIdentity("e^(i pi)", "-1").verdict).toBe("unclear");
  });

  it("pulls the equation out of a question", () => {
    expect(extractEquation("Is it true that sin(x)^2 + cos(x)^2 = 1?")).toEqual({ left: "sin(x)^2 + cos(x)^2", right: "1" });
    expect(extractEquation("check: (a+b)^2 = a^2 + 2ab + b^2 for all a")).toEqual({ left: "(a+b)^2", right: "a^2 + 2ab + b^2" });
    expect(extractEquation("what is 2 + 2")).toBeNull();
  });

  it("answers in chat with a computed verdict", async () => {
    const r = await mathPilotAgent(input("is (a+b)^2 = a^2 + b^2?"), ctx());
    expect(r.status).toBe("success");
    expect(r.findings[0]).toMatch(/Not true/);
  });

  it("reports what the search has found", async () => {
    const r = await mathPilotAgent(input("what has MathPilot discovered so far?"), ctx());
    expect(r.findings.join("\n")).toMatch(/formulas checked so far/);
    expect(r.findings.join("\n")).toMatch(/Latest verified identities/);
  });
});

describe("PicturePilot", () => {
  it("plans a picture from words when no model is available", () => {
    expect(sceneFromWords("a rocket flying past planets")).toBe("space");
    expect(sceneFromWords("a cat under the moon")).toBe("night");
    expect(kindsFromWords("three cats and a dog")).toEqual(expect.arrayContaining([{ kind: "cat", count: 3 }, { kind: "dog", count: 1 }]));
    const spec = planFromWords("Draw a red car next to a house");
    expect(spec.objects.map((o) => o.kind)).toEqual(expect.arrayContaining(["car", "house", "sun"]));
  });

  it("never lets model output inject markup", () => {
    expect(safeColor("red", "#000")).toBe("red");
    expect(safeColor('red" onload="alert(1)', "#000")).toBe("#000");
    const spec = validatePlan(
      { title: '<script>alert(1)</script>', scene: "day", objects: [{ kind: "cat", x: 500, y: -4, size: 20, color: "url(javascript:x)" }, { kind: "<img>", x: 1, y: 1, size: 1 }] },
      "a cat"
    )!;
    expect(spec.objects).toHaveLength(1);
    // Clamped so the whole object stays inside the picture.
    const o = spec.objects[0];
    expect(o.x + (o.size * 500) / 800 / 2).toBeLessThanOrEqual(100);
    expect(o.y - o.size / 2).toBeGreaterThanOrEqual(0);
    const svg = renderSvg(spec);
    expect(svg).not.toMatch(/<script|javascript:|onload/i);
    expect(svg).toContain("&lt;script&gt;");
  });

  it("refuses unsafe requests and video", async () => {
    expect(unsafePictureReason("draw a nude person")).toBeTruthy();
    expect(unsafePictureReason("a photo of Taylor Swift")).toBeTruthy();
    expect((await picturePilotAgent(input("draw a gory scene"), ctx())).status).toBe("failed_safe");
    const video = await picturePilotAgent(input("make a video of a dog"), ctx());
    expect(video.findings.join(" ")).toMatch(/still pictures only/);
  });

  it("repairs a small model's layout mistakes", () => {
    const spec = validatePlan(
      { title: "t", scene: "day", objects: [{ kind: "rocket", x: 30, y: 2, size: 34 }, ...[0, 1, 2, 3].map((i) => ({ kind: "star", x: 47, y: 30 + i * 20, size: 10 }))] },
      "a rocket flying past stars in space"
    )!;
    expect(spec.scene).toBe("space"); // the words win over the model's "day"
    const stars = spec.objects.filter((o) => o.kind === "star");
    expect(new Set(stars.map((o) => Math.round(o.x))).size).toBe(stars.length); // no longer one column
    const rocket = spec.objects.find((o) => o.kind === "rocket")!;
    expect(rocket.y - rocket.size / 2).toBeGreaterThanOrEqual(0); // not cut off at the top
    expect(kindsFromWords("a snowman and pine trees")).toEqual([{ kind: "pine", count: 2 }, { kind: "snowman", count: 1 }]); // "man" inside "snowman" isn't a person
  });

  it("draws things it has no shape for as the closest shape it has", () => {
    const plan = validatePlan({ title: "Dragon", scene: "day", objects: [{ kind: "dragon", x: 50, y: 40, size: 30 }, { kind: "Castles", x: 70, y: 70, size: 30 }, { kind: "spaceship-ish", x: 10, y: 10, size: 10 }] }, "draw a dragon over a castle");
    expect(plan?.objects.map((o) => o.kind)).toEqual(["dinosaur", "castle"]);
  });

  it("returns an illustration attachment", async () => {
    const r = await picturePilotAgent(input("Draw a cat and a rainbow"), ctx());
    expect(r.status).toBe("success");
    const pic = r.attachments?.[0];
    expect(pic?.type).toBe("picture");
    if (pic?.type === "picture") expect(pic.src).toMatch(/^data:image\/svg\+xml;base64,/);
  });
});

describe("Routing to the new agents", () => {
  it("sends identity checks to MathPilot and everyday math elsewhere", () => {
    expect(decideAgents("Is it true that sin(x)^2 + cos(x)^2 = 1?").selectedAgents).toContain("MathPilot");
    expect(decideAgents("What has MathPilot found?").selectedAgents).toContain("MathPilot");
    expect(decideAgents("Solve 3x + 4 = 19").selectedAgents).not.toContain("MathPilot");
    expect(decideAgents("My kid should learn math for 1 hour, no AI").selectedAgents).not.toContain("MathPilot");
  });

  it("keeps a picture description together instead of splitting it at \"and\"", () => {
    const steps = planSteps("Draw a cat and a dog under a rainbow", ["PicturePilot", "Helper"]);
    expect(steps.find((s) => s.agent === "PicturePilot")?.task).toBe("Draw a cat and a dog under a rainbow");
    expect(steps.find((s) => s.agent === "Helper")?.afterAll).toBeFalsy();
    // A real second instruction is still its own task.
    const two = planSteps("Draw a cat and explain how cats purr", ["PicturePilot", "LearnPilot"]);
    expect(two.find((s) => s.agent === "LearnPilot")?.task).toMatch(/explain how cats purr/);
    expect(two.find((s) => s.agent === "PicturePilot")?.task).toBe("Draw a cat");
  });

  it("sends drawing requests to PicturePilot, not wiring diagrams", () => {
    expect(decideAgents("Draw a dragon over a castle").selectedAgents).toContain("PicturePilot");
    expect(decideAgents("Make a picture of a cat in space").selectedAgents).toContain("PicturePilot");
    expect(decideAgents("Draw a wiring diagram for an LED on my Arduino").selectedAgents).not.toContain("PicturePilot");
  });
});

describe("SDK access", () => {
  const TOKEN = "test-token-0123456789abcdef";

  it("answers a one-shot question on /api/ask", async () => {
    const res = await request(createApp()).post("/api/ask").send({ message: "is 2^10 = 1024?", textOnly: true });
    expect(res.status).toBe(200);
    expect(res.body.answer).toMatch(/True|1024/);
    expect(res.body.attachments).toBeUndefined();
  });

  it("lets other devices in with the token, only for the SDK endpoints", async () => {
    vi.stubEnv("OMNIPILOT_API_TOKEN", TOKEN);
    const app = createApp();
    const lan = { Host: "192.168.1.20:8899", Authorization: `Bearer ${TOKEN}` };
    expect((await request(app).get("/api/math/status").set(lan)).status).toBe(200);
    expect((await request(app).post("/api/math/check").set(lan).send({ equation: "2+2 = 4" })).body.verdict).toBe("true");
    // Not integrations, approvals or Watcher settings.
    expect((await request(app).get("/api/connectors").set(lan)).status).toBe(403);
    expect((await request(app).post("/api/watcher/policy").set(lan).send({})).status).toBe(403);
    // Not from a web page, and not with a wrong token.
    expect((await request(app).get("/api/status").set({ ...lan, Origin: "https://evil.example" })).status).toBe(403);
    expect((await request(app).get("/api/status").set({ ...lan, Authorization: "Bearer wrong-token-wrong-token" })).status).toBe(401);
    // Without a token, other devices stay locked out.
    expect((await request(app).get("/api/status").set({ Host: "192.168.1.20:8899" })).status).toBe(403);
  });

  it("ignores a token that's too short to be safe", async () => {
    vi.stubEnv("OMNIPILOT_API_TOKEN", "short");
    const res = await request(createApp()).get("/api/status").set({ Host: "192.168.1.20:8899", Authorization: "Bearer short" });
    expect(res.status).toBe(401);
  });
});
