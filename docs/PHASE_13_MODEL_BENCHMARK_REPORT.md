# Phase 13 — Local Ollama capacity and quality benchmark

## Target constraints

The project roadmap identifies a Windows workstation with an NVIDIA GTX 1650 (4 GB VRAM) and 16 GB system RAM. The benchmark must run on that actual workstation. This execution environment is not that Windows machine and has no reachable local Ollama service or GTX 1650; therefore no actual model latency, token throughput, GPU offload, peak VRAM, or English/Japanese model quality result is claimed here.

## Configured model candidates

- Main model: `qwen2.5:3b-instruct`
- Fast model: `qwen2.5:1.5b-instruct`

These are configuration defaults, not evidence that either model is installed or performs acceptably on the target machine.

## Benchmark harness

`intelligence-worker/scripts/phase13_ollama_benchmark.py` runs synthetic prompts against the loopback Ollama `/api/chat` endpoint. It:

- Verifies configured model tags are installed.
- Measures warm and repeated request latency.
- Captures Ollama load, prompt-evaluation and generation durations and token counts.
- Calculates output tokens/second when Ollama provides the counters.
- Captures platform, CPU count, RAM (when `psutil` is installed) and GPU information (`nvidia-smi`, or Windows CIM fallback).
- Exercises English extraction, Japanese extraction, English first-contact drafting and Japanese first-contact drafting.
- Saves full structured outputs for manual factuality, fluency, tone and unsupported-claim review.

It uses synthetic content only. It does not access Supabase, external websites, mailboxes or send email. The URL is validated before any operation and must be plain HTTP to `localhost`, a `127.0.0.0/8` address, or `::1`; remote hosts, credentials, URL paths, queries and fragments are rejected. This restriction also applies when `KAIRFLOW_OLLAMA_URL` is set. `--self-test` validates the cases without contacting Ollama. Each model response is independently checked for the exact required keys, allowed language (`en` or `ja`), field types, facts-array element types and documented string-length limits before being counted or saved.

Example command on the target Windows machine from `intelligence-worker`:

```powershell
python scripts/phase13_ollama_benchmark.py --repeats 3 --warmups 1 --num-ctx 4096 --timeout 300 --output phase13_benchmark_4096.json
```

Repeat with `--num-ctx 8192` only if the first run has stable memory headroom. Avoid starting with 16k context on a 4 GB GPU. Close other GPU-heavy applications, record whether Ollama is using GPU or CPU offload, and capture `nvidia-smi` before/during/after the run. Run each model independently if both resident models exceed memory.

## Quality rubric

Score each model/case 1–5 for:

1. Evidence fidelity: every claim is supported; no invented capacity, clients, awards, volume or outsourcing demand.
2. Extraction completeness: all material explicit facts retained; unknowns remain unknown.
3. English naturalness and concise professional tone.
4. Japanese naturalness, honorific appropriateness and avoidance of overly literal translation.
5. Instruction adherence and schema validity.

Any fabricated factual claim is a critical failure regardless of average score. Drafts are benchmark artifacts only and must never be sent. Existing deterministic policy checks and human approval remain authoritative.

## Timeout and failure behavior review

The existing Ollama client classifies connection/read timeouts and malformed structured output as `TransientError`, HTTP 429/5xx as transient, and HTTP 4xx (except 429) as `PermanentError`. Worker job retry/lease policy handles transient failures. Phase 13 adds regression coverage for these classifications. The current Requests timeout is a connect/read inactivity timeout, not a strict wall-clock deadline; very long generation behavior should be measured on target hardware. Do not lower timeouts based on a synthetic or non-target machine benchmark.

## Results in this environment

- Benchmark definition self-test: passed.
- Benchmark harness regression test: passed.
- Ollama timeout / 429 / 5xx / permanent 4xx / malformed-output regression tests: passed.
- Python worker suite after benchmark hardening: 466 passed, 0 failed.
- Focused Phase 13 tests: 11 passed, 0 failed.
- JavaScript suite: 822 passed, 0 failed.
- Remote-host URL rejection and strict schema-validation regression tests: passed.
- Actual Ollama model runs: not performed; no local Ollama endpoint available in this execution environment.
- GTX 1650/16 GB memory and GPU-offload measurement: not performed; target Windows hardware unavailable.
- English/Japanese quality scoring: pending target-machine run and human review.

The benchmark JSON generated on the target machine should be attached to this report before choosing a model/context profile. Until then, retain the existing model defaults and avoid claiming the 3B model fits fully in 4 GB VRAM.
