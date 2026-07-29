# Phase 0b Gate 2 fixed-candidate reranker evidence

## Decision

Gate 2 promotes two direct top-30 configurations to a later product shadow
integration:

- Japanese: `hotchpotch/japanese-reranker-xsmall-v2`, top 30.
- English: `cross-encoder/ms-marco-MiniLM-L4-v2`, top 30.

Japanese `japanese-reranker-tiny-v2` also clears the numerical quality and
latency gates, but remains the speed baseline rather than the selected
Japanese configuration. Its paired interval includes a possible MRR/Recall@1
regression and one query worsened, while xsmall reached perfect scene ranking
on this fixture with no worsened query.

Japanese xsmall top 12 is not promoted. It is faster, but loses one final gold
scene inclusion and increases non-gold injection. Scoring all 30 candidates
rescues `ja-r02` from below rank 12 and still stays in the Target latency band.

This is permission for a shadow integration and broader real-workspace
validation, not permission to ship a default reranker. Impact Review was not
evaluated and remains a separate track. No cascade is selected.

## Fixed implementation and environment

- Gate 2 implementation commit:
  `a80ff6cee575f2be362b037fab02c6b00b865f88`
- Runner: `grimodex-lfm-eval` 0.2.0,
  `python -m grimodex_lfm_eval.reranker_gate2_runner`
- Report schema version: 1
- `uv.lock` SHA-256:
  `89d58201e3c583672c9189ed176eea5d8e9447aec0a016cd059afefba92984d3`
- Runtime: Python 3.14.6, ONNX Runtime 1.24.2, tokenizers 0.22.2
- Host: AMD Ryzen 5 3600, 6 physical / 12 logical cores, AVX2
- Batch size: 4, length-bucketed
- Threads: tiny 6, xsmall 4, MiniLM-L4 4
- Pair truncation: `longest_first`, maximum 512 tokens
- Warm latency: three excluded warmups, then 30 measured queries

The cross-encoder logit is used only to order a frozen candidate set. Final
injection still applies the existing dense gate/floor and sparse-rescue
policy. Cross-encoder logits are never compared with cosine/BGE thresholds.

## Frozen product candidate sets

The candidate generator calls the Electron N-API backend used by the product.
It seeds the public medium workspaces, runs the current production chunker and
quantized embedder, obtains dense top 30 plus FTS5 top 10, computes the current
RRF ordering once, and writes that single pool to JSONL. Retrieval is never
rerun per reranker.

| Language | Queries | Positive | No-match | Indexed scenes/chunks | Candidate SHA-256 |
| -------- | ------: | -------: | -------: | --------------------: | ---------------- |
| Japanese |      18 |       12 |        6 |                42/271 | `cd1dbf5fbf18c9d28a5f924f0771bcb169c635279300670eb39c2bc053bd0234` |
| English  |      28 |       22 |        6 |                40/350 | `8802c90dd4ff0d20af99000eeee966ddbc32e8fd6ed73d631877ac5cbadfcb79` |

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

## Official-reference parity

The official FP32 ONNX is pinned separately from each quantized product
candidate. Twelve explicit positive/negative pairs per language verify token
IDs, attention and special-token masks, exact 512-token truncation, score
direction, and ranking. MiniLM additionally requires matching
`token_type_ids`.

| Model | Quantized manifest | FP32 reference manifest | Pairwise ranking agreement | Tokenization | Direction | Verdict |
| ----- | ------------------ | ----------------------- | -------------------------: | ------------ | --------- | ------- |
| JA tiny | `97697d446bb39392e15d17a5c7d6900783dd1ccbfa804219febd2454b5857cae` | `e3aeeadf04a42ffc72084e6cdcba429446b4e07a7fc0a5618eddef37fe9eef88` | 98.48% | Exact | Pass | Pass |
| JA xsmall | `8d4ad4f8d50496941fd5e6b4960df3dccdfc8aa1811c7cff68a5f470f9e1c24f` | `83a78dae5746ba57511617df66bc9c468a516f146e2f0cabe463f5aa422f6d68` | 98.48% | Exact | Pass | Pass |
| EN MiniLM-L4 | `e6b043a0b69a61c3b9b54c59ea512149bfa5fbd15ce2778877c283ef4aae9813` | `39bbee8a9291891087099ea815ab326423f8cce96cba3c7e808b5ac0ece5e4fe` | 100.00% | Exact, including token types | Pass | Pass |

