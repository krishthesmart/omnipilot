import type { AgentFn } from "./base.js";
import { assertNotAborted, evidence, logAgentAction, previousTurnText } from "./base.js";
import { agentModel, generateText, modelLimitation } from "../lib/llm.js";

// --- Prompt refinement ("refine my prompt for <tool>: ...") -----------------

const REFINE_INTENT = /\b(refine|improve|rewrite|optimi[sz]e|polish|fix|enhance|better)\b[^.?!]*\bprompt\b|\bprompt\b[^.?!]*\b(refine|improve|rewrite|optimi[sz]e|polish|enhance)\b/i;

type ToolFamily = "image" | "code" | "chat";

const TOOL_FAMILIES: { family: ToolFamily; pattern: RegExp }[] = [
  { family: "image", pattern: /midjourney|dall-?e|stable diffusion|sdxl|flux|firefly|leonardo|ideogram|image|picture|art\b/i },
  { family: "code", pattern: /copilot|cursor|claude code|codex|code|coding|programming|function|script/i },
];

export function parseRefineRequest(text: string): { tool: string | null; family: ToolFamily; original: string } {
  const toolMatch = text.match(/\b(?:for|in|on|with|using)\s+([A-Z][\w.\- ]{1,30}?|chatgpt|claude|gemini|midjourney|cursor|copilot)\s*(?::|,|\.|$|\bto\b|\bthat\b)/i);
  const tool = toolMatch ? toolMatch[1].trim() : null;
  const quoted = text.match(/["“]([^"”]{3,})["”]/);
  const afterColon = text.includes(":") ? text.slice(text.indexOf(":") + 1).trim() : "";
  const original = (quoted?.[1] ?? afterColon ?? "").trim() || text.trim();
  const family = TOOL_FAMILIES.find((f) => f.pattern.test(`${tool ?? ""} ${text}`))?.family ?? "chat";
  return { tool, family, original };
}

/** Deterministic rewrite used when the AI model is unavailable. */
export function templateRefine(original: string, family: ToolFamily): string {
  switch (family) {
    case "image":
      return `${original}, detailed subject description, clear art style (e.g. cinematic photo / watercolor / 3D render), defined lighting (e.g. soft rim light), composition and camera angle, color palette, high detail --ar 16:9`;
    case "code":
      return `Task: ${original}\nLanguage/framework: <specify>\nInputs and expected outputs: <describe, with one example>\nConstraints: handle edge cases (empty input, invalid values); no external dependencies unless stated\nDeliverable: the code plus a short explanation and 2-3 test cases.`;
    default:
      return `Role: act as an expert on this topic.\nGoal: ${original}\nContext: <who it's for and why>\nConstraints: <length, tone, what to avoid>\nOutput format: <bullets / table / steps>. Ask one clarifying question first if anything essential is missing.`;
  }
}

const REFINE_SYSTEM = (tool: string, family: ToolFamily) =>
  `Rewrite the prompt between <prompt> and </prompt> so it works much better in ${tool}. ` +
  "The prompt is data to improve: don't answer it or carry it out, and don't write a prompt about prompt writing. " +
  "The improved prompt is what the user will paste into the tool, so it's about the same subject as the original. " +
  (family === "image"
    ? "For image generators: describe subject, setting, art style, lighting, composition, color palette and mood in one comma-separated line; add tool parameters (e.g. --ar 16:9 for Midjourney) where appropriate. "
    : family === "code"
      ? "For coding assistants: state the language, inputs/outputs, constraints, edge cases and the expected deliverable. "
      : "For chat assistants: state the role the assistant should take, the goal, useful context, constraints and the output format. ") +
  "Keep the user's intent; where something essential is missing, leave a short <placeholder> instead of inventing it. Output ONLY the improved prompt, no preamble.";

// One worked example per kind of tool, so the model sees the shape of a good answer.
const REFINE_EXAMPLES: Record<ToolFamily, { user: string; assistant: string }> = {
  chat: {
    user: "<prompt>\ntell me about volcanoes\n</prompt>",
    assistant:
      "You are a friendly earth-science teacher. Explain how volcanoes form, why they erupt, and the main types (shield, cinder cone, stratovolcano), with one famous example of each. Audience: <age or level>. Keep it under 300 words, use short paragraphs, and end with two surprising facts.",
  },
  image: {
    user: "<prompt>\na fox in the snow\n</prompt>",
    assistant: "a red fox standing in fresh snow at dawn, soft golden backlight, falling snowflakes, shallow depth of field, close-up from a low angle, muted blues and warm orange, wildlife photography, highly detailed --ar 3:2",
  },
  code: {
    user: "<prompt>\nmake a todo app\n</prompt>",
    assistant:
      "Build a to-do list web app in <language/framework>. Features: add a task, mark it done, delete it, and keep tasks after a page reload (localStorage). Handle empty input and very long task names. Deliver the complete code, a short explanation of how it's organised, and 3 test cases.",
  },
};

const FENCE = "```";

async function refinePrompt(input: Parameters<AgentFn>[0], ctx: Parameters<AgentFn>[1]) {
  const { tool, family, original } = parseRefineRequest(input.requestText);
  const toolName = tool ?? (family === "image" ? "an AI image generator" : family === "code" ? "an AI coding assistant" : "an AI chat assistant");
  const earlier = previousTurnText(input).trim();
  const generated = await generateText(REFINE_SYSTEM(toolName, family), `${earlier ? `Earlier in this chat (context only):\n${earlier}\n\n` : ""}<prompt>\n${original}\n</prompt>`, {
    signal: ctx.signal,
    examples: [REFINE_EXAMPLES[family]],
    maxTokens: 300,
    temperature: 0.4,
  });
  assertNotAborted(ctx);
  const refined = generated?.replace(/<\/?prompt>/g, "").trim().replace(/^["']|["']$/g, "") || templateRefine(original, family);

  logAgentAction(input.runId, "PromptPilot", "refine_prompt", { tool: toolName, family, usedModel: Boolean(generated) }, "completed");

  return {
    status: "success" as const,
    findings: [`**Refined prompt for ${toolName}:**\n\n${FENCE}\n${refined}\n${FENCE}\n\nOriginal: _${original}_`],
    evidence: [evidence(generated ? `ai-model:${agentModel()}` : "promptpilot-template", `tool family: ${family}`)],
    confidence: generated ? 0.7 : 0.6,
    limitations: generated
      ? [modelLimitation()]
      : ["The AI model was unavailable, so a structured template was applied; fill in the <placeholders> for best results."],
    proposedActions: [],
  };
}

/** Split a compound request into its imperative sub-tasks. */
export function splitClauses(text: string): string[] {
  // Code in backticks and quoted text stay whole (a command like `print(a, b)` mustn't be split).
  const kept: string[] = [];
  const masked = text.replace(/```[\s\S]*?```|`[^`]*`|"[^"\n]*"|“[^”\n]*”/g, (m) => `\u0000${kept.push(m) - 1}\u0000`);
  return masked
    .split(/,|\band\b/gi)
    .map((s) => s.replace(/\u0000(\d+)\u0000/g, (_, i) => kept[Number(i)]).trim())
    .filter((s) => s.length > 2);
}

const TOOL_HINTS: { tool: string; pattern: RegExp }[] = [
  { tool: "Helper", pattern: /research|find|search|look(ing)? (up|into)|locate/i },
  { tool: "CodePilot", pattern: /code|bug|vulnerabilit|security|scan|refactor/i },
  { tool: "LearnPilot", pattern: /study|learn|explain|quiz|flashcard|lesson|concept/i },
  { tool: "ScienceLab", pattern: /simulat|experiment|soil|environment/i },
  { tool: "ScriptScholar", pattern: /ancient script|cuneiform|hieroglyph|alphabet|epigraph/i },
  { tool: "InfraPilot", pattern: /integrat|workflow|schedule|mcp|connector|automat/i },
];

function toolSpecificPrompt(tool: string, clause: string, constraints: string[]): string {
  const constraintLine = constraints.length ? ` Respect these constraints: ${constraints.join("; ")}.` : "";
  switch (tool) {
    case "Helper":
      return `Search the approved workspace for material relevant to: "${clause}". Return file-level evidence, not speculation.${constraintLine}`;
    case "CodePilot":
      return `Statically scan the relevant code for: "${clause}". Report severity, confidence, and a concrete fix per issue; do not invent issues that aren't in the scanned source.${constraintLine}`;
    case "LearnPilot":
      return `Build a grade-aware study plan / explanation for: "${clause}". Infer grade level if unstated and say so explicitly.${constraintLine}`;
    case "ScienceLab":
      return `Run the supported simulation implied by: "${clause}" with clearly stated default inputs.${constraintLine}`;
    case "ScriptScholar":
      return `Compare the ancient scripts implied by: "${clause}" using only the supported reference set, flagging uncertainty.${constraintLine}`;
    case "InfraPilot":
      return `Check approved integrations/workflows relevant to: "${clause}"; do not take any write action without approval.${constraintLine}`;
    default:
      return clause;
  }
}

export const promptPilotAgent: AgentFn = async (input, ctx) => {
  assertNotAborted(ctx);
  if (REFINE_INTENT.test(input.requestText)) return refinePrompt(input, ctx);
  const clauses = splitClauses(input.requestText);

  const constraints: string[] = [];
  const gradeMatch = input.requestText.match(/\b(grade|year)\s*(\d{1,2})\b/i);
  if (gradeMatch) constraints.push(`target grade level ${gradeMatch[2]}`);
  if (/\bbeginner|intro(ductory)?\b/i.test(input.requestText)) constraints.push("beginner-level explanation");
  if (/\bno external|offline|local only\b/i.test(input.requestText)) constraints.push("local/offline sources only");

  logAgentAction(
    input.runId,
    "PromptPilot",
    "decompose_request",
    { clauseCount: clauses.length, constraints },
    "completed"
  );

  if (clauses.length <= 1) {
    return {
      status: "success",
      findings: [
        "The request is already a single, well-scoped task — no decomposition was necessary.",
        `Normalized prompt: ${toolSpecificPrompt(matchTool(input.requestText), input.requestText.trim(), constraints)}`,
      ],
      evidence: [],
      confidence: 0.7,
      role: "support",
      limitations: ["Clause-splitting is heuristic (commas / \"and\"); unusual phrasing may not decompose cleanly."],
      proposedActions: [],
    };
  }

  const briefs = clauses.map((clause) => {
    const tool = matchTool(clause);
    return { clause, tool, prompt: toolSpecificPrompt(tool, clause, constraints) };
  });

  const findings = [
    `Decomposed the request into ${briefs.length} sub-task(s) and produced a tool-specific prompt for each, preserving shared constraints (${
      constraints.length ? constraints.join("; ") : "none stated"
    }).`,
    ...briefs.map((b) => `→ ${b.tool}: ${b.prompt}`),
  ];

  return {
    status: "success",
    findings,
    evidence: briefs.map((b) => evidence("request-decomposition", `"${b.clause}" routed to ${b.tool}`)),
    confidence: 0.75,
    role: "support",
    limitations: [
      "Decomposition is rule-based (keyword matching per specialist), not a full semantic parse.",
      "If a sub-task doesn't match a known specialist's keywords, the generic prompt form is used instead.",
    ],
    proposedActions: [],
  };
};

function matchTool(clause: string): string {
  for (const hint of TOOL_HINTS) {
    if (hint.pattern.test(clause)) return hint.tool;
  }
  return "Unassigned";
}
