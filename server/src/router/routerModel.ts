import { AGENT_NAMES, type AgentName } from "../types.js";
import { AGENT_SPECS } from "../agents/registry.js";
import { agentModel, generateJson } from "../lib/llm.js";

/** The model that routes requests (the same Groq model the agents use). */
export const routerModel = (): string => agentModel();

/** One routing call: a large model doesn't need the majority vote the small local ones did. */
export const SAMPLES = 1;

const AGENT_LIST = AGENT_NAMES.join(", ");

export const SYSTEM_PROMPT = `You are the routing classifier inside OmniPilot, a multi-agent assistant. Your ONLY job is to decide which specialist agent(s) a user's request needs -- you never answer the request yourself.

Specialists (choose only from this exact list of names): ${AGENT_LIST}
${AGENT_NAMES.map((a) => `- ${a}: ${AGENT_SPECS[a].description}`).join("\n")}

Rules:
- Select every specialist the request genuinely needs, and no others. Most single questions need exactly one.
- ${AGENT_NAMES.filter((a) => AGENT_SPECS[a].narrow).join(" and ")} are narrow: never select them unless the request is clearly about their topic.
- If unsure, choose Helper.`;

/** Few-shot examples: what good routing looks like, including the "just Helper" default. */
export const EXAMPLES: { user: string; agents: AgentName[] }[] = [
  { user: "Research how to improve my project, check my code for issues, and create a study plan.", agents: ["Helper", "CodePilot", "LearnPilot"] },
  { user: "How many days are in a leap year?", agents: ["Helper"] },
  { user: "If I earn $12 an hour for 30 hours, what do I make?", agents: ["Helper"] },
  { user: "Write a function that reverses a linked list", agents: ["CodePilot"] },
  { user: "Teach me how fractions work", agents: ["LearnPilot"] },
  { user: "How far does a ball thrown at 20 m/s at 45 degrees travel?", agents: ["ScienceLab"] },
  { user: "Make my Midjourney prompt better: a dog on a beach", agents: ["PromptPilot"] },
  { user: "How do I wire a button to my Arduino and how does it work?", agents: ["HardwarePilot", "LearnPilot"] },
  { user: "My kid should learn math for an hour with no AI", agents: ["WatcherPilot"] },
  { user: "Draw a dragon flying over a castle", agents: ["PicturePilot"] },
  { user: "Is it true that (a+b)^2 = a^2 + b^2?", agents: ["MathPilot"] },
  { user: "Solve 3x + 4 = 19", agents: ["Helper"] },
];

export const ROUTING_SCHEMA = {
  type: "object",
  properties: { agents: { type: "array", items: { type: "string", enum: [...AGENT_NAMES] }, minItems: 1, maxItems: 4 } },
  required: ["agents"],
};

/**
 * Asks the AI model which specialists a request needs (schema-constrained, few-shot). Returns null
 * (never throws) when the model can't answer or names no valid agents, so the caller falls back
 * to the deterministic keyword classifier.
 */
export async function callRouterModel(requestText: string): Promise<AgentName[] | null> {
  if (process.env.ROUTER_MODE === "heuristic") return null;
  const reply = await generateJson<{ agents: unknown }>(SYSTEM_PROMPT, requestText.slice(0, 2000), {
    schema: ROUTING_SCHEMA,
    examples: EXAMPLES.map((ex) => ({ user: ex.user, assistant: JSON.stringify({ agents: ex.agents }) })),
    temperature: 0,
    maxTokens: 80,
    signal: AbortSignal.timeout(Number(process.env.ROUTER_TIMEOUT_MS ?? 15_000)),
  });
  const raw = Array.isArray(reply?.agents) ? reply!.agents : null;
  if (!raw) return null;
  const validNames = new Set<string>(AGENT_NAMES);
  const valid = raw.filter((a: unknown): a is AgentName => typeof a === "string" && validNames.has(a));
  return valid.length > 0 ? Array.from(new Set(valid)) : null;
}
