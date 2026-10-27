# omnipilot-mini

A small model (about 400 MB) trained on this computer for one job OmniPilot
relies on: turning a word problem into exact calculation steps. OmniPilot then
runs the steps itself, so the model never does arithmetic in its head.

```bash
npm run train      # Apple Silicon Mac, uv, Node 22+, Ollama. About an hour on an M1 Pro.
```

Then choose **omnipilot-mini** under the brain icon in OmniPilot.

## How it's built

1. **Data** (`build_data.py`, `validate.mts`)
   - [GSM8K](https://huggingface.co/datasets/openai/gsm8k) (MIT licence): 7,473
     grade-school word problems with human-written worked solutions. Every
     calculation in a solution becomes a step (`s1 = 48/2`, `answer = 48 + s1`).
   - Each converted example is run through OmniPilot's own step runner
     (`server/src/lib/math/pal.ts`) and kept only if it reproduces the correct
     answer: 6,947 of 7,473.
   - 1,500 general instructions from [Alpaca-cleaned](https://huggingface.co/datasets/yahma/alpaca-cleaned)
     (CC BY-NC 4.0, for research and non-commercial use) are mixed in, so the
     model keeps its everyday abilities.
   - Examples use exactly the prompt, example and output schema OmniPilot sends
     at runtime.
2. **Training** (`lora.yaml`): LoRA fine-tune of
   [Qwen2.5-0.5B-Instruct](https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct)
   (Apache 2.0) with [MLX](https://github.com/ml-explore/mlx), one pass over the
   data, loss on the answers only.
3. **Packaging** (`Modelfile`): the adapter is merged into the model, which is
   imported into Ollama at 4-bit (`q4_K_M`).

The GSM8K test problems are never used for training; they're the benchmark.

## Benchmark

Run any model on the held-out GSM8K test problems:

```bash
cd server
npx tsx ../training/eval.mts --model omnipilot-mini --method vote --n 150
```

- `direct`: the model reasons and answers by itself.
- `steps`: the model writes steps, OmniPilot calculates (one try).
- `vote`: three tries, majority answer (what OmniPilot's Helper does).

Results are filled in by the latest run below.

## Licences

The trained model is a derivative of Qwen2.5-0.5B-Instruct (Apache 2.0). Its
training data includes GSM8K (MIT) and Alpaca-cleaned (CC BY-NC 4.0), so share
the trained model for non-commercial use only, or rebuild it without the
Alpaca portion.
