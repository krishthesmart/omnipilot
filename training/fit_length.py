"""Drops training examples longer than the training sequence limit, measured with
the real tokenizer. Truncating instead would cut answers off (or remove them
entirely when a long prompt fills the limit), which breaks training."""
import json
import sys
from pathlib import Path

from huggingface_hub import snapshot_download
from mlx_lm.utils import load_tokenizer

LIMIT = int(sys.argv[1]) if len(sys.argv) > 1 else 1024
tok = load_tokenizer(Path(snapshot_download("Qwen/Qwen2.5-0.5B-Instruct", allow_patterns=["*.json", "*.txt"])))
for name in ("train", "valid"):
    path = Path(__file__).parent / "work" / "dataset" / f"{name}.jsonl"
    rows = [json.loads(l) for l in path.read_text().split("\n") if l.strip()]
    kept = [r for r in rows if len(tok.apply_chat_template(r["messages"], tokenize=True)) <= LIMIT]
    path.write_text("".join(json.dumps(r) + "\n" for r in kept))
    print(f"{name}: kept {len(kept)} of {len(rows)} (dropped {len(rows) - len(kept)} longer than {LIMIT} tokens)")
