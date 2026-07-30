# Phase 0b Gate 2 fixed-candidate reranker evidence

## Decision

Gate 2 promotes two direct top-30 configurations to an experimental,
project-scoped opt-in product integration:

- Japanese: `hotchpotch/japanese-reranker-xsmall-v2`, top 30.
- English: `cross-encoder/ms-marco-MiniLM-L4-v2`, top 30.

Japanese `japanese-reranker-tiny-v2` also clears the numerical quality and
latency gates, but remains the speed baseline rather than the selected
Japanese configuration. Its paired interval includes a possible MRR/Recall@1
regression and one query worsened, while xsmall reached perfect scene ranking
on this fixture with no worsened query.

After adding exact-passage qrels and aligning final injection with the product
algorithm, Japanese xsmall top 12 also clears the numerical gate. Top 30
remains selected because it raises exact-passage inclusion from 75.0% to
83.3%, rescues the labelled `ja-r02` passage from below rank 12, and remains
in the Target latency band.

This is sufficient evidence for an experimental opt-in reranker, not for
default enablement or a claim of cross-work generalization. The product path
must preserve the fixed-fixture quality and latency results below, keep the
existing admission policy authoritative, and return the exact baseline order
on model absence, inference failure, timeout, or stale authority. Impact
Review was not evaluated and remains a separate track. No cascade is selected.

## Fixed implementation and environment

- Gate 2 original implementation commit:
  `a80ff6cee575f2be362b037fab02c6b00b865f88`
- Exact-passage qrels and product-aligned injection fix commit:
  `d225999c4b12f6cc5e027ac797c0f1ae384b695e`
- Runner: `grimodex-lfm-eval` 0.2.0,
  `python -m grimodex_lfm_eval.reranker_gate2_runner`
- Report schema version: 2
- `uv.lock` SHA-256:
  `89d58201e3c583672c9189ed176eea5d8e9447aec0a016cd059afefba92984d3`
- Runtime: Python 3.14.6, ONNX Runtime 1.24.2, tokenizers 0.22.2
- Host: AMD Ryzen 5 3600, 6 physical / 12 logical cores, AVX2
- Batch size: 4, length-bucketed
- Threads: tiny 6, xsmall 4, MiniLM-L4 4
- Pair truncation: `longest_first`, maximum 512 tokens
- Warm latency: three excluded warmups, then 30 measured queries

The cross-encoder logit is used only to order a frozen candidate set. Final
injection freezes the scenes and per-scene quotas selected by the existing
dense gate/floor and sparse-rescue policy. The reranker may choose a different
retrieved chunk only inside those admitted scene quotas. Cross-encoder logits
are never compared with cosine/BGE thresholds.

## Frozen product candidate sets

The candidate generator calls the Electron N-API backend used by the product.
It seeds the public medium workspaces, runs the current production chunker and
quantized embedder, obtains dense top 30 plus FTS5 top 10, computes the current
RRF ordering once, and writes that single pool to JSONL. Retrieval is never
rerun per reranker.

| Language | Queries | Positive | No-match | Indexed scenes/chunks | Candidate SHA-256                                                  |
| -------- | ------: | -------: | -------: | --------------------: | ------------------------------------------------------------------ |
| Japanese |      18 |       12 |        6 |                42/271 | `cd1dbf5fbf18c9d28a5f924f0771bcb169c635279300670eb39c2bc053bd0234` |
| English  |      28 |       22 |        6 |                40/350 | `8802c90dd4ff0d20af99000eeee966ddbc32e8fd6ed73d631877ac5cbadfcb79` |

Exact-passage labels are stored separately in
`data/public/gate2/chunk-qrels.json` (SHA-256
`f1daa108130041781e80235a3b74ef915616484a38396b758524be108f17cef3`).
Each positive annotation names the specific frozen chunk range that answers
the query; labels are not expanded to every chunk sharing the expected scene
title. Empty positive qrels are allowed only for the three English
candidate-generation misses.

The Japanese pool uses
`cl-nagoya/ruri-v3-30m@local/model_int8.onnx/prefix-v1` and the Japanese
semantic prose chunker v1. The English pool uses
`BAAI/bge-small-en-v1.5@local/model_int8.onnx/en-v1` and the English semantic
prose chunker v1.

