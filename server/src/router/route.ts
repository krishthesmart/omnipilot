import { AGENT_NAMES, type AgentName, type RouterPlan } from "../types.js";
import { AGENT_SPECS } from "../agents/registry.js";
import { decideAgents, finalizeSelection } from "./decisionModel.js";
import { callRouterModel, routerModel } from "./routerModel.js";

/**
 * The Router's actual entry point: runs the deterministic heuristic and asks
 * the AI model too. The heuristic is precise but brittle; the
 * model understands paraphrases but over-selects (e.g. ScriptScholar for a
 * "linked list" request). So:
 *   - when the heuristic matched something, the heuristic's picks are the
 *     plan -- the model can confirm them but not add unrelated specialists;
 *   - when the heuristic matched nothing, the model's picks replace the
 *     Helper fallback (this is where paraphrased requests benefit);
 *   - the model alone never adds PromptPilot -- it is a decomposer that
 *     finalizeSelection() adds automatically for compound requests.
 * If the AI model is unavailable/unreachable, the plan is exactly the
 * heuristic's. The Router performs no specialist work itself either way.
 */
export async function routeRequest(requestText: string): Promise<RouterPlan> {
  const heuristicPlan = decideAgents(requestText);
  // When keywords matched, the plan is the keyword plan whatever the model says (it can only
  // confirm those picks), so the model is asked only when nothing matched. That saves a large
  // prompt on most requests, inside Groq's free-tier token limit.
  const heuristicMatched = AGENT_NAMES.some((a) => heuristicPlan.scores[a] >= 1);
  if (heuristicMatched) return heuristicPlan;
  const localAgents = await callRouterModel(requestText);

  if (!localAgents) {
    return heuristicPlan;
  }

  // Narrow specialists (ScienceLab, ScriptScholar...) only when their own keywords match: a request
  // that's really about their topic would have matched them, so here Helper answers instead.
  const accepted = new Set<AgentName>(localAgents.filter((a) => a !== "PromptPilot" && !AGENT_SPECS[a].narrow));

  const rationale: Record<AgentName, string> = { ...heuristicPlan.rationale };
  const scores: Record<AgentName, number> = { ...heuristicPlan.scores };

  for (const agent of AGENT_NAMES) {
    const fromHeuristic = heuristicMatched && heuristicPlan.selectedAgents.includes(agent);
    const fromModel = accepted.has(agent);
    if (fromModel) scores[agent] = Math.max(scores[agent] ?? 0, 1);
    if (localAgents.includes(agent) && !fromModel && !fromHeuristic) {
      rationale[agent] = `${routerModel()} (AI model) suggested it, but it was not accepted: ${
        agent === "PromptPilot" ? "PromptPilot is only added for compound requests" : "it only handles requests that clearly name its topic"
      }.`;
    }
    if (fromHeuristic && fromModel) {
      rationale[agent] = `Matched by both the keyword heuristic and ${routerModel()} (AI model).`;
    } else if (fromModel) {
      rationale[agent] = `Selected by ${routerModel()} (AI model); no keyword pattern matched.`;
    } else if (fromHeuristic) {
      rationale[agent] = `Matched by the keyword heuristic; ${routerModel()} (AI model) did not select it.`;
    }
  }

  // The heuristic's Helper default only stands if the model contributed nothing usable.
  const base = heuristicMatched || accepted.size === 0 ? heuristicPlan.selectedAgents : [];
  const merged = new Set<AgentName>([...base, ...accepted]);
  const { selected, rationale: finalRationale, scores: finalScores } = finalizeSelection(requestText, Array.from(merged), rationale, scores);

  return {
    selectedAgents: selected,
    rationale: finalRationale,
    scores: finalScores,
    routingMode: "model",
    modelUsed: routerModel(),
    localModelAgents: localAgents,
  };
}
