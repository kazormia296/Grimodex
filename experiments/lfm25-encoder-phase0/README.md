# Grimodex LFM2.5 Encoder Phase 0

This directory is an offline research harness for deciding whether
`LiquidAI/LFM2.5-Encoder-230M` is worth carrying into a product-integration
phase. It does not alter Semantic Recall, Impact Review, Kouetsu, Electron,
Rust, N-API, or MCP behavior.

Phase 0 keeps two independent tracks:

- Semantic Recall reranking: the encoder is pure added latency, so it must
  improve ranking while meeting the strict 12/30-candidate warm budgets.
- Impact Review triage: the encoder may be slower, but only if retained
  candidates reduce downstream generation time and cost without losing
  affected scenes.

No Phase 0 result removes a product candidate. All decisions are shadow
evaluation only.

## Implemented scope

The current PR 1 scope includes:

- versioned relevance and impact data contracts;
- story-level split leakage and stable-ID validation;
- canonical pair serialization;
- masked-mean binary classifier with fp32 logits;
- exact model revision pinning and SHA-256 snapshot manifests;
- offline-only model/tokenizer loading after manifest verification;
- C0 CPU and available-GPU forward/backward smoke;
- cold, warm, length, batch, bucket, and CPU-thread benchmark primitives;
- automatic Target / Conditional / Hold / Reject speed decisions;
- host profile, RSS, and Node event-loop contention evidence;
- lightweight CI tests that never download the model.

Corpus builders, production dev exporters, frozen probes, full fine-tuning,
locked-test quality evaluation, and final break-even reporting remain gated on
the C0.5 result. A track that lands in Reject does not proceed to corpus
expansion.

The first host's C0 and C0.5 outcome is recorded in
[`RESULTS.md`](./RESULTS.md). Both warm tracks reached Reject, so this branch
intentionally stops at PR 1.

## Fixed supply-chain inputs

- Model: `LiquidAI/LFM2.5-Encoder-230M`
- Revision: `0b649ad0c684378b03d4d8304f7577a662ab89bc`
- Transformers: `5.1.0`, matching the pinned model configuration
- Environment resolver: `uv 0.11.29`

The model contains custom Python code. `trust_remote_code=True` is never used
against the network model ID. Bootstrap downloads without importing the model,
writes a full-file SHA-256 manifest, lists custom code files, and the runtime
only enables custom code from that verified local snapshot.

If a floating revision such as `main` is supplied, bootstrap resolves and
prints the commit SHA but exits before downloading. Update `common.yaml` with
the exact SHA and rerun.

## Environment

Python 3.11–3.14 is supported. Python 3.12 is the recommended shared baseline.
Install the pinned `uv` release, then select exactly one PyTorch backend:

```bash
cd experiments/lfm25-encoder-phase0

# Phase 0 CPU baseline and CI
uv sync --frozen --extra cpu

# NVIDIA CUDA 12.8
uv sync --frozen --extra cu128

# AMD ROCm 7.2 on Linux
uv sync --frozen --extra rocm72
```

The extras conflict intentionally, preventing a lock or environment from
silently mixing accelerator builds. CPU is the normative C0.5 gate. GPU smoke
is additional compatibility evidence, not a substitute for CPU measurements.

Capture the exact installed environment alongside a run:

```bash
uv pip freeze > artifacts/environment-lock.txt
```

`uv.lock` is committed. `.venv*/`, snapshots, checkpoints, private data, and
generated artifacts are ignored.

## Lightweight verification

These commands do not download or execute model custom code:

```bash
uv run --frozen --extra cpu pytest
uv run --frozen --extra cpu python tools/validate_dataset.py data/public
```

The tests cover schema validation, exact spans, canonical serialization,
story leakage, deterministic sampling, metric math, validation-only threshold
selection, manifest drift, privacy redaction, sample floors, warmup exclusion,
speed budgets, masked pooling, and batch-order equivalence.

## Bootstrap and offline smoke

Bootstrap is the only online model command:

```bash
uv run --frozen --extra cpu \
  python tools/bootstrap_model.py --config configs/common.yaml
```

After bootstrap, disconnect the network or explicitly retain offline mode. The
CPU smoke verifies eight 256-token samples and one optimizer step:

```bash
HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 \
  uv run --frozen --extra cpu \
  python -m grimodex_lfm_eval.train \
  --config configs/relevance-1024.yaml \
  --smoke
```

An accelerator backend must use a separate environment so the CPU baseline is
not replaced. For example, CUDA smoke is:

```bash
UV_PROJECT_ENVIRONMENT=.venv-cu128 uv sync --frozen --extra cu128

HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 \
  UV_PROJECT_ENVIRONMENT=.venv-cu128 \
  uv run --frozen --extra cu128 \
  python -m grimodex_lfm_eval.train \
  --config configs/relevance-1024.yaml \
  --smoke
```