Candidate generation was repeated from independently seeded workspaces whose
random database UUIDs differed. Both committed JSONL files were byte-identical
on the second run. Stable scene and chunk IDs are derived from public fixture
content. Full source hashes are in
`data/public/gate2/provenance.json`.

All 12 Japanese positive queries have a labelled relevant scene somewhere in
top 30. English coverage is 19 of 22; the remaining three are candidate
generation misses that no reranker can recover.

The English failures are separated by layer:

- Candidate generation misses: `en-r15`, `en-r16`, and `en-r18`. All three
  expect `Chapter Three: Ironhaven by Night`, but no candidate from that scene
  is present in the frozen top 30.
- Candidate-present ranking misses: `en-r14` has relevant candidate
  `en-chunk-e4d704add3be18dca4bf` at reranker rank 18, and `en-r22` has
  `en-chunk-4e4e786ddc7dae997cda` at reranker rank 6. Their labelled scenes
  are present, but remain outside the top three.

## Official-reference parity

The official FP32 ONNX is pinned separately from each quantized product
candidate. Twelve explicit positive/negative pairs per language verify token
IDs, attention and special-token masks, exact 512-token truncation, score
direction, and ranking. MiniLM additionally requires matching
`token_type_ids`.

| Model        | Quantized manifest                                                 | FP32 reference manifest                                            | Pairwise ranking agreement | Tokenization                 | Direction | Verdict |
| ------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------ | -------------------------: | ---------------------------- | --------- | ------- |
| JA tiny      | `97697d446bb39392e15d17a5c7d6900783dd1ccbfa804219febd2454b5857cae` | `e3aeeadf04a42ffc72084e6cdcba429446b4e07a7fc0a5618eddef37fe9eef88` |                     98.48% | Exact                        | Pass      | Pass    |
| JA xsmall    | `8d4ad4f8d50496941fd5e6b4960df3dccdfc8aa1811c7cff68a5f470f9e1c24f` | `83a78dae5746ba57511617df66bc9c468a516f146e2f0cabe463f5aa422f6d68` |                     98.48% | Exact                        | Pass      | Pass    |
| EN MiniLM-L4 | `e6b043a0b69a61c3b9b54c59ea512149bfa5fbd15ce2778877c283ef4aae9813` | `39bbee8a9291891087099ea815ab326423f8cce96cba3c7e808b5ac0ece5e4fe` |                    100.00% | Exact, including token types | Pass      | Pass    |

Parity found and corrected a Gate 1-only tokenizer defect: the Japanese direct
path had used default padding ID 0 instead of the official `<pad>` ID 3. Gate 2
quality and real-corpus latency were measured only after the correction.

Each Japanese model has one pairwise reversal among the 66 pair comparisons:

- Xsmall reverses `ja-parity-01-positive` versus
  `ja-parity-06-positive`. The FP32 margin is `+0.228588` for pair 01
  (`2.222359 - 1.993771`), while the quantized margin is `-0.022672`
  (`1.998313 - 2.020985`).
- Tiny reverses `ja-parity-02-positive` versus
  `ja-parity-05-positive`. The FP32 margin is `-0.038310` for pair 02
  (`3.919810 - 3.958120`), while the quantized margin is `+0.133834`
  (`4.590140 - 4.456307`).

These close-score reversals are retained as quantization diagnostics. Gate 2
quality was measured on the quantized artifacts themselves, so they do not
invalidate the promotion decision.

## Top-30 aggregate quality

Scene Recall remains query-level binary recall. Chunk MRR/NDCG and exact
injection now use the reviewed candidate-range qrels. Injection freezes the
baseline scene multiset and quota before applying reranker chunk order.

