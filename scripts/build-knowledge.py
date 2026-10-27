"""Builds OmniPilot's offline encyclopedia: the opening paragraphs of every
Simple English Wikipedia article, in a full-text search index (SQLite FTS5).
Helper looks facts up here so the small local model answers from a source
instead of guessing. Runs once; afterwards nothing goes online.

    npm run knowledge        (needs uv: https://docs.astral.sh/uv/)

Text: Simple English Wikipedia (Nov 2023 snapshot, via the wikimedia/wikipedia
dataset), CC BY-SA 4.0. Answers that use it cite the article.
"""
import os
import re
import sqlite3
import sys
import tempfile
import urllib.request
from pathlib import Path

import pyarrow.parquet as pq

URL = "https://huggingface.co/datasets/wikimedia/wikipedia/resolve/main/20231101.simple/train-00000-of-00001.parquet"
OUT = Path(os.environ.get("OMNIPILOT_KNOWLEDGE", Path(__file__).resolve().parent.parent / "server" / "data" / "knowledge.sqlite"))
MAX_CHARS = 900

SKIP_TITLE = re.compile(r"^(List of|Lists of|Index of|Timeline of)|\(disambiguation\)$", re.I)
SKIP_TEXT = re.compile(r"\bmay refer to\b|\bcan refer to\b|\bmay mean\b", re.I)


def lead(text: str) -> str:
    """The opening paragraphs, up to MAX_CHARS, cut at a sentence end."""
    # Skip leftover infobox/table lines ("| caption = ...") and headings.
    paras = [p.strip() for p in text.split("\n") if len(p.strip()) > 40 and not p.strip().startswith(("|", "{", "!", "=")) and p.count(" | ") < 2]
    out = ""
    for p in paras:
        if len(out) + len(p) > MAX_CHARS:
            if not out:
                cut = p[:MAX_CHARS]
                out = cut[: cut.rfind(". ") + 1] or cut
            break
        out = f"{out} {p}".strip()
    return out


def main():
    OUT.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        parquet = Path(tmp) / "simplewiki.parquet"
        print("Downloading Simple English Wikipedia (157 MB, one time)...", flush=True)
        urllib.request.urlretrieve(URL, parquet)
        partial = OUT.with_suffix(".building")
        partial.unlink(missing_ok=True)
        db = sqlite3.connect(partial)
        db.execute("CREATE VIRTUAL TABLE kb USING fts5(title, body, tokenize = 'porter unicode61')")
        db.execute("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)")
        kept = 0
        pf = pq.ParquetFile(parquet)
        for batch in pf.iter_batches(columns=["title", "text"], batch_size=5000):
            rows = []
            for title, text in zip(batch.column("title").to_pylist(), batch.column("text").to_pylist()):
                if not title or not text or SKIP_TITLE.search(title):
                    continue
                body = lead(text)
                if len(body) < 120 or SKIP_TEXT.search(body[:300]):
                    continue
                rows.append((title, body))
            db.executemany("INSERT INTO kb (title, body) VALUES (?, ?)", rows)
            kept += len(rows)
            print(f"  {kept:,} articles", end="\r", flush=True)
        db.execute("INSERT INTO kb (kb) VALUES ('optimize')")
        db.executemany("INSERT INTO meta VALUES (?, ?)", [("source", "Simple English Wikipedia, Nov 2023 (CC BY-SA 4.0)"), ("articles", str(kept))])
        db.commit()
        db.close()
        partial.replace(OUT)
    print(f"\nDone: {kept:,} articles in {OUT} ({OUT.stat().st_size / 1e6:.0f} MB)")


if __name__ == "__main__":
    sys.exit(main())