The smoke runner always measures CPU and then the default CUDA/ROCm device
exposed by the selected Torch build.

The report is written beneath `artifacts/smoke/`. Any file added, removed, or
changed in the local snapshot causes loading to fail before custom code runs.

## C0.5 early performance gate

The CPU configuration measures:

- independent-process cold start, at least five runs;
- warm single pairs at 256, 512, 1,024, 2,048, 4,096, and 8,192 tokens;
- 30 measured iterations for inputs through 2,048 tokens and 10 for longer
  inputs, excluding warmup;
- tokenization, forward, post-processing, and end-to-end timings;
- relevance groups of 12 and 30 candidates;
- impact groups of 30 candidates at 2,048 tokens;
- batch sizes 1, 2, 4, and 8;
- naive and length-bucketed order;
- 1, 2, 4, 8, and physical-core thread counts;
- p50, p95, maximum, bootstrap p95 interval, resident RSS, and peak RSS.

Do not begin with the complete final cross-product. It is intentionally
expensive because every selected configuration receives the formal sample
floor. First use one-sample pilots to choose promising batch, bucket, and
thread settings. For example, screen the larger batches on physical and eight
threads without repeating the independent length sweep:

```bash
HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 \
  uv run --frozen --extra cpu \
  python -m grimodex_lfm_eval.benchmark \
  --config configs/benchmark-cpu.yaml \
  --mode pilot \
  --skip-length-sweep \
  --batch-sizes 4,8 \
  --thread-counts physical,8 \
  --bucket-modes naive,bucketed \
  --impact-context-modes full
```

Pilot artifacts are explicitly labelled `measurementStage: "pilot"`, accept
as few as one measured sample, and never emit a gate decision. They are only
configuration-search evidence.

Then run the best selected configuration in a fresh process with the formal
30-sample floor and five independent cold starts:

```bash
HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 \
  uv run --frozen --extra cpu \
  python -m grimodex_lfm_eval.benchmark \
  --config configs/benchmark-cpu.yaml \
  --mode early-gate \
  --skip-length-sweep \
  --batch-sizes <selected-batch> \
  --thread-counts <selected-threads> \
  --bucket-modes <naive-or-bucketed> \
  --impact-context-modes <full-or-windowed> \
  --checkpoint artifacts/early-gate/final.checkpoint.json
```

The checkpoint atomically retains every completed workload sample. Repeating
the same command after an interruption validates the model/configuration key
and measures only the missing samples.

The JSON artifact is written beneath `artifacts/early-gate/`. Render a compact
decision report with:

```bash
uv run --frozen --extra cpu \
  python -m grimodex_lfm_eval.report \
  --performance-run artifacts/early-gate/<run>.json \
  --output artifacts/early-gate/<run>.md
```

### Speed budgets

| Workload                          | Target | Conditional | Hold | Reject |
| --------------------------------- | -----: | ----------: | ---: | -----: |
| Relevance, 12 candidates warm p95 |    ≤1s |         ≤2s |  ≤4s |    >4s |
| Relevance, 30 candidates warm p95 |    ≤2s |         ≤4s |  ≤8s |    >8s |
| Impact, 30 candidates warm p95    |    ≤5s |        ≤10s | ≤20s |   >20s |
| Cold start                        |    ≤5s |        ≤15s | >15s |      — |

The final runner selects the best measured configuration present in that
formal report before classifying each track. A cold Hold does not reject a
warm-viable track, but it requires lazy or idle preload in Phase 1.

## Host contention proxy

After choosing a thread cap, compare Node event-loop delay with and without a
continuous 30-candidate encoder workload:

```bash
node tools/host_contention_probe.mjs \
  --config configs/benchmark-contention.yaml \
  --output artifacts/contention.json
```

This is a host-contention proxy, not renderer input-latency proof. A regression
requires worker isolation, a thread cap, and priority control in Phase 1.

## Data and privacy invariants

- Split by `storyId`, never by pair.
- Keep test locked until configuration and validation thresholds are fixed.
- Use Japanese as the primary evaluation and report English separately.
- Keep private corpus under `data/private/`.
- Private IDs, story IDs, paths, queries, diffs, and text are redacted from
  report-safe records by default.
- Do not put snapshots, model weights, checkpoints, generated predictions, or
  private text in Git.

`data/public/splits.json` is the split authority. Every JSONL story must appear
in exactly one of `train`, `validation`, `test`, or `challenge`.

## Exit criteria for PR 1

PR 1 is complete when the fixed environment and lightweight tests pass,
bootstrap can reproduce and verify the exact snapshot, offline C0 smoke passes,
and C0.5 produces workload decisions. The last two require the local 924 MB
snapshot and are manual evidence by design; CI never downloads it.
