import type { Approval, Connector, Discovery, IdentityCheck, MathStatus, RunEvent, WatcherPolicy } from "./types";

export interface Attachment {
  name: string;
  text: string;
}

export async function sendChat(message: string, conversationId: string, attachment?: Attachment): Promise<{ runId: string }> {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, conversationId, ...(attachment ? { attachment } : {}) }),
  });
  if (!res.ok) throw new Error(`chat request failed: ${res.status}`);
  return res.json();
}

/** A PDF, Word or PowerPoint file as text (PDFs are read on this computer; see the server for details). */
export async function parseAttachment(file: File): Promise<Attachment & { where: string; truncated: boolean }> {
  const res = await fetch(`/api/attachments/parse?name=${encodeURIComponent(file.name.slice(0, 120))}`, {
    method: "POST",
    headers: { "Content-Type": file.type || "application/octet-stream" },
    body: file,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.message ?? `Couldn't read that file (${res.status}).`);
  return body;
}

/**
 * A run's events as they happen: a live stream, or, where streams don't get through (Cloudflare's free
 * quick tunnels), asking for what's new every second. Each event is delivered once, in order.
 */
/** Events after which a run sends nothing more (same as the engine's TERMINAL set). */
const FINISHED_EVENTS = new Set(["final_response", "clarification_needed", "run_failed", "run_cancelled"]);

export function subscribeToRun(runId: string, onEvent: (evt: RunEvent) => void): () => void {
  let delivered = 0;
  let closed = false;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  const deliver = (evt: RunEvent) => {
    delivered++;
    onEvent(evt);
  };
  const source = new EventSource(`/api/runs/${runId}/events`);
  const poll = async () => {
    if (closed) return;
    try {
      const res = await fetch(`/api/runs/${runId}/events.json?after=${delivered}`, { cache: "no-store" });
      if (res.ok) {
        const body = (await res.json()) as { events: RunEvent[]; done: boolean };
        body.events.forEach(deliver);
        if (body.done) return;
      }
    } catch {
      // offline for a moment: try again
    }
    pollTimer = setTimeout(poll, 1000);
  };
  const switchToPolling = () => {
    if (closed || pollTimer) return;
    source.close();
    pollTimer = setTimeout(poll, 0);
  };
  // No event within 3 seconds (a run always starts with one) means the stream isn't getting through.
  const fallback = setTimeout(() => delivered === 0 && switchToPolling(), 3000);
  source.onmessage = (ev) => {
    let evt: RunEvent;
    try {
      evt = JSON.parse(ev.data);
    } catch {
      return; // heartbeat / non-JSON comment lines are ignored
    }
    deliver(evt);
    // The run is over: close the stream. Otherwise the browser reconnects a few seconds after the server ends it,
    // the whole run is replayed from "run_started", and the answer's state (an approval just decided) is reset.
    if (FINISHED_EVENTS.has(evt.type)) {
      closed = true;
      clearTimeout(fallback);
      source.close();
    }
  };
  source.onerror = () => {
    // A finished run's stream ends normally; only fall back if it ended early.
    if (source.readyState === EventSource.CLOSED || delivered === 0) switchToPolling();
  };
  return () => {
    closed = true;
    clearTimeout(fallback);
    if (pollTimer) clearTimeout(pollTimer);
    source.close();
  };
}

export async function fetchApprovals(runId?: string): Promise<Approval[]> {
  const res = await fetch(`/api/approvals${runId ? `?runId=${runId}` : ""}`);
  const data = await res.json();
  return data.approvals;
}

export class ApprovalError extends Error {}

/** Records a decision; approving a CodePilot fix also applies it (`applied` says to which file). */
export async function decideApproval(id: string, decision: "approved" | "denied"): Promise<Approval & { applied?: { file: string; files?: string[] } | null; outcome?: { ok: boolean; message: string; url?: string } | null }> {
  const res = await fetch(`/api/approvals/${id}/decision`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ decision }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new ApprovalError(data?.message ?? (res.status === 409 ? "This was already decided." : `approval decision failed: ${res.status}`));
  }
  return res.json();
}

/** Puts back the original file after an applied fix. */
export async function undoApproval(id: string): Promise<void> {
  const res = await fetch(`/api/approvals/${id}/undo`, { method: "POST" });
  if (!res.ok) throw new ApprovalError((await res.json().catch(() => null))?.message ?? "Couldn't undo that.");
}

export async function fetchConnectors(): Promise<Connector[]> {
  const res = await fetch("/api/connectors");
  const data = await res.json();
  return data.connectors;
}

