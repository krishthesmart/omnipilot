import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { db } from "../db.js";

// Fixes CodePilot proposes for files in the approved workspace folder. A fix is stored with the
// exact file it was written for (a hash of its content) and shown as a diff before anything
// changes. Only approving it writes the file, and only if:
//   - the file is still inside the workspace folder (no symlinks out of it),
//   - the file hasn't changed since the fix was written.
// The original is kept, so "Undo" restores it (as long as nobody edited the file since).
// A change can span many files (a whole new project, or an edit across a codebase): the files of a
// set are checked together and written together, so a set is applied completely or not at all.

db.exec(`
CREATE TABLE IF NOT EXISTS code_patches (
  id TEXT PRIMARY KEY,
  file TEXT NOT NULL,
  original_hash TEXT NOT NULL,
  original TEXT NOT NULL,
  fixed TEXT NOT NULL,
  summary TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  applied_at TEXT
)`);
// Added for multi-file change sets (older databases get the columns on startup).
for (const col of ["set_id TEXT", "is_new INTEGER NOT NULL DEFAULT 0"]) {
  try {
    db.exec(`ALTER TABLE code_patches ADD COLUMN ${col}`);
  } catch {
    // already there
  }
}

export const MAX_PATCH_FILE_BYTES = 200_000;
const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

export interface Patch {
  id: string;
  file: string;
  summary: string;
  status: "pending" | "applied" | "undone" | "rejected";
  diff: string;
  /** A file the change creates (it didn't exist before). */
  isNew: boolean;
}

/**
 * Where a NEW file `rel` would go, or null if that's outside the workspace folder (absolute paths,
 * "..", or a folder that is a symlink out of it) or the file already exists.
 */
export function safeNewPath(workspaceRoot: string, rel: string): string | null {
  if (!rel || path.isAbsolute(rel) || rel.split(/[\\/]/).includes("..")) return null;
  const root = fs.realpathSync(workspaceRoot);
  const target = path.resolve(root, rel);
  if (!target.startsWith(root + path.sep) || fs.existsSync(target)) return null;
  // The deepest folder that already exists must really be inside the workspace.
  let dir = path.dirname(target);
  while (!fs.existsSync(dir)) dir = path.dirname(dir);
  const real = fs.realpathSync(dir);
  return real === root || real.startsWith(root + path.sep) ? target : null;
}

/** The workspace file `rel` points to, or null if it would leave the workspace folder. */
export function safeWorkspacePath(workspaceRoot: string, rel: string): string | null {
  const root = fs.realpathSync(workspaceRoot);
  const target = path.resolve(root, rel);
  if (target !== root && !target.startsWith(root + path.sep)) return null;
  if (!fs.existsSync(target)) return null;
  const real = fs.realpathSync(target);
  return real.startsWith(root + path.sep) ? real : null;
}

/** A unified diff (2 lines of context) between two texts, via longest common subsequence of lines. */
export function unifiedDiff(file: string, before: string, after: string): string {
  const a = before.split("\n");
  const b = after.split("\n");
  if (a.length * b.length > 4_000_000) return `--- a/${file}\n+++ b/${file}\n(file too large to show a diff)`;
  // LCS table, built from the end.
  const lcs = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  type Op = { t: " " | "-" | "+"; line: string; ai: number; bi: number };
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) ops.push({ t: " ", line: a[i], ai: i++, bi: j++ });
    else if (j < b.length && (i >= a.length || lcs[i][j + 1] >= lcs[i + 1][j])) ops.push({ t: "+", line: b[j], ai: i, bi: j++ });
    else ops.push({ t: "-", line: a[i], ai: i++, bi: j });
  }
  // Group changes into hunks with context.
  const CONTEXT = 2;
  const out: string[] = [`--- a/${file}`, `+++ b/${file}`];
  let k = 0;
  while (k < ops.length) {
    if (ops[k].t === " ") {
      k++;
      continue;
    }
    let start = Math.max(0, k - CONTEXT);
    let end = k;
    while (end < ops.length) {
      if (ops[end].t !== " ") {
        end++;
        continue;
      }
      let run = 0;
      while (end + run < ops.length && ops[end + run].t === " ") run++;
      if (end + run >= ops.length || run > CONTEXT * 2) {
        end = Math.min(ops.length, end + CONTEXT);
        break;
      }
      end += run;
    }
    const hunk = ops.slice(start, end);
    const aStart = hunk[0].ai + 1;
    const bStart = hunk[0].bi + 1;
    out.push(`@@ -${aStart},${hunk.filter((o) => o.t !== "+").length} +${bStart},${hunk.filter((o) => o.t !== "-").length} @@`);
    for (const o of hunk) out.push(`${o.t}${o.line}`);
    k = end;
    start = end;
  }
  return out.join("\n");
}

export function savePatch(p: { id: string; file: string; original: string; fixed: string; summary: string; setId?: string; isNew?: boolean }) {
  db.prepare(
    `INSERT OR REPLACE INTO code_patches (id, file, original_hash, original, fixed, summary, status, created_at, set_id, is_new) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`
  ).run(p.id, p.file, sha(p.original), p.original, p.fixed, p.summary.slice(0, 500), new Date().toISOString(), p.setId ?? p.id, p.isNew ? 1 : 0);
}

/** Saves a change across several files as one set (approved, applied and undone together). */
export function savePatchSet(setId: string, summary: string, files: { file: string; original: string; fixed: string; isNew?: boolean }[]) {
  files.forEach((f, i) => savePatch({ id: i === 0 ? setId : `${setId}#${i}`, setId, summary, ...f }));
}

