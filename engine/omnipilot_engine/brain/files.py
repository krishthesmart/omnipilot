"""An index of the approved workspace folder: every text file's words, refreshed only for files that
changed (by modification time), so finding "the file I used for my robotics project" takes milliseconds.
It also recognises projects: each top-level folder (or any folder with a README or package file), named
by its README title or package name. (Same behaviour as server/src/lib/fileIndex.ts.)"""
from __future__ import annotations

import json
import os
import re
import threading
from dataclasses import dataclass, field

from .text import clip

TEXT_EXT = re.compile(r"\.(txt|md|markdown|js|jsx|ts|tsx|py|go|java|c|cc|cpp|h|hpp|cs|rb|rs|php|swift|kt|ino|json|yaml|yml|toml|csv|html|css|sh|sql|ini|cfg)$", re.I)
MAX_FILE_BYTES = 1_000_000
STOP = set("the a an and or but for with what how why when who which this that from into your you are was were have has had not can could would should about there their them they then than just also more some such only very will been being does doing done find show where file files my me please help".split())
PROJECT_FILE = re.compile(r"^(readme(\.\w+)?|package\.json|pyproject\.toml|cargo\.toml|platformio\.ini)$")


def words(text: str) -> list[str]:
    return [w for w in re.split(r"[^a-z0-9]+", text.lower()) if len(w) > 2 and w not in STOP]


@dataclass
class IndexedFile:
    rel: str
    mtime: float
    lines: list[str]
    postings: dict[str, list[int]]
    path_words: set[str]
    project: str


@dataclass
class Project:
    folder: str
    name: str
    description: str
    files: list[str]
    words: set[str] = field(default_factory=set)