export class ConnectorError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export async function connectConnector(name: string, token?: string, account?: string): Promise<Connector> {
  const res = await fetch(`/api/connectors/${encodeURIComponent(name)}/connect`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(token ? { token, ...(account ? { account } : {}) } : {}),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ConnectorError(body.error ?? "unknown_error", body.message ?? `Connect failed (${res.status})`);
  }
  return body;
}

/** Google Drive: starts Google's sign-in and returns the consent page to open. */
export async function startDriveSignIn(clientId: string, clientSecret: string): Promise<string> {
  const res = await fetch(`/api/connectors/${encodeURIComponent("Google Drive")}/oauth/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientId, clientSecret, origin: window.location.origin }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ConnectorError(body.error ?? "unknown_error", body.message ?? `Sign-in failed (${res.status})`);
  return body.url;
}

export async function disconnectConnector(name: string): Promise<Connector> {
  const res = await fetch(`/api/connectors/${encodeURIComponent(name)}/disconnect`, { method: "POST" });
  if (!res.ok) throw new Error(`disconnect failed: ${res.status}`);
  return res.json();
}

export async function fetchAudit(runId?: string): Promise<any[]> {
  const res = await fetch(`/api/audit${runId ? `?runId=${runId}` : ""}`);
  const data = await res.json();
  return data.entries;
}

// --- WatcherPilot ---

export interface WatcherState {
  policy: WatcherPolicy;
  hasPin: boolean;
  locked: boolean;
}

export async function fetchWatcher(): Promise<WatcherState> {
  const res = await fetch("/api/watcher/policy");
  return res.json();
}

/** Errors come back as "wrong_pin" | "pin_required" | "locked" | "invalid_request". */
export async function saveWatcher(policy: WatcherPolicy, pin: string, newPin?: string): Promise<{ policy?: WatcherPolicy; error?: string }> {
  const res = await fetch("/api/watcher/policy", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ policy, pin, newPin }),
  });
  return res.json();
}

export async function fetchWatcherEvents(pin: string): Promise<{ events?: { at: string; url: string; title: string; reason: string }[]; error?: string }> {
  const res = await fetch("/api/watcher/events", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pin }),
  });
  return res.json();
}

export interface AppStatus {
  version: string;
  /** The AI model (Groq): set up, answering, which model, and what's wrong if not. */
  ai: {
    configured: boolean;
    reachable: boolean;
    model: string;
    problem?: string;
    /** Tokens each model used in the last 24 hours, against its free daily allowance. */
    usage?: { model: string; used: number; limit: number; share: number }[];
    /** Set when the free daily allowance is running low or used up. */
    budgetWarning?: string | null;
    cache?: { entries: number; hits: number };
  };
  codeVerify: boolean;
}

export async function fetchStatus(): Promise<AppStatus | null> {
  try {
    const res = await fetch("/api/status");
    return res.ok ? res.json() : null;
  } catch {
    return null;
  }
}

// --- MathPilot ---

export async function fetchMathStatus(): Promise<MathStatus | null> {
  try {
    const res = await fetch("/api/math/status");
    return res.ok ? res.json() : null;
  } catch {
    return null;
  }
}

export async function fetchDiscoveries(after = 0, limit = 100): Promise<Discovery[]> {
  try {
    const res = await fetch(`/api/math/discoveries?after=${after}&limit=${limit}`);
    return res.ok ? (await res.json()).discoveries : [];
  } catch {
    return [];
  }
}

export async function setMathPaused(paused: boolean): Promise<MathStatus> {
  const res = await fetch("/api/math/pause", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paused }),
  });
  return res.json();
}

export async function checkEquation(equation: string): Promise<IdentityCheck | { error: string; message?: string }> {
  const res = await fetch("/api/math/check", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ equation }),
  });
  return res.json();
}

// --- AI model (Settings) ---

// --- Chat history & Stop ---

export interface ConversationSummary {
  id: string;
  title: string;
  turns: number;
  updatedAt: string;
}

export async function fetchConversations(): Promise<ConversationSummary[]> {
  try {
    const res = await fetch("/api/conversations");
    return res.ok ? (await res.json()).conversations : [];
  } catch {
    return [];
  }
}

export async function fetchConversation(id: string): Promise<{ runId: string; request: string }[]> {
  try {
    const res = await fetch(`/api/conversations/${encodeURIComponent(id)}`);
    return res.ok ? (await res.json()).turns : [];
  } catch {
    return [];
  }
}

export async function deleteConversation(id: string): Promise<void> {
  await fetch(`/api/conversations/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function cancelRun(runId: string): Promise<void> {
  await fetch(`/api/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST" });
}

/** Whether this computer can turn speech into text itself (Whisper in OmniPilot's engine). */
export async function fetchSpeechAvailable(): Promise<boolean> {
  try {
    const res = await fetch("/api/speech/status");
    return res.ok && Boolean((await res.json()).available);
  } catch {
    return false;
  }
}

/** Sends a recording to this computer's speech-to-text (Whisper); the audio never leaves the machine. */
export async function transcribeAudio(audio: Blob): Promise<{ ok: true; text: string } | { ok: false; message: string }> {
  try {
    const res = await fetch("/api/speech/transcribe", { method: "POST", headers: { "Content-Type": audio.type || "application/octet-stream" }, body: audio });
    const data = await res.json().catch(() => null);
    if (res.status === 413) return { ok: false, message: "That recording was too long. Keep it under 45 seconds." };
    if (data?.ok) return { ok: true, text: data.text };
    return { ok: false, message: data?.message ?? "Couldn't turn that into text." };
  } catch {
    return { ok: false, message: "Couldn't reach OmniPilot to turn that into text." };
  }
}

/** Thumbs up/down on an answer; a thumbs-down with a reason teaches OmniPilot a lesson. */
export async function sendFeedback(runId: string, rating: 1 | -1, comment = ""): Promise<{ lesson: { id: number; lesson: string } | null } | null> {
  try {
    const res = await fetch(`/api/runs/${runId}/feedback`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rating, comment }) });
    return res.ok ? res.json() : null;
  } catch {
    return null;
  }
}

export interface CodeAlert {
  file: string;
  line: number;
  title: string;
  severity: "low" | "medium" | "high" | "critical";
}

/** New issues CodePilot's always-on check found (at or above the chosen alert level). */
export async function fetchCodeAlerts(): Promise<CodeAlert[]> {
  try {
    const res = await fetch("/api/code/alerts");
    return res.ok ? (await res.json()).alerts : [];
  } catch {
    return [];
  }
}

export async function markCodeAlertsSeen(): Promise<void> {
  await fetch("/api/code/alerts/seen", { method: "POST" }).catch(() => {});
}

// --- Pages: routines, skills & agents, workspace, MCP ---

export interface SkillInfo {
  name: string;
  label: string;
  kind: "skill" | "agent";
  instructions: string;
  /** "07:30" when it runs every day, else null. */
  dailyAt: string | null;
  lastRunDate: string | null;
  conversationId: string;
}

async function json<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.message ?? body.error ?? `Request failed (${res.status})`);
  return body as T;
}

export const fetchSkills = async () => (await json<{ skills: SkillInfo[] }>(await fetch("/api/skills"))).skills;
export const createSkill = async (s: { name: string; kind: "skill" | "agent"; instructions: string; dailyAt?: string | null }) =>
  (await json<{ skill: SkillInfo }>(await fetch("/api/skills", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(s) }))).skill;
export const updateSkill = async (name: string, patch: { instructions?: string; dailyAt?: string | null }) =>
  (await json<{ skill: SkillInfo }>(await fetch(`/api/skills/${encodeURIComponent(name)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) }))).skill;
