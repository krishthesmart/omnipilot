export type AgentName =
  | "InfraPilot"
  | "Helper"
  | "CodePilot"
  | "PromptPilot"
  | "ScienceLab"
  | "ScriptScholar"
  | "LearnPilot"
  | "WatcherPilot"
  | "HardwarePilot"
  | "MathPilot"
  | "PicturePilot"
  | "SchoolPilot"
  | "ModelPilot";

export type AgentStatus =
  | "success"
  | "partial_success"
  | "needs_connection"
  | "missing_permissions"
  | "timeout"
  | "unreachable"
  | "failed_safe"
  | "needs_approval"
  | "running"
  | "queued";

export interface ProposedAction {
  id: string;
  description: string;
  riskLevel: "low" | "medium" | "high";
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
  skill?: string; // the ability used, when it's one of a specialist's skills (e.g. Helper -> "pictures")
  status: AgentStatus;
  findings: string[];
  evidence: Evidence[];
  confidence: number;
  limitations: string[];
  proposedActions: ProposedAction[];
  startedAt: string;
  completedAt: string;
  elapsedMs: number;
  retries: number;
  task?: string;
  usedResultsFrom?: AgentName[];
  coveringFor?: AgentName;
  role?: "answer" | "support";
  stopped?: boolean;
  attachments?: Attachment[];
}

export interface DiagramSpec {
  id: string;
  title: string;
  components: { id: string; label: string; kind: string; pins: { id: string; label: string }[] }[];
  wires: { from: string; to: string; color: string; label?: string }[];
  steps: { text: string; wires: number[]; tip?: string }[];
  safety: string[];
  videoQuery: string;
  code?: { language: string; source: string };
  verified: boolean;
}

export interface WatcherPolicy {
  active: boolean;
  task: string;
  subject: "math" | "reading" | "writing" | "science" | "coding" | "history" | "languages" | null;
  blockAI: boolean;
  blockAIExtensions: boolean;
  onTaskOnly: boolean;
  allow: string[];
  block: string[];
  until: string | null;
}

export type Attachment =
  | { type: "wiring-diagram"; spec: DiagramSpec }
  | { type: "watcher-setup"; policy: Partial<WatcherPolicy>; blockedExamples: string[] }
  | { type: "watcher-manage"; task: string | null }
  | { type: "html-preview"; title: string; html: string }
  | { type: "concept-diagram"; kind: "cycle" | "steps"; title: string; nodes: { label: string; detail: string }[] }
  | { type: "picture"; title: string; caption: string; src: string; mode: "illustration" }
  | { type: "model-3d"; model: Model3D }
  | { type: "code-project"; title: string; folder: string; files: { path: string; content: string; language: string }[]; checks: string; run: string; test: string };

export interface Model3DPart {
  id: string;
  name: string;
  description: string;
  shape: "box" | "sphere" | "cylinder" | "cone" | "torus" | "capsule";
  size: number[];
  position: [number, number, number];
  rotation: [number, number, number];
  color: string;
  material: "plastic" | "metal" | "glass" | "rubber" | "wood" | "emissive" | "matte";
  group: string;
}

export interface Model3D {
  title: string;
  description: string;
  units: string;
  parts: Model3DPart[];
  separate?: boolean;
  notes?: string[];
}

export interface MathStatus {
  running: boolean;
  paused: boolean;
  finished: boolean;
  enabled: boolean;
  checked: number;
  perSecond: number;
  stage: number;
  stages: number;
  stageProgress: number;
  stageLabel: string;
  discoveries: number;
}

export interface Discovery {
  id: number;
  at: string;
  constant: string;
  a: number[];
  b: number[];
  relation: [number, number, number, number];
  value: string;
  digits: number;
  variants: number;
  text: string;
}

export interface IdentityCheck {
  verdict: "true" | "false" | "unclear";
  detail: string;
}

export interface CoordinatorStep {
  agent: AgentName;
  task: string;
  dependsOn: AgentName[];
  reason: string;
  afterAll?: boolean;
  skill?: string;
}

export interface RouterPlan {
  selectedAgents: AgentName[];
  rationale: Record<string, string>;
  scores: Record<string, number>;
  routingMode: "model" | "heuristic-only";
  modelUsed?: string;
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

export interface FinalResponse {
  summary: string;
  sources: Evidence[];
  limitations: string[];
  confidence: number;
  nextActions: ProposedAction[];
  agentResults: AgentResult[];
  attachments?: Attachment[];
  clarifyingQuestion?: string;
}

export interface AuditLogEntry {
  id: string;
  run_id: string;
  timestamp: string;
  agent: string;
  action: string;
  parameters: Record<string, unknown>;
  outcome: string;
}

export interface Approval {
  id: string;
  run_id: string;
  agent: string;
  description: string;
  risk_level: "low" | "medium" | "high";
  status: "pending" | "approved" | "denied";
  created_at: string;
  decided_at?: string;
}

export interface Connector {
  name: string;
  kind: string;
  verification: "token" | "oauth";
  status: "connected" | "not_connected";
  account_label?: string | null;
  connected_at?: string | null;
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

/** Client-side view model for one chat turn, built up incrementally from SSE events. */
export interface RunViewState {
  runId: string;
  request: string;
  phase: "planning" | "running_agents" | "synthesizing" | "reviewing" | "clarification_needed" | "done" | "failed" | "cancelled";
  plan?: RouterPlan;
  /** How a follow-up was understood, when it was rewritten to stand alone. */
  standalone?: string;
  /** The combined answer as it streams in, before the final response arrives. */
  streamingAnswer?: string;
  steps?: CoordinatorStep[];
  agents: Record<string, { status: AgentStatus; startedAt?: number; result?: AgentResult; retries: number }>;
  draft?: SynthesizerDraft;
  review?: RouterReview;
  finalResponse?: FinalResponse;
  clarifyingQuestion?: string;
  error?: string;
  audit: AuditLogEntry[];
}