class FileIndex:
    def __init__(self, root: str):
        self.root = root
        self.files: dict[str, IndexedFile] = {}
        self.projects: list[Project] = []
        self._lock = threading.Lock()

    def refresh(self) -> dict:
        with self._lock:
            seen, changed = set(), 0
            for dirpath, dirnames, filenames in os.walk(self.root):
                dirnames[:] = sorted(d for d in dirnames if not d.startswith(".") and d != "node_modules")
                for name in sorted(filenames):
                    if name.startswith(".") or not TEXT_EXT.search(name):
                        continue
                    full = os.path.join(dirpath, name)
                    rel = os.path.relpath(full, self.root)
                    seen.add(rel)
                    try:
                        st = os.stat(full)
                    except OSError:
                        continue
                    if st.st_size > MAX_FILE_BYTES or (rel in self.files and self.files[rel].mtime == st.st_mtime):
                        continue
                    self.files[rel] = self._index(rel, full, st.st_mtime)
                    changed += 1
            for rel in [r for r in self.files if r not in seen]:
                del self.files[rel]
                changed += 1
            if changed or not self.projects:
                self.projects = self._find_projects()
            return {"files": len(self.files), "changed": changed}

    def _index(self, rel: str, full: str, mtime: float) -> IndexedFile:
        with open(full, encoding="utf-8", errors="replace") as f:
            lines = f.read().split("\n")
        postings: dict[str, list[int]] = {}
        for i, line in enumerate(lines):
            for w in set(words(line)):
                postings.setdefault(w, []).append(i + 1)
        parts = rel.split(os.sep)
        return IndexedFile(rel, mtime, lines, postings, set(words(re.sub(r"[-_.]", " ", rel))), parts[0] if len(parts) > 1 else "")

    def _find_projects(self) -> list[Project]:
        folders: set[str] = set()
        for f in self.files.values():
            parts = f.rel.split(os.sep)
            if len(parts) > 1:
                folders.add(parts[0])
            if PROJECT_FILE.match(os.path.basename(f.rel).lower()):
                folders.add(os.path.dirname(f.rel))
        out = []
        folders = {d for d in folders if d and d != "."}
        for folder in sorted(folders):
            files = [r for r in self.files if r == folder or r.startswith(folder + os.sep)]
            # A folder that only holds other projects ("projects/" with "projects/horror-game/") isn't one itself.
            inner = [d for d in folders if d.startswith(folder + os.sep)]
            if inner and all(any(r.startswith(d + os.sep) for d in inner) for r in files):
                continue
            readme = next((r for r in files if "readme" in os.path.basename(r).lower() and os.path.dirname(r) == folder), None)
            pkg = next((r for r in files if os.path.basename(r) == "package.json" and os.path.dirname(r) == folder), None)
            name, description = re.sub(r"[-_]", " ", os.path.basename(folder)), ""
            if readme:
                lines = self.files[readme].lines
                title = next((l for l in lines if re.match(r"^#\s+", l)), None)
                if title:
                    name = re.sub(r"^#\s+", "", title).strip()
                description = clip(" ".join(l.strip() for l in lines[:40] if l.strip() and not l.lstrip().startswith(("#", "```", "|", "<!--")) and not re.fullmatch(r"\s*[-=*_]{3,}\s*", l)), 300)
            elif pkg:
                try:
                    p = json.loads("\n".join(self.files[pkg].lines))
                    name, description = p.get("name") or name, p.get("description") or ""
                except ValueError:
                    pass
            out.append(Project(folder, name, description, files, set(words(f"{re.sub(r'[-_/]', ' ', folder)} {name} {description}"))))
        return out

    def match_projects(self, query: str) -> list[Project]:
        q = set(words(query))
        scored = [(sum(1 for w in q if w in p.words or any(pw.startswith(w) or w.startswith(pw) for pw in p.words)), p) for p in self.projects]
        return [p for s, p in sorted(scored, key=lambda x: -x[0]) if s > 0]

    def search(self, query: str, limit: int = 8) -> list[dict]:
        q = list(dict.fromkeys(words(query)))
        if not q:
            return []
        boost = {p.folder: 3 - min(2, i) for i, p in enumerate(self.match_projects(query))}
        hits = []
        for f in self.files.values():
            matched = [w for w in q if w in f.postings]
            in_path = [w for w in q if any(pw.startswith(w) for pw in f.path_words)]
            if not matched and not in_path:
                continue
            freq = sum(min(5, len(f.postings[w])) for w in matched)
            b = next((v for folder, v in boost.items() if f.rel == folder or f.rel.startswith(folder + os.sep)), 0)
            score = len(in_path) * 4 + len(matched) * 3 + freq * 0.3 + b * 2
            line_nos = sorted({n for w in matched for n in f.postings[w]})[:6]
            hits.append({"file": f.rel, "project": f.project, "score": score, "lines": [{"line": n, "text": f.lines[n - 1].strip()[:240]} for n in line_nos]})
        return sorted(hits, key=lambda h: -h["score"])[:limit]

    def passage(self, rel: str, line: int, before: int = 5, after: int = 6) -> str:
        f = self.files.get(rel)
        return "\n".join(f.lines[max(0, line - 1 - before): line + after]).strip()[:1400] if f else ""

    def file_lines(self, rel: str, max_lines: int = 400) -> list[str]:
        f = self.files.get(rel)
        return f.lines[:max_lines] if f else []


_indexes: dict[str, FileIndex] = {}


def workspace_index(root: str) -> FileIndex:
    idx = _indexes.setdefault(root, FileIndex(root))
    if os.path.isdir(root):
        idx.refresh()
    return idx


CODE_FILE = re.compile(r"\.(js|jsx|ts|tsx|mjs|cjs|py|go|java|c|cc|cpp|cs|rb|rs|php|swift|kt|ino|html|css)$", re.I)
GENERIC = {"project", "projects", "app", "apps", "game", "code", "site", "website", "program", "the", "my", "and", "for", "with"}


def named_code_project(root: str, text: str) -> Project | None:
    """A workspace code project the request names by one of its distinctive words ("flashcard", "robotics")."""
    said = set(re.split(r"[^a-z0-9]+", text.lower()))
    for p in workspace_index(root).projects:
        if not any(CODE_FILE.search(f) for f in p.files):
            continue
        for w in re.split(r"[^a-z0-9]+", f"{p.folder.split('/')[-1]} {p.name}".lower()):
            if len(w) >= 4 and w not in GENERIC and (w in said or re.sub(r"s$", "", w) in said or f"{w}s" in said):
                return p
    return None
