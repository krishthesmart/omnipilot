import type { AgentFn } from "./base.js";
import { assertNotAborted, evidence, logAgentAction, previousTurnText } from "./base.js";
import { agentModel, generateJson, modelLimitation } from "../lib/llm.js";
import { KINDS, SCENES, planFromWords, renderSvg, svgDataUri, titleFrom, unsafePictureReason, validatePlan } from "../lib/picture.js";

// PicturePilot makes pictures for free: the AI model plans a scene and OmniPilot
// draws it as an illustration. Video generation is intentionally not offered.

const PLAN_SYSTEM =
  "You are PicturePilot. Plan a simple, friendly illustration for the user's request. Pick a scene and place objects from the allowed list. " +
  "x and y are the object's centre as a percent of the picture's width and height (y=0 is the top; the ground starts at y=72, so ground objects sit around y=60-80 and sky objects around y=10-40). " +
  "size is the object's height as a percent of the picture's height. Use the colours the user mentions. Include only what fits the request, 2-10 objects.";

const PLAN_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    scene: { type: "string", enum: [...SCENES] },
    objects: {
      type: "array",
      items: {
        type: "object",
        properties: {
          kind: { type: "string", enum: [...KINDS] },
          x: { type: "number" },
          y: { type: "number" },
          size: { type: "number" },
          color: { type: "string" },
        },
        required: ["kind", "x", "y", "size"],
      },
      minItems: 1,
      maxItems: 12,
    },
    caption: { type: "string" },
  },
  required: ["title", "scene", "objects", "caption"],
};

const EXAMPLE = {
  user: "Draw a red car next to a house on a sunny day",
  assistant: JSON.stringify({
    title: "Red car by the house",
    scene: "day",
    objects: [
      { kind: "sun", x: 85, y: 15, size: 20 },
      { kind: "cloud", x: 30, y: 15, size: 14 },
      { kind: "house", x: 35, y: 58, size: 38 },
      { kind: "car", x: 70, y: 72, size: 18, color: "red" },
      { kind: "tree", x: 10, y: 58, size: 40 },
    ],
    caption: "A red car parked beside a cosy house under a bright sun.",
  }),
};

const WANTS_VIDEO = /\b(video|animation|animated|movie|clip|gif)\b/i;

export const picturePilotAgent: AgentFn = async (input, ctx) => {
  assertNotAborted(ctx);
  const prompt = input.requestText;

  const unsafe = unsafePictureReason(prompt);
  if (unsafe) {
    logAgentAction(input.runId, "PicturePilot", "make_picture", { prompt: prompt.slice(0, 200) }, "refused");
    return {
      status: "failed_safe",
      findings: [`${unsafe} I'm happy to draw something else: an animal, a place, a robot, a space scene…`],
      evidence: [],
      confidence: 0.9,
      limitations: [],
      proposedActions: [],
    };
  }

  const notes: string[] = [];
  if (WANTS_VIDEO.test(prompt)) notes.push("I make still pictures only: video generation isn't offered.");

  const raw = await generateJson(PLAN_SYSTEM, prompt + previousTurnText(input), {
    signal: ctx.signal,
    schema: PLAN_SCHEMA,
    examples: [EXAMPLE],
    temperature: 0.4,
    maxTokens: 700,
  });
  assertNotAborted(ctx);
  const planned = validatePlan(raw, prompt);
  const spec = planned ?? planFromWords(prompt);
  const src = svgDataUri(renderSvg(spec));
  logAgentAction(input.runId, "PicturePilot", "make_picture", { mode: "illustration", planner: planned ? agentModel() : "keywords", objects: spec.objects.length }, "completed");

  return {
    status: "success",
    findings: [`Here's your picture: **${spec.title}**.${spec.caption ? ` ${spec.caption}` : ""}`, ...notes],
    evidence: [evidence(planned ? `ai-model:${agentModel()}` : "picturepilot:keywords", `${spec.objects.length} objects, ${spec.scene} scene`)],
    confidence: planned ? 0.7 : 0.55,
    limitations: [
      "This is a simple illustration drawn from a set of shapes, not a photo-style image.",
      ...(planned ? [modelLimitation()] : []),
    ],
    proposedActions: [],
    attachments: [{ type: "picture", title: spec.title, caption: spec.caption, src, mode: "illustration" }],
  };
};
