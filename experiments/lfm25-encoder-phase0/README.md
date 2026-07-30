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

The rejected LFM path remains research-only. Phase 0b's selected small
rerankers are consumed by a separate experimental opt-in product integration;
this directory remains the offline evidence and reproduction harness.

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

## Phase 0b quantized reranker gate

Phase 0b is a separate follow-up speed gate. It does not reopen the rejected
LFM path, create a corpus, or run fine-tuning. It measures the official AVX2
quantized ONNX artifacts for three smaller language-specific rerankers; the
two selected models are now used by the separate experimental opt-in product
path:

| Key            | Model                                    | Pinned artifact          | License    |
| -------------- | ---------------------------------------- | ------------------------ | ---------- |
| `ja_tiny`      | `hotchpotch/japanese-reranker-tiny-v2`   | `model_qint8_avx2.onnx`  | MIT        |
| `ja_xsmall`    | `hotchpotch/japanese-reranker-xsmall-v2` | `model_qint8_avx2.onnx`  | MIT        |
| `en_minilm_l4` | `cross-encoder/ms-marco-MiniLM-L4-v2`    | `model_quint8_avx2.onnx` | Apache-2.0 |

Exact Hugging Face revisions, upstream ONNX SHA-256 digests, selected
tokenizer files, and local manifest paths are fixed in
`configs/phase0b-rerankers.yaml`. Bootstrap downloads only those files; it
does not download PyTorch or safetensors weights:

```bash
uv run --frozen --extra cpu \
  python tools/bootstrap_rerankers.py \
  --config configs/phase0b-rerankers.yaml
```

Every offline load verifies the complete selected snapshot manifest and the
upstream ONNX digest before creating a session. ONNX Runtime is pinned to
1.24.2, matching the current product-side runtime line. The session explicitly
disables memory-pattern optimization and the CPU memory arena because
reranker inputs vary by shape.

The warm benchmark includes tokenization, ONNX inference, and score extraction.
It uses deterministic Japanese or English query/passage pairs over four length
tiers, truncates each combined pair to 512 tokens, and evaluates 12- and
30-candidate groups. Generated snapshots and reports remain ignored beneath
`local/phase0b/` and `artifacts/phase0b/`.

First screen batch, bucket, and thread settings for each model:

```bash
for model in ja_tiny ja_xsmall en_minilm_l4; do
  HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 \
    uv run --frozen --extra cpu \
    python -m grimodex_lfm_eval.reranker_benchmark \
    --config configs/phase0b-rerankers.yaml \
    --model "$model" \
    --mode pilot \
    --batch-sizes 4,8,16 \
    --thread-counts 4,physical,8 \
    --bucket-modes naive,bucketed \
    --skip-cold
done
```

Then run each model's best observed configuration with the formal 30-sample
floor and five independent cold starts:

```bash
HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 \
  uv run --frozen --extra cpu \
  python -m grimodex_lfm_eval.reranker_benchmark \
  --config configs/phase0b-rerankers.yaml \
  --model <model-key> \
  --mode early-gate \
  --batch-sizes <selected-batch> \
  --thread-counts <selected-threads> \
  --bucket-modes <naive-or-bucketed>
```

The Semantic Recall C0.5 budgets remain unchanged: 12 candidates must stay at
or below 4 seconds and 30 candidates at or below 8 seconds to avoid Reject.
Only models that pass this speed gate may proceed to the existing locked
retrieval-quality evaluation. Impact Review windowing and task-specific
fine-tuning remain later, separately gated work.

The initial Ryzen 5 3600 Gate 1 outcome is recorded in
[`PHASE0B_RESULTS.md`](./PHASE0B_RESULTS.md). All three candidates reached the
Target latency band; this permits quality evaluation but does not select a
production model.

### Gate 2 fixed-candidate quality evaluation

Gate 2 freezes one production-generated candidate pool per query before any
reranker runs. The committed Japanese and English JSONL records carry the
chunk text, dense score/rank, sparse rank, current RRF rank, scene identity,
and scene relevance label for exactly 30 candidates. Human-reviewed
chunk-level qrels in `data/public/gate2/chunk-qrels.json` identify the exact
passage ranges that answer each query. Rerankers may reorder these IDs and
choose a better chunk inside an admitted scene, but cannot retrieve again or
replace the current dense/sparse scene-admission thresholds.

