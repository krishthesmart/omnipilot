// OmniPilot SDK for JavaScript (Node 18+, Deno, Bun and browsers). No dependencies.
//
//   import { OmniPilot } from "omnipilot-sdk";
//   const op = new OmniPilot();                    // http://localhost:8899
//   const { answer } = await op.ask("Is (a+b)^2 = a^2 + b^2?");
//
// From another device, start OmniPilot with HOST=0.0.0.0 and OMNIPILOT_API_TOKEN,
// then: new OmniPilot({ baseUrl: "http://192.168.1.20:8899", token: "..." }).

const DONE = new Set(["final_response", "clarification_needed", "run_failed"]);

export class OmniPilotError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = "OmniPilotError";
    this.status = status;
    this.body = body;
  }
}

export class OmniPilot {
  /**
   * @param {{ baseUrl?: string, token?: string, fetch?: typeof fetch }} [options]
   */
  constructor(options = {}) {
    const env = typeof process !== "undefined" ? process.env : {};
    this.baseUrl = (options.baseUrl ?? env.OMNIPILOT_URL ?? "http://localhost:8899").replace(/\/$/, "");
    this.token = options.token ?? env.OMNIPILOT_TOKEN;
    this._fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  _headers(json = true) {
    return {
      ...(json ? { "Content-Type": "application/json" } : {}),
      ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
    };
  }

  async _request(path, init = {}) {
    const res = await this._fetch(`${this.baseUrl}${path}`, { ...init, headers: { ...this._headers(init.body !== undefined), ...(init.headers ?? {}) } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new OmniPilotError(body.message ?? body.error ?? `HTTP ${res.status}`, res.status, body);
    return body;
  }

  /** Ask a question and wait for the full answer. */
  ask(message, { conversationId, textOnly } = {}) {
    return this._request("/api/ask", { method: "POST", body: JSON.stringify({ message, conversationId, textOnly }) });
  }

  /**
   * Ask a question and stream the answer as it's written.
   * `onDelta` gets each new piece of the answer; `onEvent` gets every pipeline event.
   * Resolves with the final response (or throws if the run failed).
   */
  async stream(message, { conversationId, onDelta, onEvent, signal } = {}) {
    const { runId, runKey } = await this._request("/api/chat", { method: "POST", body: JSON.stringify({ message, conversationId }), signal });
    // From another device (token), a run can only be read with the key returned when it was started.
    const res = await this._fetch(`${this.baseUrl}/api/runs/${runId}/events`, { headers: { ...this._headers(false), ...(runKey ? { "x-run-key": runKey } : {}) }, signal });
    if (!res.ok || !res.body) throw new OmniPilotError(`event stream failed: HTTP ${res.status}`, res.status);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let streamed = false;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let cut;
        while ((cut = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          const data = frame.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("\n");
          if (!data) continue; // heartbeat
          const event = JSON.parse(data);
          onEvent?.(event);
          if (event.type === "answer_delta") {
            streamed = true;
            onDelta?.(event.delta);
          }
          if (DONE.has(event.type)) {
            if (event.type === "run_failed") throw new OmniPilotError(event.error, 500, event);
            if (event.type === "clarification_needed") {
              onDelta?.(event.question);
              return { runId, status: "needs_clarification", answer: event.question, clarifyingQuestion: event.question };
            }
            const r = event.response;
            // Answers that weren't composed by the model arrive in one piece.
            if (!streamed) onDelta?.(r.summary);
            return { runId, status: "completed", answer: r.summary, confidence: r.confidence, agents: r.agentResults.map((a) => ({ agent: a.agent, status: a.status })), limitations: r.limitations, attachments: r.attachments ?? [] };
          }
        }
      }
    } finally {
      reader.cancel().catch(() => {});
    }
    throw new OmniPilotError("the event stream ended before the answer arrived", 0);
  }

  /** A conversation: follow-up questions can refer back ("now in JavaScript"). */
  conversation() {
    const id = `sdk-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
    return {
      id,
      ask: (message, opts = {}) => this.ask(message, { ...opts, conversationId: id }),
      stream: (message, opts = {}) => this.stream(message, { ...opts, conversationId: id }),
    };
  }

  /** MathPilot: check "left = right" numerically. */
  checkIdentity(equation) {
    return this._request("/api/math/check", { method: "POST", body: JSON.stringify({ equation }) });
  }

  /** MathPilot: the background search's progress. */
  mathStatus() {
    return this._request("/api/math/status");
  }

  /** MathPilot: verified identities, newest first (`after` = only ids above this). */
  async discoveries({ after = 0, limit = 100 } = {}) {
    return (await this._request(`/api/math/discoveries?after=${after}&limit=${limit}`)).discoveries;
  }

  /** Version and whether the local AI model is ready. */
  status() {
    return this._request("/api/status");
  }
}

export default OmniPilot;