| Language / method     | Chunk MRR | Chunk NDCG@3 | Scene MRR | Recall@1 | Recall@3 | Gold scene injection | Gold chunk injection | Non-gold chunk injection | No-match injection |
| --------------------- | --------: | -----------: | --------: | -------: | -------: | -------------------: | -------------------: | -----------------------: | -----------------: |
| JA dense              |     0.817 |        0.803 |     0.829 |    75.0% |    91.7% |                83.3% |                75.0% |                    66.7% |               0.0% |
| JA hybrid RRF         |     0.806 |        0.803 |     0.829 |    75.0% |    91.7% |                83.3% |                75.0% |                    66.7% |               0.0% |
| JA hybrid + tiny      |     0.958 |        0.969 |     0.958 |    91.7% |   100.0% |                83.3% |                83.3% |                    63.3% |               0.0% |
| JA hybrid + xsmall    |     1.000 |        1.000 |     1.000 |   100.0% |   100.0% |                83.3% |                83.3% |                    63.3% |               0.0% |
| EN dense              |     0.595 |        0.637 |     0.606 |    45.5% |    77.3% |                77.3% |                77.3% |                    74.3% |              50.0% |
| EN hybrid RRF         |     0.716 |        0.694 |     0.716 |    63.6% |    72.7% |                72.7% |                72.7% |                    76.9% |              66.7% |
| EN hybrid + MiniLM-L4 |     0.783 |        0.773 |     0.795 |    77.3% |    77.3% |                72.7% |                72.7% |                    76.9% |              66.7% |

`Non-gold chunk injection` means the injected range is not one of the explicit
exact-passage qrels. It is a conservative label and may still overstate truly
irrelevant injection. The separate scene columns retain the broader
scene-title judgement.

## Promotion rule and paired evidence

The planned ranking rule is:

- scene MRR improves by at least 0.05, or Recall@1 improves by at least 5
  percentage points;
- Recall@3 may not regress by more than 1 point.

Gate 2 additionally requires final gold-scene and exact-gold-chunk inclusion
not to decrease, non-gold chunk injection not to increase, and no-match
injection not to increase.

| Configuration       | Δ scene MRR, paired 95% CI | Δ Recall@1, paired 95% CI | Δ Recall@3, paired 95% CI | Improved / worsened / unchanged | Final safety | Gate                      |
| ------------------- | -------------------------: | ------------------------: | ------------------------: | ------------------------------: | ------------ | ------------------------- |
| JA tiny top 30      |   +0.130 `[-0.083, 0.333]` |    +16.7pt `[-8.3, 50.0]` |      +8.3pt `[0.0, 25.0]` |                       3 / 1 / 8 | Pass         | Promote as speed baseline |
| JA xsmall top 30    |    +0.171 `[0.000, 0.361]` |     +25.0pt `[8.3, 50.0]` |      +8.3pt `[0.0, 25.0]` |                       3 / 0 / 9 | Pass         | Promote, selected JA      |
| EN MiniLM-L4 top 30 |    +0.080 `[0.000, 0.170]` |     +13.6pt `[0.0, 27.3]` |      +4.5pt `[0.0, 13.6]` |                      3 / 0 / 19 | Pass         | Promote, selected EN      |

Tiny's worst regression is `ja-r06`, whose scene reciprocal rank changes by
-0.5. Xsmall and MiniLM-L4 have no worsened positive query in top 30. No
configuration introduces a no-match regression relative to its hybrid
baseline.

Only xsmall's Recall@1 paired lower bound is strictly positive. The other
intervals touch or cross zero because these public positive sets are small.
English is therefore described only as improving the order of candidates
already found by production retrieval; it does not claim to repair
candidate-generation misses or no-match admission.

## Named slices and hard negatives

- JA hybrid's three Recall@1 misses have MRR 0.315. Tiny and xsmall raise that
  slice to 1.000, improving three at rank 1 and worsening none at rank 1.
- EN hybrid's eight Recall@1 misses have MRR 0.219. MiniLM-L4 raises that slice
  to 0.438, improving three at rank 1 and worsening none.
- EN semantic queries: MRR +0.096, Recall@1 +15.4pt, Recall@3 +7.7pt.
- EN morphology queries: MRR +0.100, Recall@1 +20.0pt, Recall@3 unchanged.
- EN lexical proper-noun queries: no aggregate change.

## Xsmall top 12 versus top 30

| Depth           | Scene MRR | Recall@1 | Recall@3 | Gold scene injection | Gold chunk injection | Non-gold chunk injection | Product safety |
| --------------- | --------: | -------: | -------: | -------------------: | -------------------: | -----------------------: | -------------- |
| Hybrid baseline |     0.829 |    75.0% |    91.7% |                83.3% |                75.0% |                    66.7% | —              |
| Xsmall top 12   |     0.933 |    91.7% |    91.7% |                83.3% |                75.0% |                    66.7% | Pass           |
| Xsmall top 30   |     1.000 |   100.0% |   100.0% |                83.3% |                83.3% |                    63.3% | Pass           |

