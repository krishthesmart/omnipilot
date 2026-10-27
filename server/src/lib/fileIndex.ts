import fs from "node:fs";
import path from "node:path";

// Helper's index of the approved workspace folder: every text file's words, kept in memory and
// refreshed only for files that changed (by modification time), so finding "the file I used for
// my robotics project" takes milliseconds instead of re-reading everything. It also recognises
// projects: each top-level folder (or any folder with a README or package file) is a project,
// named by its README's title or package name, so "find my robotics project" matches by meaning,
// not just by file name.

const TEXT_EXT = /\.(txt|md|markdown|js|jsx|ts|tsx|py|go|java|c|cc|cpp|h|hpp|cs|rb|rs|php|swift|kt|ino|json|yaml|yml|toml|csv|html|css|sh|sql|ini|cfg)$/i;
const MAX_FILE_BYTES = 1_000_000;
const STOP = new Set("the a an and or but for with what how why when who which this that from into your you are was were have has had not can could would should about there their them they then than just also more some such only very will been being does doing done find show where file files my me please help".split(" "));

export const words = (text: string) => text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w));

interface IndexedFile {
  rel: string;
  mtimeMs: number;
  lines: string[];
  /** word -> line numbers (1-based) */
  postings: Map<string, number[]>;
  pathWords: Set<string>;
  project: string;
}

export interface Project {
  /** Folder, relative to the workspace. */
  folder: string;
  name: string;
  description: string;
  files: string[];
  words: Set<string>;
}

export interface FileHit {
  file: string;
  project: string;
  score: number;
  lines: { line: number; text: string }[];
}

class FileIndex {
  private files = new Map<string, IndexedFile>();
  private projects: Project[] = [];
  constructor(private readonly root: string) {}

