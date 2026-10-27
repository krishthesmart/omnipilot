import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { db, getSetting, setSetting } from "../db.js";
import { listCodeFiles, scanSource, severityRank, type Finding, type Severity } from "../agents/codePilot.js";

// CodePilot's always-on check: it watches the workspace's code folder and rescans a file as soon
// as it changes. New issues at or above the chosen level ("alert me only for critical and high")
// become alerts the app shows in the sidebar; issues that are fixed drop off by themselves.
// Issues already there when OmniPilot starts are recorded without an alert (no flood on startup).
// CODE_WATCH=off turns the watcher off; "turn off code alerts" in chat silences alerts.

db.exec(`
CREATE TABLE IF NOT EXISTS code_issues (
  fingerprint TEXT PRIMARY KEY,
  file TEXT NOT NULL,
  line INTEGER NOT NULL,
  rule_id TEXT NOT NULL,
  title TEXT NOT NULL,
  severity TEXT NOT NULL,
  first_seen TEXT NOT NULL,
  alerted INTEGER NOT NULL DEFAULT 0,
  seen INTEGER NOT NULL DEFAULT 0
)`);

export type AlertLevel = Severity | "off";
const LEVELS: AlertLevel[] = ["low", "medium", "high", "critical", "off"];

export const alertLevel = (): AlertLevel => {
  const v = getSetting("codeAlertLevel") as AlertLevel | undefined;
  return v && LEVELS.includes(v) ? v : "medium";
};
export const setAlertLevel = (level: AlertLevel) => setSetting("codeAlertLevel", level);

/** Same issue = same file, rule and line text (so moving it up or down a line isn't "new"). */
const fingerprint = (f: Finding) => crypto.createHash("sha1").update(`${f.file}|${f.rule.id}|${f.snippet.trim()}`).digest("hex");

export interface CodeAlert {
  file: string;
  line: number;
  title: string;
  severity: Severity;
}

/** Rescans one file and updates the issue list. Returns issues found for the first time. */
export function rescanFile(workspaceRoot: string, rel: string, quiet = false): CodeAlert[] {
  const full = path.join(workspaceRoot, rel);
  const findings = fs.existsSync(full) ? scanSource(rel, fs.readFileSync(full, "utf8")) : [];
  const now = new Set(findings.map(fingerprint));
  // Fixed issues drop off.
  for (const row of db.prepare(`SELECT fingerprint FROM code_issues WHERE file = ?`).all(rel) as { fingerprint: string }[]) {
    if (!now.has(row.fingerprint)) db.prepare(`DELETE FROM code_issues WHERE fingerprint = ?`).run(row.fingerprint);
  }
  const fresh: CodeAlert[] = [];
  const insert = db.prepare(`INSERT OR IGNORE INTO code_issues (fingerprint, file, line, rule_id, title, severity, first_seen, alerted, seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const update = db.prepare(`UPDATE code_issues SET line = ? WHERE fingerprint = ?`);
  for (const f of findings) {
    const fp = fingerprint(f);
    const info = insert.run(fp, rel, f.line, f.rule.id, f.rule.title, f.rule.severity, new Date().toISOString(), quiet ? 0 : 1, quiet ? 1 : 0);
    if (info.changes) {
      if (!quiet) fresh.push({ file: rel, line: f.line, title: f.rule.title, severity: f.rule.severity });
    } else update.run(f.line, fp);
  }
  return fresh;
}

/** Scans every code file now. `quiet` records issues without alerting (used at startup). */
export function scanAll(workspaceRoot: string, quiet = false): { files: number; issues: number; fresh: CodeAlert[] } {
  const root = path.join(workspaceRoot, "code");
  const files = listCodeFiles(root).map((f) => path.relative(workspaceRoot, f).split(path.sep).join("/"));
  const fresh = files.flatMap((rel) => rescanFile(workspaceRoot, rel, quiet));
  // Files that were deleted: their issues go too.
  const known = new Set(files);
  for (const row of db.prepare(`SELECT DISTINCT file FROM code_issues`).all() as { file: string }[]) {
    if (!known.has(row.file)) db.prepare(`DELETE FROM code_issues WHERE file = ?`).run(row.file);
  }
  const issues = (db.prepare(`SELECT COUNT(*) AS n FROM code_issues`).get() as { n: number }).n;
  return { files: files.length, issues, fresh };
}

/** New issues at or above the alert level that the user hasn't looked at yet. */
export function pendingAlerts(): CodeAlert[] {
  const level = alertLevel();
  if (level === "off") return [];
  return (db.prepare(`SELECT file, line, title, severity FROM code_issues WHERE alerted = 1 AND seen = 0 ORDER BY first_seen`).all() as any[]).filter(
    (r) => severityRank[r.severity as Severity] >= severityRank[level]
  );
}

export const markAlertsSeen = () => db.prepare(`UPDATE code_issues SET seen = 1 WHERE seen = 0`).run();

let watcher: fs.FSWatcher | null = null;
const timers = new Map<string, NodeJS.Timeout>();
const CODE_EXT = /\.(js|ts|jsx|tsx|py|go)$/;

/** Starts watching the workspace's code folder (CODE_WATCH=off to disable). */
export function startCodeWatch(workspaceRoot: string) {
  if (process.env.CODE_WATCH === "off" || watcher) return;
  const root = path.join(workspaceRoot, "code");
  if (!fs.existsSync(root)) return;
  scanAll(workspaceRoot, true);
  try {
    watcher = fs.watch(root, { recursive: true }, (_event, name) => {
      if (!name || !CODE_EXT.test(name)) return;
      const rel = path.relative(workspaceRoot, path.join(root, name.toString())).split(path.sep).join("/");
      // Editors save in bursts: wait for the file to settle.
      clearTimeout(timers.get(rel));
      timers.set(
        rel,
        setTimeout(() => {
          timers.delete(rel);
          try {
            rescanFile(workspaceRoot, rel);
          } catch {
            // a file mid-save or removed: the next change rescans it
          }
        }, 1200)
      );
    });
    watcher.unref?.();
  } catch {
    watcher = null; // recursive watching isn't available on this system
  }
}

export function stopCodeWatch() {
  watcher?.close();
  watcher = null;
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
}