Top 30 adds 324 candidate-query pairs. One exact-passage qrel below rank 12
lets `ja-r02` replace the dense-selected chunk inside an already-admitted
scene. It therefore provides a product-visible exact-passage improvement
without changing scene admission.

## Real-corpus latency

Each measurement includes tokenization, quantized ONNX inference, and score
extraction over the frozen public chunk text. It does not include candidate
retrieval, because the cross-encoder is additive after the current retrieval
path.

| Model / depth     | Samples |    p50 |    p95 | Bootstrap p95 95% CI | Target | Hard stop | Verdict |
| ----------------- | ------: | -----: | -----: | -------------------: | -----: | --------: | ------- |
| JA tiny / 30      |      30 | 0.279s | 0.378s |         0.346–0.427s |     2s |        8s | Target  |
| JA xsmall / 12    |      30 | 0.292s | 0.361s |         0.352–0.368s |     1s |        4s | Target  |
| JA xsmall / 30    |      30 | 0.854s | 1.002s |         0.937–1.013s |     2s |        8s | Target  |
| EN MiniLM-L4 / 30 |      30 | 0.454s | 0.559s |         0.514–0.578s |     2s |        8s | Target  |

### Chunk-corrected apply revalidation — 2026-07-31

The selected configurations were rerun from the pinned local manifests after
aligning the evaluator and product with admitted-scene/exact-chunk semantics.
Both 30-candidate latency gates remained Target:

| Model / depth     | Manifest                                                           | Chunk MRR | Scene MRR | Gold chunk | Worsened positive |    p95 | Bootstrap p95 95% CI | Verdict |
| ----------------- | ------------------------------------------------------------------ | --------: | --------: | ---------: | ----------------: | -----: | -------------------: | ------- |
| JA xsmall / 30    | `8d4ad4f8d50496941fd5e6b4960df3dccdfc8aa1811c7cff68a5f470f9e1c24f` |     1.000 |     1.000 |      83.3% |                 0 | 1.002s |         0.937–1.013s | Promote |
| EN MiniLM-L4 / 30 | `e6b043a0b69a61c3b9b54c59ea512149bfa5fbd15ce2778877c283ef4aae9813` |     0.783 |     0.795 |      72.7% |                 0 | 0.559s |         0.514–0.578s | Promote |

This revalidation covers fixed-fixture model quality and direct ONNX CPU
latency. Renderer timeout/fallback, admission invariance, and stale authority
are covered separately by deterministic product contract tests.

### Local LLM contention diagnostic — 2026-07-31

A reproducible diagnostic ran three one-token Ollama generations before and
during the JA xsmall Gate 2 load on the same host. The warmed
`gemma4-lowvram:latest` median rose from 1.171s to 1.564s
(+0.392s, 1.335x); the contended maximum was 1.748s. This small `n=3`
measurement is diagnostic only, but confirms that an uncancelled reranker can
slow a concurrent local LLM. The apply path therefore opens a per-session
circuit after a caller-wait timeout and exposes
`timedOutButStillRunning=true`; it does not claim that the current native run
was cancelled.

## Reproduction commands

Run bootstrap, parity, and formal scoring commands from
`experiments/lfm25-encoder-phase0` in the locked CPU environment. Candidate
regeneration and the TypeScript tool check run from the repository root.

### Quantized and official-reference bootstrap

```bash
.venv/bin/python tools/bootstrap_rerankers.py \
  --config configs/phase0b-rerankers.yaml

.venv/bin/python tools/bootstrap_reranker_references.py \
  --config configs/phase0b-rerankers.yaml
```

### Candidate regeneration

The committed candidate files are already frozen. To regenerate them through
the product backend, run from the repository root after installing the pinned
semantic model resources:

