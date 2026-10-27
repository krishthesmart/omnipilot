// One cancel switch per run, so the Stop button can end a run wherever it is:
// running agents, the streamed answer, or between pipeline stages.

const controllers = new Map<string, AbortController>();

export function beginRun(runId: string): AbortSignal {
  const c = new AbortController();
  controllers.set(runId, c);
  return c.signal;
}

export function endRun(runId: string) {
  controllers.delete(runId);
}

/** Returns false if the run isn't in progress (already finished, or unknown). */
export function cancelRun(runId: string): boolean {
  const c = controllers.get(runId);
  if (!c) return false;
  c.abort();
  return true;
}

export const runSignal = (runId: string): AbortSignal | undefined => controllers.get(runId)?.signal;

export const isCancelled = (runId: string) => controllers.get(runId)?.signal.aborted ?? false;

export class RunCancelled extends Error {
  constructor() {
    super("Stopped");
    this.name = "RunCancelled";
  }
}

export function throwIfCancelled(runId: string) {
  if (isCancelled(runId)) throw new RunCancelled();
}