type Row = Patch & { original: string; fixed: string; originalHash: string };
const toPatch = (r: any): Row => ({
  id: r.id,
  file: r.file,
  summary: r.summary,
  status: r.status,
  isNew: r.is_new === 1,
  diff: unifiedDiff(r.file, r.original, r.fixed),
  original: r.original,
  fixed: r.fixed,
  originalHash: r.original_hash,
});

export function getPatch(id: string): Row | null {
  const r = db.prepare(`SELECT * FROM code_patches WHERE id = ?`).get(id) as any;
  return r ? toPatch(r) : null;
}

/** Every file in a change set (a single fix is a set of one). */
export function patchSet(setId: string): Row[] {
  return (db.prepare(`SELECT * FROM code_patches WHERE set_id = ? OR (set_id IS NULL AND id = ?) ORDER BY rowid`).all(setId, setId) as any[]).map(toPatch);
}

export type ApplyResult =
  | { ok: true; file: string; files: string[] }
  | { ok: false; error: "not_found" | "not_pending" | "outside_workspace" | "changed" | "write_failed"; message: string };

const fail = (error: Extract<ApplyResult, { ok: false }>["error"], message: string): ApplyResult => ({ ok: false, error, message });

function writeAtomic(target: string, text: string) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.omnipilot-tmp`;
  fs.writeFileSync(tmp, text, "utf8");
  fs.renameSync(tmp, target);
}

/** Writes an approved change (one file or a whole set) -- all files, or none. */
export function applyPatch(id: string, workspaceRoot: string): ApplyResult {
  const set = patchSet(id);
  if (set.length === 0) return fail("not_found", "There's no fix to apply for this.");
  if (set.some((p) => p.status !== "pending")) return fail("not_pending", `This change was already ${set.find((p) => p.status !== "pending")!.status}.`);
  // Check every file before writing any.
  const targets: string[] = [];
  for (const p of set) {
    if (p.isNew) {
      const target = safeNewPath(workspaceRoot, p.file);
      if (!target) return fail(fs.existsSync(path.resolve(workspaceRoot, p.file)) ? "changed" : "outside_workspace", `${p.file} ${fs.existsSync(path.resolve(workspaceRoot, p.file)) ? "already exists now, so it wasn't overwritten" : "isn't inside the approved workspace folder"}.`);
      targets.push(target);
    } else {
      const target = safeWorkspacePath(workspaceRoot, p.file);
      if (!target) return fail("outside_workspace", `${p.file} isn't in the approved workspace folder any more.`);
      if (sha(fs.readFileSync(target, "utf8")) !== p.originalHash) return fail("changed", `${p.file} changed after the fix was written, so nothing was applied. Ask CodePilot to scan again.`);
      targets.push(target);
    }
  }
  const written: number[] = [];
  try {
    set.forEach((p, i) => {
      writeAtomic(targets[i], p.fixed);
      written.push(i);
    });
  } catch {
    // Put back what was already written, so the set isn't half-applied.
    for (const i of written) {
      try {
        if (set[i].isNew) fs.rmSync(targets[i], { force: true });
        else writeAtomic(targets[i], set[i].original);
      } catch {
        // best effort
      }
    }
    return fail("write_failed", `Couldn't write ${set[written.length]?.file ?? "the files"}; nothing was changed.`);
  }
  const now = new Date().toISOString();
  for (const p of set) db.prepare(`UPDATE code_patches SET status = 'applied', applied_at = ? WHERE id = ?`).run(now, p.id);
  return { ok: true, file: set[0].file, files: set.map((p) => p.file) };
}

/** Puts the originals back (and removes files the change created), if nobody edited them since. */
export function undoPatch(id: string, workspaceRoot: string): ApplyResult {
  const set = patchSet(id);
  if (set.length === 0) return fail("not_found", "There's no fix to undo.");
  if (set.some((p) => p.status !== "applied")) return fail("not_pending", "This change isn't applied.");
  const targets: string[] = [];
  for (const p of set) {
    const target = safeWorkspacePath(workspaceRoot, p.file);
    if (!target) return fail("outside_workspace", `${p.file} isn't in the workspace folder any more.`);
    if (sha(fs.readFileSync(target, "utf8")) !== sha(p.fixed)) return fail("changed", `${p.file} was edited after the change, so undoing it could lose those edits.`);
    targets.push(target);
  }
  set.forEach((p, i) => (p.isNew ? fs.rmSync(targets[i], { force: true }) : writeAtomic(targets[i], p.original)));
  // Folders the change created (now empty) go too, up to the workspace folder itself.
  const root = fs.realpathSync(workspaceRoot);
  for (const [i, p] of set.entries()) {
    if (!p.isNew) continue;
    let dir = path.dirname(targets[i]);
    while (dir.startsWith(root + path.sep) && fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
      fs.rmdirSync(dir);
      dir = path.dirname(dir);
    }
  }
  for (const p of set) db.prepare(`UPDATE code_patches SET status = 'undone' WHERE id = ?`).run(p.id);
  return { ok: true, file: set[0].file, files: set.map((p) => p.file) };
}

export function rejectPatch(id: string) {
  for (const p of patchSet(id)) db.prepare(`UPDATE code_patches SET status = 'rejected' WHERE id = ? AND status = 'pending'`).run(p.id);
}