Before quality evaluation, the direct quantized tokenizer/ONNX path is checked
against the pinned official FP32 ONNX and Hugging Face tokenizer on 12 fixed
positive/negative pairs. Token IDs, masks, special tokens, truncation, score
direction, and ranking agreement must pass; MiniLM also verifies
`token_type_ids`.

Bootstrap the separately pinned reference artifacts:

```bash
make bootstrap-reranker-references
```

Run parity and Gate 2 for a selected model. Choose the matching Japanese or
English candidate and parity files:

```bash
make reranker-parity \
  PHASE0B_MODEL=ja_xsmall \
  PHASE0B_GATE2_CANDIDATES=data/public/gate2/candidates-ja.jsonl \
  PHASE0B_GATE2_PAIRS=data/public/gate2/parity-pairs-ja.jsonl \
  PHASE0B_GATE2_THREADS=4

make reranker-gate2 \
  PHASE0B_MODEL=ja_xsmall \
  PHASE0B_GATE2_CANDIDATES=data/public/gate2/candidates-ja.jsonl \
  PHASE0B_GATE2_CHUNK_QRELS=data/public/gate2/chunk-qrels.json \
  PHASE0B_GATE2_THREADS=4
```

The runner reports chunk MRR/NDCG@3, scene MRR/Recall@1/Recall@3, final
injection behavior, paired bootstrap intervals, query improvements and
regressions, named slices, hard negatives, candidate-depth effects, and 30
real-corpus latency samples. Cross-encoder logits are ordering signals only;
they are never compared with the current cosine/BGE thresholds.

The completed Ryzen 5 3600 result and exact reproduction commands are recorded
in [`PHASE0B_GATE2_RESULTS.md`](./PHASE0B_GATE2_RESULTS.md). Japanese xsmall
top-30 and English MiniLM-L4 top-30 pass the Gate 2 promotion rule for
experimental opt-in integration. Top 30 additionally improves exact-passage
inclusion on the Japanese fixture while staying in the Target latency band.
The product path keeps current scene admission authoritative: admission is
applied only to each scene's best dense chunk, rescue-only results never
backfill a second chunk, and dense-pass backfill requires the secondary chunk
itself to meet `minScore`. The reranker changes chunks only inside those fixed
scene quotas and falls back to the baseline order on any failure.

### Gate 3 Impact Review pre-training speed

Gate 3 asks a narrow lower-bound question before any Impact Review corpus
construction or fine-tuning: can either selected Japanese backbone process one
Codex change against 30 preselected candidate windows inside the existing
Impact latency budget on CPU? The original fixed workload contains 30 windows
but only 18 distinct scene IDs, so it does not represent 30 complete scenes.

| Key                 | Backbone                                 | Input cap | Head used by this gate |
| ------------------- | ---------------------------------------- | --------- | ---------------------- |
| `ja_xsmall`         | `hotchpotch/japanese-reranker-xsmall-v2` | 512       | temporary binary head  |
| `modernbert_ja_30m` | `sbintuitions/modernbert-ja-30m`         | 512       | temporary binary head  |

The committed workload is derived from the SHA-256-pinned Japanese Gate 2
candidate file. It serializes one canonical `ImpactDiffPayload` and pairs it
with exactly 30 public Japanese candidate windows from 18 distinct scenes.
The diff has a 128-token budget, each window has a 384-token budget, and pair
truncation preserves the diff while truncating only the scene side.

Both models use the same seed-42 fp32 linear head over masked-mean backbone
output. The head is intentionally untrained: scores and rankings make no
quality claim and must not be used for product selection. This gate measures
only tokenization, backbone forward, and end-to-end preprocessing cost before
the more expensive corpus and training work.

Bootstrap the exact revisions and verify the complete local manifests:

```bash
make bootstrap-impact-gate3
```

