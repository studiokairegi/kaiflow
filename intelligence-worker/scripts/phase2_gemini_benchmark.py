"""Phase 2 live Gemini benchmark. RUN BY THE OWNER on the worker machine; it makes REAL Gemini requests (free tier, within the local caps).

    python scripts/phase2_gemini_benchmark.py --models gemini-3.8-flash,<flash-lite id> --repeats 2 --out MODEL_BENCHMARK_RESULTS_RAW.md

Only synthetic, non-private prompts are used. Requests are paced to stay under KAIRFLOW_GEMINI_RPM (default 10) and stop at --max-requests
(default 30, below the 200/day cap). The key is read from KAIRFLOW_GEMINI_API_KEY and never printed. Nothing is written to Supabase.
"""
from __future__ import annotations

import argparse, os, sys, time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from kairflow_intel.errors import PermanentError, TransientError            # noqa: E402
from kairflow_intel.gemini import GeminiClient                               # noqa: E402

OBJ = lambda *keys: {"type": "object", "required": list(keys), "properties": {k: {"type": "string"} for k in keys}}
TASKS = {
    "research": ("Extract the studio name and the game title from the text. Do not guess.", "Hollow Lantern is a 2D action game by Moss Pixel Studio, funded on Kickstarter in 2025.", OBJ("studio", "game"), {"studio": "moss pixel studio", "game": "hollow lantern"}),
    "evaluation": ("Answer yes or no in field 'fit': does this prospect plausibly need 2D animation? Give a one-sentence reason.", "Indie team building a hand-drawn anime-style visual novel with animated cutscenes.", OBJ("fit", "reason"), {"fit": "yes"}),
    "drafting": ("Write a two-sentence outreach opening from Studio Kairegi (a studio, not a freelancer). Do not offer free samples or invent facts. Fields: subject, body.", "Prospect: Moss Pixel Studio, developing Hollow Lantern.", OBJ("subject", "body"), {}),
    "chat": ("Reply briefly in field 'reply' to the administrator's question.", "How many prospects can I contact per day if the daily limit is 20 and I already sent 5?", OBJ("reply"), {"reply": "15"}),
    "instruction_following": ("Return JSON with field 'items' containing exactly the three words: red, green, blue, in that order, comma-separated, lower case, nothing else.", "n/a", OBJ("items"), {"items": "red,green,blue"}),
}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--models", required=True); ap.add_argument("--repeats", type=int, default=2)
    ap.add_argument("--max-requests", type=int, default=30); ap.add_argument("--out", default="MODEL_BENCHMARK_RESULTS_RAW.md")
    a = ap.parse_args()
    key = os.environ.get("KAIRFLOW_GEMINI_API_KEY", "").strip()
    if not key:
        print("KAIRFLOW_GEMINI_API_KEY is not set"); return 2
    rpm = int(os.environ.get("KAIRFLOW_GEMINI_RPM", "10") or 10)
    gap = 60.0 / max(rpm, 1) + 0.5
    rows, n = [], 0
    for model in [m.strip() for m in a.models.split(",") if m.strip()]:
        client = GeminiClient(key, model, json_model=model)
        for task, (instr, text, schema, expect) in TASKS.items():
            if n >= a.max_requests:
                break
            for rep in range(a.repeats):
                if n >= a.max_requests:
                    print("request limit reached"); break
                n += 1; t0 = time.monotonic(); outcome, correct, tokens = "ok", None, ""
                try:
                    r = client.generate_json_ex(instr, text, schema, fast=False, timeout=60, site="health.gemini")
                    tokens = str((r.usage or {}).get("totalTokens"))
                    norm = lambda x: str(x).lower().replace(" ", "")
                    correct = all(norm(v) in norm(r.data.get(k, "")) for k, v in expect.items()) if expect else None
                except (TransientError, PermanentError) as exc:
                    outcome = getattr(exc, "kind", type(exc).__name__)
                rows.append((model, task, rep + 1, outcome, f"{time.monotonic() - t0:.2f}", tokens, correct))
                time.sleep(gap)
    lines = ["| model | task | run | outcome | seconds | total tokens | matches expected |", "|---|---|---|---|---|---|---|"]
    lines += [f"| {' | '.join(str(c) for c in r)} |" for r in rows]
    Path(a.out).write_text("# Raw Gemini benchmark output\n\nReal requests; synthetic prompts only. 'matches expected' is a crude substring check; judge drafting quality by eye.\n\n" + "\n".join(lines) + "\n", encoding="utf-8")
    print(f"{len(rows)} requests; wrote {a.out}"); return 0


if __name__ == "__main__":
    raise SystemExit(main())