Parity found and corrected a Gate 1-only tokenizer defect: the Japanese direct
path had used default padding ID 0 instead of the official `<pad>` ID 3. Gate 2
quality and real-corpus latency were measured only after the correction.

## Top-30 aggregate quality

Scene Recall is query-level binary recall: a query succeeds when any labelled
relevant scene appears within the cutoff. Injection allows at most three
chunks and prioritizes distinct scenes before backfill.

| Language / method | Chunk MRR | Chunk NDCG@3 | Scene MRR | Recall@1 | Recall@3 | Gold injection | Non-gold injection | No-match injection |
| ----------------- | --------: | ------------: | --------: | -------: | -------: | -------------: | -----------------: | -----------------: |
| JA dense | 0.828 | 0.776 | 0.829 | 75.0% | 91.7% | 83.3% | 63.3% | 0.0% |
| JA hybrid RRF | 0.829 | 0.776 | 0.829 | 75.0% | 91.7% | 83.3% | 63.3% | 0.0% |
| JA hybrid + tiny | 0.958 | 0.885 | 0.958 | 91.7% | 100.0% | 83.3% | 63.3% | 0.0% |
| JA hybrid + xsmall | 1.000 | 0.916 | 1.000 | 100.0% | 100.0% | 83.3% | 63.3% | 0.0% |
| EN dense | 0.595 | 0.609 | 0.606 | 45.5% | 77.3% | 77.3% | 74.3% | 50.0% |
| EN hybrid RRF | 0.716 | 0.665 | 0.716 | 63.6% | 72.7% | 72.7% | 76.9% | 66.7% |
| EN hybrid + MiniLM-L4 | 0.783 | 0.751 | 0.795 | 77.3% | 77.3% | 77.3% | 75.6% | 66.7% |

The public qrels name expected scenes but do not exhaustively label every
related scene. For that reason, `Non-gold injection` is the precise
interpretation of the report field named `junk_injection_rate`; it can
overstate truly irrelevant injection.

## Promotion rule and paired evidence

The planned ranking rule is:

- scene MRR improves by at least 0.05, or Recall@1 improves by at least 5
  percentage points;
- Recall@3 may not regress by more than 1 point.

Gate 2 additionally requires final gold inclusion not to decrease, non-gold
injection not to increase, and no-match injection not to increase.

| Configuration | Δ scene MRR, paired 95% CI | Δ Recall@1, paired 95% CI | Δ Recall@3, paired 95% CI | Improved / worsened / unchanged | Final safety | Gate |
| ------------- | -------------------------: | -----------------------------: | -----------------------------: | ------------------------------: | ------------ | ---- |
| JA tiny top 30 | +0.130 `[-0.083, 0.333]` | +16.7pt `[-8.3, 50.0]` | +8.3pt `[0.0, 25.0]` | 3 / 1 / 8 | Pass | Promote as speed baseline |
| JA xsmall top 30 | +0.171 `[0.000, 0.361]` | +25.0pt `[8.3, 50.0]` | +8.3pt `[0.0, 25.0]` | 3 / 0 / 9 | Pass | Promote, selected JA |
| EN MiniLM-L4 top 30 | +0.080 `[0.000, 0.170]` | +13.6pt `[0.0, 27.3]` | +4.5pt `[0.0, 13.6]` | 3 / 0 / 19 | Pass | Promote, selected EN |

Tiny's worst regression is `ja-r06`, whose scene reciprocal rank changes by
-0.5. Xsmall and MiniLM-L4 have no worsened positive query in top 30. No
configuration introduces a no-match regression relative to its hybrid
baseline.

Only xsmall's Recall@1 paired lower bound is strictly positive. The other
intervals touch or cross zero because these public positive sets are small;
that uncertainty is why the decision stops at shadow integration.

## Named slices and hard negatives