Screen batch, bucket, and CPU-thread choices independently for each model:

```bash
for model in ja_xsmall modernbert_ja_30m; do
  make impact-gate3-pilot IMPACT_GATE3_MODEL="$model"
done
```

Then promote only the best observed configuration for each model to the
formal run. The runner excludes three warmups, records 30 measured samples and
five independent cold starts, and writes the full timing, RSS, CPU, token, and
manifest evidence beneath `artifacts/phase0b/gate3/`:

```bash
make impact-gate3 \
  IMPACT_GATE3_MODEL=<model-key> \
  IMPACT_GATE3_FINAL_BATCH_SIZE=<selected-batch> \
  IMPACT_GATE3_FINAL_THREAD_COUNT=<selected-threads> \
  IMPACT_GATE3_FINAL_BUCKET_MODE=<naive-or-bucketed>
```

The 30-window lower-bound end-to-end p95 bands are Target at 5 seconds or less,
Conditional at 10 seconds or less, Hold at 20 seconds or less, and Reject
above 20 seconds. A Target result still requires Gate 3.1 before labeled work
is formalized: 30 distinct full scenes must be converted with the product
plain-text path, windowed at 384 tokens with stride 256, fully inferred, and
aggregated by maximum window score. Gate 3.1 also measures 30 fully occupied
384-token scene windows as a separate cap stress.

The completed Ryzen 5 3600 measurement is recorded in
[`PHASE0B_GATE3_RESULTS.md`](./PHASE0B_GATE3_RESULTS.md). Both candidates
reached Target for the lower-bound workload. Gate 4 implementation may remain
provisional, but xsmall and ModernBERT do not proceed to a formal labeled
decision until Gate 3.1 passes.

### Gate 3.1 distinct full-scene correction

Gate 3.1 closes the lower-bound gap before Gate 4 can become a formal
decision. Its public workload is regenerated from the deterministic medium
Japanese sample workspace. The exporter runs the production semantic index
and FTS backend, reuses `fuseSceneCandidates`, reads complete scene documents,
and converts each ProseMirror document with the product
`prosemirrorToText` path.

The frozen Codex-style change `記憶。失われた。取り戻した` produces 27
distinct dense scenes and 34 sparse scenes, for a 38-scene union. The product
RRF policy fixes the top 30 **inferred** scenes without synthetic padding.
Explicit semantic links are author-confirmed dependencies: they are always
retained, bypass the classifier, and do not consume the inferred 30-scene
limit.

For every model, the runner measures two workloads:

1. all 30 full scenes, tokenized without blind truncation into 384-token
   windows at stride 256, with every window inferred and each scene aggregated
   as `max(window score)`; and
2. 30 real, fully occupied 384-token windows as a separate cap stress.

Both reports include `sceneCount`, `windowCount`, windows-per-scene
p50/p95/max, attention tokens, and `truncatedSceneCount`. Gate 4 remains
provisional unless both workloads reach the five-second Target band.

Regenerate the public workload from a disposable medium sample workspace:

```bash
python3 scripts/seed-sample-ja.py <workspace> --scale medium
pnpm exec tsx experiments/lfm25-encoder-phase0/tools/freeze_impact_gate31_scenes.ts \
  --native-module electron/native/grimodex-node/grimodex-node.node \
  --resources src-tauri/resources/semantic \
  --workspace <workspace> \
  --output experiments/lfm25-encoder-phase0/data/public/gate31/impact-scenes-ja.json
```

Screen configurations, then run only the selected configuration formally:

```bash
for model in ja_xsmall modernbert_ja_30m; do
  make impact-gate31-pilot IMPACT_GATE31_MODEL="$model"
done

make impact-gate31 \
  IMPACT_GATE31_MODEL=<model-key> \
  IMPACT_GATE31_FINAL_BATCH_SIZE=<selected-batch> \
  IMPACT_GATE31_FINAL_THREAD_COUNT=<selected-threads> \
  IMPACT_GATE31_FINAL_BUCKET_MODE=<naive-or-bucketed>
```