  /** Re-reads only files that are new or changed since last time; drops deleted ones. */
  refresh(): { files: number; changed: number } {
    const seen = new Set<string>();
    let changed = 0;
    const stack = [this.root];
    while (stack.length) {
      const dir = stack.pop()!;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (e.name.startsWith(".") || e.name === "node_modules") continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) stack.push(full);
        else if (e.isFile() && TEXT_EXT.test(e.name)) {
          const rel = path.relative(this.root, full);
          seen.add(rel);
          const st = fs.statSync(full);
          if (st.size > MAX_FILE_BYTES) continue;
          if (this.files.get(rel)?.mtimeMs === st.mtimeMs) continue;
          this.files.set(rel, this.indexFile(rel, full, st.mtimeMs));
          changed++;
        }
      }
    }
    for (const rel of [...this.files.keys()]) if (!seen.has(rel)) (this.files.delete(rel), changed++);
    if (changed || this.projects.length === 0) this.projects = this.findProjects();
    return { files: this.files.size, changed };
  }

  private indexFile(rel: string, full: string, mtimeMs: number): IndexedFile {
    const lines = fs.readFileSync(full, "utf8").split("\n");
    const postings = new Map<string, number[]>();
    lines.forEach((l, i) => {
      for (const w of new Set(words(l))) {
        const list = postings.get(w);
        if (list) list.push(i + 1);
        else postings.set(w, [i + 1]);
      }
    });
    const parts = rel.split(path.sep);
    return { rel, mtimeMs, lines, postings, pathWords: new Set(words(rel.replace(/[-_.]/g, " "))), project: parts.length > 1 ? parts[0] : "" };
  }

  /** Projects: top-level folders and any folder with a README / package file, named from it. */
  private findProjects(): Project[] {
    const folders = new Set<string>();
    for (const f of this.files.values()) {
      const parts = f.rel.split(path.sep);
      if (parts.length > 1) folders.add(parts[0]);
      const base = path.basename(f.rel).toLowerCase();
      if (/^(readme(\.\w+)?|package\.json|pyproject\.toml|cargo\.toml|platformio\.ini)$/.test(base)) folders.add(path.dirname(f.rel));
    }
    return [...folders]
      .filter((d) => d && d !== ".")
      .map((folder) => {
        const files = [...this.files.keys()].filter((r) => r === folder || r.startsWith(folder + path.sep));
        const readme = files.find((r) => /readme/i.test(path.basename(r)) && path.dirname(r) === folder);
        const pkg = files.find((r) => path.basename(r) === "package.json" && path.dirname(r) === folder);
        let name = path.basename(folder).replace(/[-_]/g, " ");
        let description = "";
        if (readme) {
          const lines = this.files.get(readme)!.lines;
          const title = lines.find((l) => /^#\s+/.test(l));
          if (title) name = title.replace(/^#\s+/, "").trim();
          description = lines.filter((l) => l.trim() && !/^#/.test(l)).slice(0, 3).join(" ").slice(0, 300);
        } else if (pkg) {
          try {
            const p = JSON.parse(this.files.get(pkg)!.lines.join("\n"));
            name = p.name ?? name;
            description = p.description ?? "";
          } catch {
            // not valid JSON
          }
        }
        return { folder, name, description, files, words: new Set(words(`${folder.replace(/[-_/]/g, " ")} ${name} ${description}`)) };
      });
  }

  listProjects(): Project[] {
    return this.projects;
  }

  /** Projects whose name/folder/description share words with the query, best first. */
  matchProjects(query: string): Project[] {
    const q = new Set(words(query));
    return this.projects
      .map((p) => ({ p, score: [...q].filter((w) => p.words.has(w) || [...p.words].some((pw) => pw.startsWith(w) || w.startsWith(pw))).length }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.p);
  }

  /**
   * Ranked files for a query: words in the file's path and its project's name count most, then how
   * many of the query's words the file contains, then how often. Each hit includes the matching lines.
   */
  search(query: string, limit = 8): FileHit[] {
    const q = Array.from(new Set(words(query)));
    if (q.length === 0) return [];
    const projectBoost = new Map(this.matchProjects(query).map((p, i) => [p.folder, 3 - Math.min(2, i)]));
    const hits: FileHit[] = [];
    for (const f of this.files.values()) {
      const matched = q.filter((w) => f.postings.has(w));
      const inPath = q.filter((w) => [...f.pathWords].some((pw) => pw.startsWith(w)));
      if (matched.length === 0 && inPath.length === 0) continue;
      const freq = matched.reduce((n, w) => n + Math.min(5, f.postings.get(w)!.length), 0);
      const boost = [...projectBoost].find(([folder]) => f.rel === folder || f.rel.startsWith(folder + path.sep))?.[1] ?? 0;
      const score = inPath.length * 4 + matched.length * 3 + freq * 0.3 + boost * 2;
      const lineNos = Array.from(new Set(matched.flatMap((w) => f.postings.get(w)!))).sort((a, b) => a - b).slice(0, 6);
      hits.push({ file: f.rel, project: f.project, score, lines: lineNos.map((n) => ({ line: n, text: f.lines[n - 1].trim().slice(0, 240) })) });
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  /** A few lines around a line of a file (for answers grounded in the user's files). */
  passage(rel: string, line: number, before = 5, after = 6): string {
    const f = this.files.get(rel);
    if (!f) return "";
    return f.lines.slice(Math.max(0, line - 1 - before), line + after).join("\n").trim().slice(0, 1400);
  }

  /** A whole file's lines (up to `maxLines`). */
  fileLines(rel: string, maxLines = 400): string[] {
    return this.files.get(rel)?.lines.slice(0, maxLines) ?? [];
  }

  size() {
    return this.files.size;
  }
}

const indexes = new Map<string, FileIndex>();

/** The (refreshed) index for a workspace folder. */
export function workspaceIndex(root: string): FileIndex {
  let idx = indexes.get(root);
  if (!idx) indexes.set(root, (idx = new FileIndex(root)));
  idx.refresh();
  return idx;
}

const CODE_FILE = /\.(js|jsx|ts|tsx|mjs|cjs|py|go|java|c|cc|cpp|cs|rb|rs|php|swift|kt|ino|html|css)$/i;
const GENERIC = new Set(["project", "projects", "app", "apps", "game", "code", "site", "website", "program", "the", "my", "and", "for", "with"]);

/** A workspace code project the request names by one of its distinctive words ("flashcard", "robotics"). */
export function namedCodeProject(root: string, text: string): Project | null {
  const said = new Set(text.toLowerCase().split(/[^a-z0-9]+/));
  return (
    workspaceIndex(root)
      .listProjects()
      .find(
        (x) =>
          x.files.some((f) => CODE_FILE.test(f)) &&
          `${x.folder.split("/").pop()} ${x.name}`
            .toLowerCase()
            .split(/[^a-z0-9]+/)
            .some((w) => w.length >= 4 && !GENERIC.has(w) && (said.has(w) || said.has(w.replace(/s$/, "")) || said.has(`${w}s`)))
      ) ?? null
  );
}
