"""Stage 1: turn GSM8K worked solutions into OmniPilot's step format.

GSM8K solutions mark each calculation like "48/2 = <<48/2=24>>24". Those become
steps ("s1 = 48/2"); a number that repeats an earlier result is replaced by that
step's name, so later steps refer back instead of copying digits. Stage 2
(validate.mts) runs every example through OmniPilot's own step runner and keeps
only the ones that reproduce the correct answer.
"""
import json
import random
import re
from pathlib import Path

import pyarrow.parquet as pq

WORK = Path(__file__).parent / "work"
ANNOTATION = re.compile(r"<<([^<>=]+)=([^<>]+)>>")
NUMBER = re.compile(r"(?<![\w.])\d+(?:\.\d+)?(?![\w.])")
SAFE_EXPR = re.compile(r"^[\d.+\-*/() ]+$")


def to_float(s):
    try:
        return float(s.replace(",", "").strip())
    except ValueError:
        return None


def convert(question, answer):
    gold = to_float(answer.split("####")[-1])
    if gold is None:
        return None
    calcs = ANNOTATION.findall(answer)
    if not calcs:
        return None
    steps, results = [], []  # results: (name, value)
    for i, (expr, res) in enumerate(calcs):
        expr = expr.replace(",", "").strip()
        value = to_float(res)
        if value is None or not SAFE_EXPR.match(expr):
            return None

        def refer(m):
            v = float(m.group(0))
            for name, prev in reversed(results):
                if abs(prev - v) < 1e-9 and v not in (0, 1, 2):  # small constants stay literal
                    return name
            return m.group(0)

        expr = NUMBER.sub(refer, expr)
        name = "answer" if i == len(calcs) - 1 else f"s{i + 1}"
        steps.append(f"{name} = {expr}")
        results.append((name, value))
    reasoning = ANNOTATION.sub("", answer.split("####")[0])
    reasoning = re.sub(r"\s+", " ", reasoning).strip()
    if len(reasoning) > 700:
        return None
    return {"question": question.strip(), "reasoning": reasoning, "steps": steps, "gold": gold}


def main():
    random.seed(7)
    out = WORK / "candidates"
    out.mkdir(parents=True, exist_ok=True)
    for split in ("train", "test"):
        table = pq.read_table(WORK / "data" / f"gsm8k-{split}.parquet").to_pylist()
        rows = [r for r in (convert(t["question"], t["answer"]) for t in table) if r]
        with open(out / f"gsm8k-{split}.jsonl", "w") as f:
            for r in rows:
                f.write(json.dumps(r) + "\n")
        print(f"gsm8k {split}: {len(rows)} of {len(table)} converted")
        if split == "test":
            # The benchmark uses every test problem, not just the ones that converted.
            with open(out / "gsm8k-test-all.jsonl", "w") as f:
                for t in table:
                    f.write(json.dumps({"question": t["question"].strip(), "gold": to_float(t["answer"].split("####")[-1])}) + "\n")

    # General instructions, so the model keeps its everyday abilities.
    alpaca = json.load(open(WORK / "data" / "alpaca.json"))
    alpaca = [a for a in alpaca if len(a["instruction"]) + len(a["input"]) + len(a["output"]) < 1400 and a["output"].strip()]
    random.shuffle(alpaca)
    with open(out / "general.jsonl", "w") as f:
        for a in alpaca[:1500]:
            user = a["instruction"] + (f"\n\n{a['input']}" if a["input"].strip() else "")
            f.write(json.dumps({"user": user, "assistant": a["output"].strip()}) + "\n")
    print("general: 1500")


if __name__ == "__main__":
    main()
