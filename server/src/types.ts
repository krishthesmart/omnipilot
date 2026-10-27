export const AGENT_NAMES = [
  "InfraPilot",
  "Helper",
  "CodePilot",
  "PromptPilot",
  "ScienceLab",
  "ScriptScholar",
  "LearnPilot",
  "WatcherPilot",
  "HardwarePilot",
  "MathPilot",
  "PicturePilot",
  "SchoolPilot",
  "ModelPilot",
] as const;

export type AgentName = (typeof AGENT_NAMES)[number];

export const AGENT_STATUSES = [
  "success",
  "partial_success",
  "needs_connection",
  "missing_permissions",
  "timeout",
  "unreachable",
  "failed_safe",
  "needs_approval",
] as const;

export type AgentStatus = (typeof AGENT_STATUSES)[number];

export type RiskLevel = "low" | "medium" | "high";

export interface ProposedAction {
  id: string;
  description: string;
  riskLevel: RiskLevel;
  requiresApproval: boolean;
  /** What approving it would change (CodePilot's fixes: a unified diff of the file). */
  preview?: string;
}

export interface Evidence {
  source: string;
  detail: string;
}

export interface AgentResult {
  agent: AgentName;
  status: AgentStatus;
  findings: string[];
  evidence: Evidence[];
  confidence: number; // 0..1
  limitations: string[];
  proposedActions: ProposedAction[];
  startedAt: string;
  completedAt: string;
  elapsedMs: number;
  retries: number;
  /** The sub-task the Coordinator gave this agent (may be narrower than the full request). */
  task?: string;
  /** Agents whose results were passed to this one before it ran. */
  usedResultsFrom?: AgentName[];
  /** Set when the Coordinator ran this agent to cover another agent's gap. */
  coveringFor?: AgentName;
  /** "support" results (e.g. PromptPilot's decomposition) inform the run but aren't part of the user-facing answer. */
  role?: "answer" | "support";
  /** Set when the user pressed Stop while this agent was working. */
  stopped?: boolean;
  /** Rich, interactive output the UI renders next to the answer (wiring diagrams, focus-session setup). */
  attachments?: Attachment[];
}

export type Attachment =
  | { type: "wiring-diagram"; spec: import("./lib/circuits.js").DiagramSpec }
  | { type: "watcher-setup"; policy: Partial<import("./lib/watcher.js").WatcherPolicy>; blockedExamples: string[] }
  /** LearnPilot's interactive diagram: a cycle or a sequence of steps; each part opens its explanation. */
  | { type: "concept-diagram"; kind: "cycle" | "steps"; title: string; nodes: { label: string; detail: string }[] }
  /** A web page CodePilot wrote, shown live in a sandboxed frame (scripts run, but it can't reach the app). */
  | { type: "html-preview"; title: string; html: string }
  /** A button that opens the parent's (PIN-protected) focus-session controls. */
  | { type: "watcher-manage"; task: string | null }
  | { type: "picture"; title: string; caption: string; src: string; mode: "illustration" }
  /** A multi-file project CodePilot built: every file, browsable before it's created. */
  /** ModelPilot's interactive 3D model (rendered with three.js: explore, explode, export). */
  | { type: "model-3d"; model: import("./lib/model3d.js").Model3D }
  | { type: "code-project"; title: string; folder: string; files: { path: string; content: string; language: string }[]; checks: string; run: string; test: string };

/** One unit of work in the Coordinator's plan. */
export interface CoordinatorStep {
  agent: AgentName;
  task: string;
  dependsOn: AgentName[];
  reason: string;
  /** Runs after every other step, and only if no agent blocked the request on safety grounds. */
  afterAll?: boolean;
}

/** What an agent receives from the agents it depends on (via AgentInput.context.priorResults). */
export interface PriorResult {
  agent: AgentName;
  task?: string;
  findings: string[];
  evidence: Evidence[];
}

export interface AgentInput {
  runId: string;
  requestText: string;
  /** Free-form structured payload extracted from the request by the Router/PromptPilot (e.g. code snippet, grade level) */
  context: Record<string, unknown>;
}

export interface RouterPlan {
  selectedAgents: AgentName[];
  rationale: Record<AgentName, string>;
  scores: Record<AgentName, number>;
  /** "model" when the AI model (Groq) answered and contributed to this plan; "heuristic-only" when it was unavailable/unreachable and the keyword classifier ran alone. */
  routingMode: "model" | "heuristic-only";
  modelUsed?: string;
  /** What the AI model itself selected, before merging with the heuristic's recall safety-net. */
  localModelAgents?: AgentName[];
}

export interface SynthesizerDraft {
  summary: string;
  agreements: string[];
  disagreements: string[];
  gaps: string[];
  sources: Evidence[];
  limitations: string[];
  partialResults: AgentName[];
  perAgent: { agent: AgentName; findings: string[]; confidence: number }[];
}

export interface RouterReview {
  approved: boolean;
  clarifyingQuestion?: string;
  adjustments: string[];
  finalSummary: string;
  finalLimitations: string[];
  finalConfidence: number;
}

export interface AuditLogEntry {
  id: string;
  runId: string;
  timestamp: string;
  agent: string;
  action: string;
  parameters: Record<string, unknown>;
  outcome: string;
}

export interface RunRecord {
  id: string;
  request: string;
  /** A follow-up rewritten to stand alone, when it differs from `request`. */
  standaloneRequest?: string;
  conversationId?: string;
  createdAt: string;
  status: "running" | "needs_clarification" | "needs_approval" | "completed" | "failed" | "cancelled";
  plan?: RouterPlan;
  steps?: CoordinatorStep[];
  agentResults?: AgentResult[];
  draft?: SynthesizerDraft;
  review?: RouterReview;
  finalResponse?: FinalResponse;
}

export interface FinalResponse {
  summary: string;
  sources: Evidence[];
  limitations: string[];
  confidence: number;
  nextActions: ProposedAction[];
  agentResults: AgentResult[];
  attachments?: Attachment[];
  clarifyingQuestion?: string;
  /** Governance: whether everything asked could be done (and why not, if not). */
  governance?: { verdict: "possible" | "partly_possible" | "not_possible"; reasons: string[] };
}

export type RunEvent =
  | { type: "run_started"; runId: string; request: string }
  | { type: "followup_resolved"; runId: string; original: string; standalone: string }
  | { type: "router_plan"; runId: string; plan: RouterPlan }
  | { type: "coordinator_plan"; runId: string; steps: CoordinatorStep[] }
  | { type: "coordinator_followup"; runId: string; step: CoordinatorStep }
  | { type: "agent_start"; runId: string; agent: AgentName }
  | { type: "agent_retry"; runId: string; agent: AgentName; attempt: number }
  | { type: "agent_complete"; runId: string; result: AgentResult }
  | { type: "synthesizer_start"; runId: string }
  | { type: "answer_delta"; runId: string; delta: string }
  | { type: "synthesizer_draft"; runId: string; draft: SynthesizerDraft }
  | { type: "router_review_start"; runId: string }
  | { type: "router_review"; runId: string; review: RouterReview }
  | { type: "clarification_needed"; runId: string; question: string }
  | { type: "final_response"; runId: string; response: FinalResponse }
  | { type: "audit"; runId: string; entry: AuditLogEntry }
  | { type: "run_failed"; runId: string; error: string }
  | { type: "run_cancelled"; runId: string };
