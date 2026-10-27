import type { AgentFn } from "./base.js";
import type { AgentName } from "../types.js";
import { AGENT_SPECS } from "./registry.js";
import { infraPilotAgent } from "./infraPilot.js";
import { helperAgent } from "./helper.js";
import { codePilotAgent } from "./codePilot.js";
import { promptPilotAgent } from "./promptPilot.js";
import { scienceLabAgent } from "./scienceLab.js";
import { scriptScholarAgent } from "./scriptScholar.js";
import { learnPilotAgent } from "./learnPilot.js";
import { watcherPilotAgent } from "./watcherPilot.js";
import { hardwarePilotAgent } from "./hardwarePilot.js";
import { mathPilotAgent } from "./mathPilot.js";
import { picturePilotAgent } from "./picturePilot.js";
import { schoolPilotAgent } from "./schoolPilot.js";
import { modelPilotAgent } from "./modelPilot.js";

export const AGENTS: Record<AgentName, AgentFn> = {
  InfraPilot: infraPilotAgent,
  Helper: helperAgent,
  CodePilot: codePilotAgent,
  PromptPilot: promptPilotAgent,
  ScienceLab: scienceLabAgent,
  ScriptScholar: scriptScholarAgent,
  LearnPilot: learnPilotAgent,
  WatcherPilot: watcherPilotAgent,
  HardwarePilot: hardwarePilotAgent,
  MathPilot: mathPilotAgent,
  PicturePilot: picturePilotAgent,
  SchoolPilot: schoolPilotAgent,
  ModelPilot: modelPilotAgent,
};

/** Per-agent timeout budget and retry allowance (declared in registry.ts), isolated so one slow agent never blocks the rest. */
export const AGENT_BUDGETS = Object.fromEntries(
  (Object.keys(AGENTS) as AgentName[]).map((a) => [a, AGENT_SPECS[a].budget])
) as Record<AgentName, { timeoutMs: number; maxRetries: number }>;
