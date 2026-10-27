export interface AskOptions {
  /** Groups questions so follow-ups can refer back. */
  conversationId?: string;
  /** Leave out pictures and diagrams (smaller replies for tiny devices). */
  textOnly?: boolean;
}

export interface Attachment {
  type: "wiring-diagram" | "watcher-setup" | "picture";
  [key: string]: unknown;
}

export interface Answer {
  runId: string;
  /** Returned to token (SDK) clients: needed to read this run again. */
  runKey?: string;
  status: "completed" | "needs_approval" | "needs_clarification" | "failed";
  answer: string;
  clarifyingQuestion?: string;
  confidence?: number;
  agents?: { agent: string; status: string }[];
  limitations?: string[];
  attachments?: Attachment[];
}

export interface StreamOptions {
  conversationId?: string;
  onDelta?: (text: string) => void;
  onEvent?: (event: { type: string; [key: string]: unknown }) => void;
  signal?: AbortSignal;
}

export interface IdentityCheck {
  verdict: "true" | "false" | "unclear";
  left: string;
  right: string;
  detail: string;
  pointsTested?: number;
  counterexample?: { values: Record<string, number>; left: number; right: number };
  digits?: number;
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

export class OmniPilotError extends Error {
  status: number;
  body: unknown;
}

export class OmniPilot {
  constructor(options?: { baseUrl?: string; token?: string; fetch?: typeof fetch });
  baseUrl: string;
  ask(message: string, options?: AskOptions): Promise<Answer>;
  stream(message: string, options?: StreamOptions): Promise<Answer>;
  conversation(): { id: string; ask(message: string, options?: AskOptions): Promise<Answer>; stream(message: string, options?: StreamOptions): Promise<Answer> };
  checkIdentity(equation: string): Promise<IdentityCheck>;
  mathStatus(): Promise<MathStatus>;
  discoveries(options?: { after?: number; limit?: number }): Promise<Discovery[]>;
  status(): Promise<{ version: string; localModel: { reachable: boolean; ready: boolean }; codeVerify: boolean }>;
}

export default OmniPilot;