- JA hybrid's three Recall@1 misses have MRR 0.315. Tiny and xsmall raise that
  slice to 1.000, improving three at rank 1 and worsening none at rank 1.
- EN hybrid's eight Recall@1 misses have MRR 0.219. MiniLM-L4 raises that slice
  to 0.438, improving three at rank 1 and worsening none.
- EN semantic queries: MRR +0.096, Recall@1 +15.4pt, Recall@3 +7.7pt.
- EN morphology queries: MRR +0.100, Recall@1 +20.0pt, Recall@3 unchanged.
- EN lexical proper-noun queries: no aggregate change.

## Xsmall top 12 versus top 30

| Depth | Scene MRR | Recall@1 | Recall@3 | Gold injection | Non-gold injection | Product safety |
| ----- | --------: | -------: | -------: | -------------: | -----------------: | -------------- |
| Hybrid baseline | 0.829 | 75.0% | 91.7% | 83.3% | 63.3% | — |
| Xsmall top 12 | 0.933 | 91.7% | 91.7% | 75.0% | 66.7% | Fail |
| Xsmall top 30 | 1.000 | 100.0% | 100.0% | 83.3% | 63.3% | Pass |

Top 30 adds 324 candidate-query pairs, 321 of which are non-gold under the
sparse qrels. One labelled relevant candidate below rank 12 rescues `ja-r02`.
The top-12 ranking rule alone would pass, but its final-injection regression
overrides that result.

## Real-corpus latency

Each measurement includes tokenization, quantized ONNX inference, and score
extraction over the frozen public chunk text. It does not include candidate
retrieval, because the cross-encoder is additive after the current retrieval
path.

| Model / depth | Samples | p50 | p95 | Bootstrap p95 95% CI | Target | Hard stop | Verdict |
| ------------- | ------: | --: | --: | --------------------: | -----: | --------: | ------- |
| JA tiny / 30 | 30 | 0.246s | 0.303s | 0.276–0.350s | 2s | 8s | Target |
| JA xsmall / 12 | 30 | 0.384s | 0.587s | 0.518–1.156s | 1s | 4s | Target |
| JA xsmall / 30 | 30 | 0.857s | 1.139s | 1.031–1.338s | 2s | 8s | Target |
| EN MiniLM-L4 / 30 | 30 | 0.514s | 0.759s | 0.550–0.900s | 2s | 8s | Target |

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
  --model ja_tiny \
  --threads 6 \
  --batch-size 4 \
  --output artifacts/phase0b/gate2/final-ja-tiny.json

HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 \
  .venv/bin/python -m grimodex_lfm_eval.reranker_gate2_runner \
  --config configs/phase0b-rerankers.yaml \
  --candidates data/public/gate2/candidates-ja.jsonl \
  --model ja_xsmall \
  --threads 4 \
  --batch-size 4 \
  --output artifacts/phase0b/gate2/final-ja-xsmall.json

HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 \
  .venv/bin/python -m grimodex_lfm_eval.reranker_gate2_runner \
  --config configs/phase0b-rerankers.yaml \
  --candidates data/public/gate2/candidates-en.jsonl \
  --model en_minilm_l4 \
  --threads 4 \
  --batch-size 4 \
  --output artifacts/phase0b/gate2/final-en-minilm-l4.json
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

## Scope boundary and next step

The measured conclusion is:

> current Grimodex dense+FTS candidate generation + frozen top 30 + selected
> language-specific quantized cross-encoder, on the public medium fixtures and
> Ryzen 5 3600 host

It does not prove user-corpus generalization, absolute no-match quality,
memory behavior under Electron contention, or product UX latency after IPC.
The next justified step is a separate shadow integration that:

1. keeps the current candidate admission gate unchanged;
2. runs xsmall top 30 for Japanese and MiniLM-L4 top 30 for English;
3. records current versus reranked scene order without changing injection;
4. validates real private workspaces locally without committing their text;
5. stops if Recall@3, gold inclusion, no-match behavior, or UI latency
   regresses.

Impact Review remains `not-evaluated`. Off-the-shelf relevance logits must not
remove Impact candidates.