```bash
pnpm napi:build

gate2_tmp="$(mktemp -d)"
python3 scripts/seed-sample-ja.py "$gate2_tmp/ja" --scale medium
python3 scripts/seed-sample-en.py "$gate2_tmp/en" --scale medium

pnpm exec tsx \
  experiments/lfm25-encoder-phase0/tools/freeze_gate2_candidates.ts \
  --native-module electron/native/grimodex-node/grimodex-node.node \
  --resources src-tauri/resources/semantic \
  --ja-workspace "$gate2_tmp/ja" \
  --en-workspace "$gate2_tmp/en" \
  --output-dir experiments/lfm25-encoder-phase0/data/public/gate2
```

Regeneration must reproduce both committed candidate SHA-256 values before
formal scoring.

### Parity

```bash
HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 \
  .venv/bin/python -m grimodex_lfm_eval.reranker_parity \
  --config configs/phase0b-rerankers.yaml \
  --candidates data/public/gate2/candidates-ja.jsonl \
  --pairs data/public/gate2/parity-pairs-ja.jsonl \
  --model ja_tiny \
  --threads 6 \
  --output artifacts/phase0b/gate2/parity-ja-tiny.json

HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 \
  .venv/bin/python -m grimodex_lfm_eval.reranker_parity \
  --config configs/phase0b-rerankers.yaml \
  --candidates data/public/gate2/candidates-ja.jsonl \
  --pairs data/public/gate2/parity-pairs-ja.jsonl \
  --model ja_xsmall \
  --threads 4 \
  --output artifacts/phase0b/gate2/parity-ja-xsmall.json

HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 \
  .venv/bin/python -m grimodex_lfm_eval.reranker_parity \
  --config configs/phase0b-rerankers.yaml \
  --candidates data/public/gate2/candidates-en.jsonl \
  --pairs data/public/gate2/parity-pairs-en.jsonl \
  --model en_minilm_l4 \
  --threads 4 \
  --output artifacts/phase0b/gate2/parity-en-minilm-l4.json
```

### Formal quality and real-corpus latency

```bash
HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 \
  .venv/bin/python -m grimodex_lfm_eval.reranker_gate2_runner \
  --config configs/phase0b-rerankers.yaml \
  --candidates data/public/gate2/candidates-ja.jsonl \
  --chunk-qrels data/public/gate2/chunk-qrels.json \
  --model ja_tiny \
  --threads 6 \
  --batch-size 4 \
  --output artifacts/phase0b/gate2/final-ja-tiny.json

HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 \
  .venv/bin/python -m grimodex_lfm_eval.reranker_gate2_runner \
  --config configs/phase0b-rerankers.yaml \
  --candidates data/public/gate2/candidates-ja.jsonl \
  --chunk-qrels data/public/gate2/chunk-qrels.json \
  --model ja_xsmall \
  --threads 4 \
  --batch-size 4 \
  --output artifacts/phase0b/gate2/final-ja-xsmall.json

HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 \
  .venv/bin/python -m grimodex_lfm_eval.reranker_gate2_runner \
  --config configs/phase0b-rerankers.yaml \
  --candidates data/public/gate2/candidates-en.jsonl \
  --chunk-qrels data/public/gate2/chunk-qrels.json \
  --model en_minilm_l4 \
  --threads 4 \
  --batch-size 4 \
  --output artifacts/phase0b/gate2/final-en-minilm-l4.json
```

### Local LLM contention diagnostic

```bash
.venv/bin/python tools/local_llm_reranker_contention_probe.py \
  --endpoint http://127.0.0.1:11434 \
  --local-model gemma4-lowvram:latest \
  --config configs/phase0b-rerankers.yaml \
  --candidates data/public/gate2/candidates-ja.jsonl \
  --chunk-qrels data/public/gate2/chunk-qrels.json \
  --reranker-model ja_xsmall \
  --threads 4 \
  --batch-size 4 \
  --samples 3 \
  --output artifacts/phase0b/gate2/contention-gemma4-lowvram-ja-xsmall.json
```

### Contract verification

From `experiments/lfm25-encoder-phase0`:

```bash
.venv/bin/python -m pytest -q
.venv/bin/python tools/validate_dataset.py data/public
```

From the repository root:

```bash
pnpm exec tsc -p experiments/lfm25-encoder-phase0/tsconfig.tools.json --noEmit
```

The generated report JSON files stay ignored under
`artifacts/phase0b/gate2/`; this Markdown file is the committed decision
record.

