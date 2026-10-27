#!/usr/bin/env bash
# Builds omnipilot-mini (about 400 MB) on this computer, for free: OmniPilot's whole
# brain (routing, every specialist, composing answers, math steps).
#   GSM8K steps + teacher recordings of every OmniPilot job (verified) + general
#   instructions -> LoRA fine-tune of Qwen2.5-0.5B-Instruct with MLX -> merged ->
#   imported into Ollama at 4-bit.
# Needs: an Apple Silicon Mac, uv, Node 22+, Ollama. Several hours on an M1 Pro.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p work/data

if [ ! -x .venv/bin/python ]; then
  echo "== Python environment"
  uv venv --python 3.12 .venv -q
  uv pip install --python .venv/bin/python -q "mlx==0.32.3" "mlx-lm==0.31.3" "pyarrow==25.0.1"
fi

echo "== Data"
for s in train test; do
  [ -f "work/data/gsm8k-$s.parquet" ] || curl -sSL -o "work/data/gsm8k-$s.parquet" "https://huggingface.co/datasets/openai/gsm8k/resolve/main/main/$s-00000-of-00001.parquet"
done
[ -f work/data/alpaca.json ] || curl -sSL -o work/data/alpaca.json "https://huggingface.co/datasets/yahma/alpaca-cleaned/resolve/main/alpaca_data_cleaned.json"
.venv/bin/python build_data.py

# Teacher recordings: every job OmniPilot gives its model, done by an Apache-2.0 teacher
# (qwen3.5:9b) running the real pipeline, then filtered to verified-good calls. Takes
# hours; skipped if recordings already exist. Set TEACHER=none to skip entirely.
TEACHER="${TEACHER:-qwen3.5:9b}"
if [ "$TEACHER" != "none" ]; then
  ollama list | grep -q "^${TEACHER}" || ollama pull "$TEACHER"
  (cd ../server && npx tsx ../training/record.mts --teacher "$TEACHER")
  # With the offline encyclopedia built (npm run knowledge), factual questions are recorded
  # again so the model learns to answer from passages and cite them.
  [ -f ../server/data/knowledge.sqlite ] && (cd ../server && npx tsx ../training/record.mts --teacher "$TEACHER" --only everyday --pass kb)
  ollama stop "$TEACHER" || true   # free its memory before training
  (cd ../server && npx tsx ../training/filter.mts)
fi
(cd ../server && npx tsx ../training/validate.mts)
.venv/bin/python fit_length.py 1024   # must match max_seq_length in lora.yaml

echo "== Training (progress in work/train.log)"
.venv/bin/python -m mlx_lm lora -c lora.yaml 2>&1 | tee work/train.log | grep --line-buffered -E "^Iter [0-9]+: (Train|Val)"

echo "== Packaging"
.venv/bin/python -m mlx_lm fuse --model Qwen/Qwen2.5-0.5B-Instruct --adapter-path work/adapters-brain --save-path work/fused
ollama create omnipilot-mini -f Modelfile --quantize q4_K_M
rm -rf work/fused   # the merged full-size copy is only needed for the import
ollama list | grep omnipilot-mini
echo "Done. Pick omnipilot-mini in OmniPilot (brain icon), or benchmark it: (cd server && npx tsx ../training/eval.mts --model omnipilot-mini --method vote)"
