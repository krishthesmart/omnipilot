import { EventEmitter } from "node:events";
import type { RunEvent } from "../types.js";

/**
 * Simple per-process pub/sub so SSE clients can subscribe to a run's event
 * stream. Because a run can finish executing before a client's SSE
 * connection opens, every event is also buffered per run so a late
 * subscriber can replay history before receiving live events.
 *
 * The buffer is bounded: a finished run's events are dropped after a
 * retention period (and the oldest finished runs once there are too many).
 * A run that's still going is never dropped. After that, the events
 * endpoint replays the run from its saved record (routes/chat.ts), so
 * reopening an old chat still works.
 */
const TERMINAL = new Set<RunEvent["type"]>(["final_response", "clarification_needed", "run_failed", "run_cancelled"]);

class RunEventBus extends EventEmitter {
  private history = new Map<string, RunEvent[]>();
  /** Each run start gets a globally unique generation, so a reused run ID never matches an old eviction. */
  private generation = new Map<string, number>();
  private nextGeneration = 1;
  /** Finished runs, oldest first, with the generation that finished. */
  private finished = new Map<string, number>();
  private retainMs = Number(process.env.OMNIPILOT_EVENT_RETAIN_MS ?? 10 * 60_000);
  private maxFinished = Number(process.env.OMNIPILOT_EVENT_MAX_RUNS ?? 200);

  /** For tests and tuning. */
  configure(opts: { retainMs?: number; maxFinished?: number }) {
    if (opts.retainMs !== undefined) this.retainMs = opts.retainMs;
    if (opts.maxFinished !== undefined) this.maxFinished = opts.maxFinished;
  }

  publish(event: RunEvent) {
    const id = event.runId;
    if (event.type === "run_started" || !this.generation.has(id)) {
      // A new run (or a reused ID) starts with its own history and generation.
      if (event.type === "run_started") this.history.set(id, []);
      this.generation.set(id, this.nextGeneration++);
      this.finished.delete(id);
    }
    const existing = this.history.get(id) ?? [];
    existing.push(event);
    this.history.set(id, existing);
    this.emit(id, event);
    this.emit("*", event);
    if (TERMINAL.has(event.type)) this.markFinished(id);
  }

  getHistory(runId: string): RunEvent[] {
    return this.history.get(runId) ?? [];
  }

  /** Runs whose events are currently buffered (for tests and diagnostics). */
  bufferedRuns(): number {
    return this.history.size;
  }

  subscribe(runId: string, handler: (event: RunEvent) => void) {
    this.on(runId, handler);
    return () => this.off(runId, handler);
  }

  private markFinished(id: string) {
    const gen = this.generation.get(id)!;
    this.finished.delete(id);
    this.finished.set(id, gen);
    const timer = setTimeout(() => this.evict(id, gen), this.retainMs);
    timer.unref?.();
    while (this.finished.size > this.maxFinished) {
      const [oldest, oldestGen] = this.finished.entries().next().value as [string, number];
      this.evict(oldest, oldestGen);
    }
  }

  /** Drops a finished run's buffered events, but only the generation that finished. */
  private evict(id: string, gen: number) {
    if (this.generation.get(id) !== gen || this.finished.get(id) !== gen) return; // reused or running again
    this.history.delete(id);
    this.finished.delete(id);
    this.generation.delete(id);
  }
}

export const runEventBus = new RunEventBus();
runEventBus.setMaxListeners(0);
