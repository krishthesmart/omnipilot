import type { AgentFn } from "./base.js";
import { assertNotAborted, evidence, logAgentAction, previousTurnText } from "./base.js";
import { agentModel, generateJson, modelLimitation } from "../lib/llm.js";
import { CIRCUITS, allGuides, electricalProblem, findCircuit, stepsInconsistent, validateSpec, type DiagramSpec } from "../lib/circuits.js";

// HardwarePilot shows how to connect things: an interactive, step-by-step
// wiring diagram (with a play-through animation), plain-language steps, safety
// notes, starter code, and a link to real how-to videos. Hand-checked guides
// come first; anything else is drafted by the AI model and every wire is
// validated against real pins before it's drawn.

const DRAFT_SYSTEM =
  "You are HardwarePilot, a patient electronics and computer-hardware guide for beginners. Describe how to connect what the user asks about as a wiring diagram: " +
  "components with named pins, wires that join two pins as \"componentId.pinId\", and short steps in order (each lists the indexes of the wires it adds). " +
  "Use correct, standard pin names and voltages. Include safety notes. Keep it to the parts actually needed.";

const DRAFT_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    components: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          label: { type: "string" },
          kind: { type: "string", enum: ["board", "breadboard", "led", "resistor", "button", "sensor", "motor", "device", "port", "power"] },
          pins: { type: "array", items: { type: "object", properties: { id: { type: "string" }, label: { type: "string" } }, required: ["id", "label"] } },
        },
        required: ["id", "label", "kind", "pins"],
      },
      minItems: 2,
      maxItems: 6,
    },
    wires: {
      type: "array",
      items: { type: "object", properties: { from: { type: "string" }, to: { type: "string" }, color: { type: "string" }, label: { type: "string" } }, required: ["from", "to", "color"] },
      minItems: 1,
      maxItems: 10,
    },
    steps: {
      type: "array",
      items: { type: "object", properties: { text: { type: "string" }, wires: { type: "array", items: { type: "integer" } }, tip: { type: "string" } }, required: ["text", "wires"] },
      minItems: 1,
      maxItems: 8,
    },
    safety: { type: "array", items: { type: "string" } },
    videoQuery: { type: "string" },
  },
  required: ["title", "components", "wires", "steps", "safety", "videoQuery"],
};

/** One hand-checked guide, minus its code, as the worked example for drafting. */
const EXAMPLE = (() => {
  const servo = CIRCUITS.find((c) => c.spec.id === "arduino-servo")!.spec;
  const { id: _id, code: _code, verified: _v, ...rest } = servo;
  return { user: "How do I connect a servo to my Arduino?", assistant: JSON.stringify(rest) };
})();

function stepsMarkdown(spec: DiagramSpec): string {
  return spec.steps.map((s, i) => `${i + 1}. ${s.text}${s.tip ? `\n   _Tip: ${s.tip}_` : ""}`).join("\n");
}

export const hardwarePilotAgent: AgentFn = async (input, ctx) => {
  assertNotAborted(ctx);

  let spec = findCircuit(input.requestText);
  let rejected: string | null = null;
  if (!spec) {
    // Draft -> electrical check -> one retry with the problem fed back. A draft that
    // still shorts something is never drawn.
    let feedback = "";
    for (let attempt = 0; attempt < 2 && !spec; attempt++) {
      const draft = validateSpec(
        await generateJson(DRAFT_SYSTEM, input.requestText + previousTurnText(input) + feedback, {
          signal: ctx.signal,
          schema: DRAFT_SCHEMA,
          examples: [EXAMPLE],
          temperature: attempt === 0 ? 0.2 : 0.5,
          maxTokens: 1200,
        })
      );
      assertNotAborted(ctx);
      if (!draft) continue;
      // A draft that borrows the example's servo wiring for some other part is copying, not reasoning.
      const copied = !/\bservo\b/i.test(input.requestText) && /\bservo|orange\/yellow\b/i.test(JSON.stringify(draft));
      rejected = electricalProblem(draft) ?? stepsInconsistent(draft) ?? (copied ? "it copied the servo example instead of this part's real pins" : null);
      if (rejected) feedback = `\n\nYour previous answer was rejected: ${rejected}. Use this part's real pins, and connect each part pin to exactly one board pin.`;
      else spec = draft;
    }
  }
  logAgentAction(input.runId, "HardwarePilot", "build_guide", { guide: spec?.id ?? null, verified: spec?.verified ?? false, model: spec?.verified ? null : agentModel() }, spec ? "completed" : "no_guide");

  if (!spec) {
    return {
      status: "partial_success",
      findings: [
        ...(rejected ? [`I drafted a wiring plan but held it back because it wasn't reliable (${rejected}).`] : []),
        "I don't have a checked wiring guide for that, and I won't guess at wiring that could damage your parts. Tell me the exact parts (for example \"Arduino Uno + HC-SR04 sensor\" or \"laptop with USB-C + HDMI monitor\").",
        `Guides I know well: ${allGuides().map((g) => g.title.replace(/^(Connect an? |Blink |Read |Make |Measure |Control |Light |Set up )/i, "").toLowerCase()).join("; ")}.`,
        `**Watch it done:** [how-to videos](https://www.youtube.com/results?search_query=${encodeURIComponent(input.requestText.slice(0, 80))})`,
      ],
      evidence: [],
      confidence: 0.2,
      limitations: ["Without a known guide or the AI model, HardwarePilot can't draw a diagram."],
      proposedActions: [],
    };
  }

  const findings = [
    `**${spec.title}**\n\n${stepsMarkdown(spec)}`,
    `**Safety**\n${spec.safety.map((s) => `- ${s}`).join("\n")}`,
    ...(spec.code ? [`**Starter code**\n\n\`\`\`${spec.code.language}\n${spec.code.source}\n\`\`\``] : []),
    `**Watch it done:** [how-to videos for "${spec.videoQuery}"](https://www.youtube.com/results?search_query=${encodeURIComponent(spec.videoQuery)})`,
  ];

  return {
    status: "success",
    findings,
    evidence: [evidence(spec.verified ? `hardware-guide:${spec.id}` : `ai-model:${agentModel()}`, spec.title)],
    confidence: spec.verified ? 0.9 : 0.5,
    limitations: spec.verified
      ? ["Pin names follow the most common board/module versions; check the labels printed on your parts."]
      : [modelLimitation(), "This guide was drafted by the AI model: compare each connection with your parts' datasheet or labels before powering on."],
    proposedActions: [],
    attachments: [{ type: "wiring-diagram", spec }],
  };
};
