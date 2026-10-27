import fs from "node:fs";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";

// Records every model call OmniPilot makes (prompt, examples, output format and
// the model's answer) when OMNIPILOT_RECORD names a file. training/ uses these
// recordings to teach omnipilot-mini every job OmniPilot gives its model, in
// exactly the format OmniPilot uses. Off unless that variable is set.

const runContext = new AsyncLocalStorage<{ runId: string }>();

/** Runs `fn` with `runId` attached, so recorded calls can be matched to the run's outcome. */
export const withRunContext = <T>(runId: string, fn: () => Promise<T>): Promise<T> => runContext.run({ runId }, fn);

/** The run the current code is working on, if any. */
export const currentRunId = (): string | null => runContext.getStore()?.runId ?? null;

export interface RecordedCall {
  runId: string | null;
  model: string;
  messages: { role: string; content: string }[];
  format?: unknown;
  temperature?: number;
  output: string | null;
  at: string;
}

export function recordCall(call: Omit<RecordedCall, "runId" | "at">) {
  const file = process.env.OMNIPILOT_RECORD;
  if (!file) return;
  const entry: RecordedCall = { runId: runContext.getStore()?.runId ?? null, at: new Date().toISOString(), ...call };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(entry) + "\n");
}

