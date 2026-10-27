import { randomUUID } from "node:crypto";
import { executeRun } from "../pipeline.js";
import { dueRoutines, markRan, skillRequest } from "./skills.js";

// Runs daily routines (skills with a time) while OmniPilot is running. Each one goes through
// the normal pipeline, like a typed request, and its results collect in one chat per routine,
// so they show up in the chat history. ROUTINES=off turns this off.

const CHECK_EVERY_MS = 30_000;
let timer: NodeJS.Timeout | null = null;

const today = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export async function runDueRoutines(now = new Date()): Promise<string[]> {
  const ran: string[] = [];
  for (const s of dueRoutines(now)) {
    markRan(s.name, today(now)); // first, so a slow run can't start twice
    ran.push(s.name);
    executeRun(skillRequest(s, ""), {}, randomUUID(), `routine-${s.name}`).catch((err) => console.error(`Routine ${s.name} failed:`, err));
  }
  return ran;
}

export function startRoutines() {
  if (process.env.ROUTINES === "off" || timer) return;
  timer = setInterval(() => void runDueRoutines(), CHECK_EVERY_MS);
  timer.unref();
}

export function stopRoutines() {
  if (timer) clearInterval(timer);
  timer = null;
}