## Product modes and optional development shadow

The project setting **Semantic reranking (experimental)** is off by default.
The runtime modes are:

```text
off    -> do not run the cross-encoder
shadow -> record counterfactual order only (developer diagnostic)
apply  -> apply the reranked order after existing admission
```

`apply` has a 2.5 second caller-wait timeout and returns the current order on
timeout, model/resource failure, inference error, native-lane contention,
reindexing, workspace change, or superseded query generation. A timeout does
not claim native cancellation: it emits `timedOutButStillRunning=true` and
opens a circuit that skips later reranks in the same session. It never admits
a new scene: dense gate, floor, sparse rescue, exclusions, and the three-chunk
cap determine the baseline scene quota before reranker chunk selection.

The setting and execution path use the same language, runtime, and resource
capability resolver. Chinese, Korean, and Web Editor cases stay `off` without
invoking native scoring. Packaged Electron releases advertise the fixed
resource capability; a missing or corrupted file discovered during scoring
still returns the exact baseline through the scorer-level fail-safe.

The promoted models can be observed in Electron development without changing
the current prompt:

```bash
pnpm napi:build
VITE_SEMANTIC_RERANKER_SHADOW=1 pnpm electron:dev
```

The default model root is
`experiments/lfm25-encoder-phase0/local/phase0b`. A different verified local
root may be supplied with the absolute-path-only
`GRIMODEX_RERANKER_RESOURCE_ROOT` environment variable. Release builds
bootstrap the two selected pinned snapshots and package them under the fixed
reranker resource root.

Only real `send` context builds enqueue the shadow job. The existing injected
chunks are returned immediately; a concurrency-one, latest-pending background
job writes comparison metadata to
`~/.grimodex/logs/semantic-reranker-shadow.jsonl`. The persisted record
contains hashed identifiers, ranks, scores, token/truncation counts, model
identity, memory, and latency, but no query, candidate, or manuscript text.
New records retain the exact dense rank as well as current hybrid and reranker
ranks so the three-method top-10 annotation union can be reconstructed without
storing text.
Counterfactual injection is logged and never applied in `shadow`. Semantic
Recall and its hybrid retrieval setting must both be enabled because Gate 2
promoted the frozen hybrid top-30 configuration.

## Corpus role

The committed Gate 2 corpus remains model-selection validation:

| Language | Positive | No-match | Independent works |
| -------- | -------: | -------: | ----------------: |
| Japanese |       12 |        6 |                 1 |
| English  |       22 |        6 |                 1 |

It is enough for model selection and experimental opt-in integration, but not
for claims about cross-work generalization, absolute no-match quality, or
default enablement. Work-level-separated `shadow-private-dev` and
`frozen-holdout` labels remain available for optional investigation. Their
sample floors and readiness fields are research diagnostics, not
product-enablement conditions.

The hash-only label schema, four-grade union-pooling contract, hard-case
slices, stage targets, commands, and aggregate report schema are recorded in
[`SHADOW_CORPUS_PROTOCOL.md`](./SHADOW_CORPUS_PROTOCOL.md). Private labels and
locks stay ignored under `data/private/`; generated reports disclose neither
source text nor hashed identifiers.

## Scope boundary and next step

The measured conclusion is:

> current Grimodex dense+FTS candidate generation + frozen top 30 + selected
> language-specific quantized cross-encoder, on the public medium fixtures and
> Ryzen 5 3600 host

It does not prove user-corpus generalization, absolute no-match quality, or
product UX latency after IPC. The small local-LLM overlap measurement is a
diagnostic, not a contention gate.
The implemented integration:

1. keeps the current candidate admission gate unchanged;
2. runs xsmall top 30 for Japanese and MiniLM-L4 top 30 for English;
3. preserves admitted scene quotas while applying reranker-selected chunks
   from those scenes when the explicit project toggle is enabled;
4. fails closed outside supported Electron JA/EN capability;
5. returns the exact baseline on timeout, failure, contention, reindexing, or
   stale workspace/query authority and opens a session circuit after timeout;
6. retains the text-free shadow log as an optional diagnostic; and
7. keeps default enablement outside this decision.

Impact Review remains `not-evaluated`. Off-the-shelf relevance logits must not
remove Impact candidates.