The completed Ryzen 5 3600 result is recorded in
[`PHASE0B_GATE31_RESULTS.md`](./PHASE0B_GATE31_RESULTS.md). Both candidates
reach Target on the isolated 30-window cap stress but fall in Hold on the 184
windows produced by 30 complete scenes. Gate 4 therefore remains provisional;
human-corpus expansion and product classifier integration do not proceed.

### Gate 4 minimal Impact probe

Gate 4 compares frozen-head and full-fine-tuning runs for both Gate 3
backbones on a 240-record controlled public probe. Each production-shaped diff
has one exact-span positive and one same-change hard negative. The 24 story
packs are isolated into train 140, validation 40, locked test 40, and
challenge 20 records.

The data is synthetic and deliberately marked `unreviewed`. Only after the
Gate 3.1 latency prerequisite passes could a pass here justify collecting a
larger human-reviewed shadow corpus; it still could not enable candidate
removal or establish Phase 1 readiness.

Verify that the committed corpus still matches its deterministic builder:

```bash
make build-impact-gate4-corpus
make validate
```

After the Gate 3 snapshots have been bootstrapped, run the four fixed
seed-42 candidates in offline mode:

```bash
make impact-gate4 \
  IMPACT_GATE4_OUTPUT=artifacts/phase0b/gate4/<new-run-id>
```

Checkpoint and threshold selection use validation only. Challenge then guards
against calibration shift before the finalist is selected, and only that
finalist may open the write-once locked test. The complete selection order,
stop rules, and evidence limits are fixed in
[`IMPACT_GATE4_PROTOCOL.md`](./IMPACT_GATE4_PROTOCOL.md).

The Ryzen 5 3600 seed-42 result is recorded in
[`PHASE0B_GATE4_RESULTS.md`](./PHASE0B_GATE4_RESULTS.md). Its synthetic
classifier result is retained only as provisional evidence: the later
production-shaped full-scene Gate 3.1 placed both finalists in Hold, so this
probe does not authorize Gate 4 promotion, human-corpus expansion, Phase 1, or
product integration.

### Optional shadow corpus diagnostics

Gate 2 public data is fixed as model-selection and regression validation. It
must not be presented as proof of cross-work generalization. The development
shadow can optionally be joined to hash-only private human labels without
persisting a query, candidate, or manuscript text:

```text
gate2-public       -> validation
shadow-private-dev -> local investigation
frozen-holdout     -> optional work-isolated evidence
```

The corpus manager creates the human judgment pool from the union of dense,
current hybrid, and selected-reranker top 10. It validates grades 0–3,
positive/no-match contracts, human-assigned work-family split isolation, exact
30-candidate evidence, and a non-overwriting frozen-holdout fingerprint. Its
report contains aggregate counts and rates only, with separate
candidate-generation, conditional-reranker, method-specific/common admission,
and end-to-end denominators. Diagnostic readiness separately reports quantity,
holdout coverage, named-slice floors, and maximum family contribution for
positive, no-match, holdout-positive, and holdout-no-match evidence. These
fields are not product-enablement conditions. Query deduplication is scoped to
a work family, so the same question remains valid across independent works.
Human-verified positive
labels cannot claim a no-match-only slice (`hard-no-match`,
`same-name-different-character`, `similar-event-wrong-target`,
`generic-fiction-overlap`, `proper-noun-only`, or
`scene-tail-distractor`); schema validation rejects that mismatch before slice
readiness is calculated.

The complete privacy contract, staged sample floors, slice taxonomy, and
commands are in
[`SHADOW_CORPUS_PROTOCOL.md`](./SHADOW_CORPUS_PROTOCOL.md). These optional
tools prepare research evidence; they do not enable, disable, or apply the
product setting.

## Fixed supply-chain inputs

- Model: `LiquidAI/LFM2.5-Encoder-230M`
- Revision: `0b649ad0c684378b03d4d8304f7577a662ab89bc`
- Transformers: `5.5.0`, excluding the known pre-5.5 remote-code-execution ranges
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
speed budgets, masked pooling, batch-order equivalence, hash-only shadow label
pooling, work-level holdout isolation, and holdout drift detection.

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