export const deleteSkill = async (name: string) => json(await fetch(`/api/skills/${encodeURIComponent(name)}`, { method: "DELETE" }));
export const runSkill = async (name: string) => json<{ runId: string; conversationId: string }>(await fetch(`/api/skills/${encodeURIComponent(name)}/run`, { method: "POST" }));

export interface WorkspaceProject {
  folder: string;
  name: string;
  description: string;
  files: number;
  sample: string[];
}
export const fetchProjects = async () => json<{ projects: WorkspaceProject[]; files: number }>(await fetch("/api/workspace/projects"));

export interface McpServerInfo {
  name: string;
  transport: string;
  target: string;
  tools: { name: string; description?: string; annotations?: { readOnlyHint?: boolean } }[];
}
export const fetchMcpServers = async () => (await json<{ servers: McpServerInfo[] }>(await fetch("/api/mcp/servers"))).servers;
export const refreshMcpServer = async (name: string) => json(await fetch(`/api/mcp/servers/${encodeURIComponent(name)}/refresh`, { method: "POST" }));
export const removeMcpServer = async (name: string) => json(await fetch(`/api/mcp/servers/${encodeURIComponent(name)}`, { method: "DELETE" }));

export interface PendingChange extends Approval {
  action: import("./types").ProposedAction | null;
  conversationId: string | null;
  request: string | null;
}
export const fetchPendingChanges = async () => (await json<{ approvals: PendingChange[] }>(await fetch("/api/approvals?status=pending"))).approvals;
