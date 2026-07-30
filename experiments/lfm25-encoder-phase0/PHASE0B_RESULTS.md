# Phase 0b Gate 1 quantized reranker evidence

## Decision

All three official AVX2 quantized ONNX rerankers pass the Semantic Recall
C0.5 speed gate on the initial Ryzen 5 3600 host:

- Japanese quality candidate: `japanese-reranker-xsmall-v2` — Target
- Japanese speed baseline: `japanese-reranker-tiny-v2` — Target
- English candidate: `ms-marco-MiniLM-L4-v2` — Target

This result authorizes Gate 2 retrieval-quality evaluation for all three
models. It does not select a production model, authorize a cascade, or provide
Impact Review classifier evidence. Impact labels and fine-tuning remain gated
behind a separate 512-token-window classifier speed test.

## Fixed inputs

- Source-controlled Phase 0b runner commit:
  `4a0da5203d54f9bd4e532301e7cd62a75eb4acd3`
- Runner: `grimodex-lfm-eval` 0.2.0,
  `python -m grimodex_lfm_eval.reranker_benchmark`
- Performance report schema version: 1
- `uv.lock` SHA-256:
  `89d58201e3c583672c9189ed176eea5d8e9447aec0a016cd059afefba92984d3`
- Runtime: Python 3.14.6, ONNX Runtime 1.24.2, tokenizers 0.22.2
- CPU: AMD Ryzen 5 3600, 6 physical / 12 logical cores, AVX2
- OS: Linux 7.1.4-arch1-1, CPU governor `schedutil`
- `OMP_NUM_THREADS`, `MKL_NUM_THREADS`, and `OPENBLAS_NUM_THREADS`: unset
- ONNX inter-op threads: 1
- ONNX memory pattern: disabled
- ONNX CPU memory arena: disabled

The timed runtime loads `tokenizer.json` directly through `tokenizers` and
executes ONNX Runtime's CPU provider. PyTorch and Transformers remain installed
for the original LFM harness but are not loaded by the Phase 0b warm or cold
scoring path.

### Gate 2 parity correction

The later official-reference parity check found that this historical Gate 1
Japanese path let `tokenizers` use its default padding identity (`id=0`)
instead of the model configuration's `<pad>` identity (`id=3`). The artifact,
sequence shapes, attention masks, revisions, and Gate 1 timing decision were
not changed, but the historical Japanese logits are not correctness evidence.

The direct tokenizer now reads `pad_token_id` and `pad_token` from the pinned
model files. With that correction, both Japanese models pass exact
tokenization parity and remain in the Target band on the formal Gate 2
real-corpus workloads. The large Gate 1 speed margin and the corrected Gate 2
measurements make a repeat of the synthetic Gate 1 timing sweep unnecessary
for the current decision.

| Key            | Revision                                   | Artifact SHA-256                                                   | Manifest SHA-256                                                   |
| -------------- | ------------------------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `ja_tiny`      | `ba95175a4d53058816b971f31929f10c5cad8560` | `649a18583e21ad532e420a4ded4c9c4ff7ce882aa84af2bf2180ec4d4f679e38` | `97697d446bb39392e15d17a5c7d6900783dd1ccbfa804219febd2454b5857cae` |
| `ja_xsmall`    | `de99fd2f16c7b5df1df1bcc1d9ad2c16d88ce93a` | `34d4657df53c875f970dbf87e584a21d59e6cfcd9368f9828d69a09ed152168f` | `8d4ad4f8d50496941fd5e6b4960df3dccdfc8aa1811c7cff68a5f470f9e1c24f` |
| `en_minilm_l4` | `777b2f369bc1c2f850df8bd367ed1654bda4497b` | `74118ad9ab2b17990c40f03085a91f131339bb3a6d629e96507a6dbf063dae3d` | `e6b043a0b69a61c3b9b54c59ea512149bfa5fbd15ce2778877c283ef4aae9813` |

Every load verified the selected snapshot manifest and the upstream ONNX
digest before session creation. Only the configured quantized ONNX and
tokenizer/configuration files were downloaded; no PyTorch or safetensors
weights were fetched.

## Input design

The benchmark measures end-to-end tokenization, ONNX inference, and score
extraction. It uses deterministic Japanese or English query/passage pairs with
four passage-length tiers. Combined pairs are truncated at 512 tokens and
length-bucketed before batches of four.

| Language | Candidates | Attention tokens | Padded tokens | Padding |
| -------- | ---------: | ---------------: | ------------: | ------: |
| Japanese |         12 |            3,950 |         4,680 |   15.6% |
| Japanese |         30 |            9,642 |        10,012 |    3.7% |
| English  |         12 |            4,119 |         4,872 |   15.5% |
| English  |         30 |           10,053 |        10,332 |    2.7% |

These are synthetic performance inputs, not retrieval-quality fixtures.
Gate 2 must use Grimodex's locked Japanese and English retrieval cases.

## Reproduction commands

Run from `experiments/lfm25-encoder-phase0` with the locked CPU environment.

### Selective bootstrap

```bash
.venv/bin/python tools/bootstrap_rerankers.py \
  --config configs/phase0b-rerankers.yaml
```

### Configuration pilots

The following command was run once for each model key:

```bash
HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 \
  .venv/bin/python -m grimodex_lfm_eval.reranker_benchmark \
  --config configs/phase0b-rerankers.yaml \
  --model <ja_tiny|ja_xsmall|en_minilm_l4> \
  --mode pilot \
  --batch-sizes 4,8,16 \
  --thread-counts 4,physical,8 \
  --bucket-modes naive,bucketed \
  --pilot-repetitions 1 \
  --skip-cold \
  --output artifacts/phase0b/pilot-<model>.json
```

The one-sample pilots selected:

| Model        | Batch | Threads | Ordering | 12 candidates | 30 candidates |
| ------------ | ----: | ------: | -------- | ------------: | ------------: |
| JA tiny      |     4 |       6 | bucketed |        0.189s |        0.401s |
| JA xsmall    |     4 |       4 | bucketed |        0.653s |        1.375s |
| EN MiniLM-L4 |     4 |       4 | bucketed |        0.554s |        1.078s |

### Formal runs

```bash
HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 \
  .venv/bin/python -m grimodex_lfm_eval.reranker_benchmark \
  --config configs/phase0b-rerankers.yaml \
  --model ja_tiny \
  --mode early-gate \
  --batch-sizes 4 \
  --thread-counts 6 \
  --bucket-modes bucketed \
  --output artifacts/phase0b/final-ja-tiny.json

HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 \
  .venv/bin/python -m grimodex_lfm_eval.reranker_benchmark \
  --config configs/phase0b-rerankers.yaml \
  --model ja_xsmall \
  --mode early-gate \
  --batch-sizes 4 \
  --thread-counts 4 \
  --bucket-modes bucketed \
  --output artifacts/phase0b/final-ja-xsmall.json

HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 \
  .venv/bin/python -m grimodex_lfm_eval.reranker_benchmark \
  --config configs/phase0b-rerankers.yaml \
  --model en_minilm_l4 \
  --mode early-gate \
  --batch-sizes 4 \
  --thread-counts 4 \
  --bucket-modes bucketed \
  --output artifacts/phase0b/final-en-minilm-l4.json
```

Each warm workload used three excluded warmups followed by 30 measured
samples. Cold start used five independent processes, each covering process
spawn, manifest verification, tokenizer and ONNX load, and the first scored
pair.

| Model        | Formal run ID                   | Local artifact                              |
| ------------ | ------------------------------- | ------------------------------------------- |
| JA tiny      | `20260729T214625Z-ja_tiny`      | `artifacts/phase0b/final-ja-tiny.json`      |
| JA xsmall    | `20260729T214758Z-ja_xsmall`    | `artifacts/phase0b/final-ja-xsmall.json`    |
| EN MiniLM-L4 | `20260729T214910Z-en_minilm_l4` | `artifacts/phase0b/final-en-minilm-l4.json` |

## Formal Semantic Recall results

| Model        | Candidates | Samples |    p50 |    p95 | Bootstrap p95 95% CI | Target | Hard stop | Verdict |
| ------------ | ---------: | ------: | -----: | -----: | -------------------: | -----: | --------: | ------- |
| JA tiny      |         12 |      30 | 0.229s | 0.262s |         0.254–0.282s |     1s |        4s | Target  |
| JA tiny      |         30 |      30 | 0.431s | 0.479s |         0.464–0.485s |     2s |        8s | Target  |
| JA xsmall    |         12 |      30 | 0.722s | 0.813s |         0.760–0.855s |     1s |        4s | Target  |
| JA xsmall    |         30 |      30 | 1.453s | 1.598s |         1.540–1.905s |     2s |        8s | Target  |
| EN MiniLM-L4 |         12 |      30 | 0.518s | 0.567s |         0.536–0.572s |     1s |        4s | Target  |
| EN MiniLM-L4 |         30 |      30 | 1.008s | 1.156s |         1.044–1.172s |     2s |        8s | Target  |

The Japanese xsmall model is the closest to a Target boundary, but its
bootstrap p95 upper bounds remain below both Target limits: 0.855 seconds for
12 candidates and 1.905 seconds for 30.

Compared with the rejected Japanese LFM baseline, tiny is 51.7 times faster
at 12 candidates and 62.4 times faster at 30. Xsmall is 16.7 and 18.7 times
faster, respectively. The English model is not assigned a direct LFM speedup
because its input language differs. These are end-to-end path comparisons,
including the Phase 0b 512-token pair cap versus LFM's 1,024-token input
design; they are not isolated model-forward speedups.

## Cold start

| Model        | Samples |    p50 |    p95 | Bootstrap p95 95% CI | Target | Verdict |
| ------------ | ------: | -----: | -----: | -------------------: | -----: | ------- |
| JA tiny      |       5 | 0.670s | 0.702s |         0.670–0.706s |     5s | Target  |
| JA xsmall    |       5 | 0.932s | 1.070s |         0.929–1.104s |     5s | Target  |
| EN MiniLM-L4 |       5 | 0.369s | 0.379s |         0.369–0.380s |     5s | Target  |

## Memory evidence

Memory is process RSS growth relative to the pre-model runtime baseline. It
is diagnostic evidence, not absolute system RSS or a promoted acceptance
gate.

| Model        | Candidates | Incremental idle RSS | Incremental peak RSS |
| ------------ | ---------: | -------------------: | -------------------: |
| JA tiny      |         12 |            171.6 MiB |            218.9 MiB |
| JA tiny      |         30 |            171.6 MiB |            218.9 MiB |
| JA xsmall    |         12 |            183.5 MiB |            227.8 MiB |
| JA xsmall    |         30 |            183.5 MiB |            228.0 MiB |
| EN MiniLM-L4 |         12 |             60.0 MiB |             83.0 MiB |
| EN MiniLM-L4 |         30 |             60.0 MiB |            104.7 MiB |

## Gate 1 conclusion

Gate 1 does not require a tiny-to-xsmall cascade: direct xsmall scoring of all
30 Japanese candidates already meets the 2-second Target. Gate 2 should
therefore compare direct tiny and direct xsmall against the current dense and
hybrid baselines. A cascade should be considered only if quality evidence
shows that it preserves Recall while offering a material product-level
benefit.

The authorized retrieval-quality step was completed in
[`PHASE0B_GATE2_RESULTS.md`](./PHASE0B_GATE2_RESULTS.md):

1. Japanese: dense, hybrid, hybrid + tiny, and hybrid + xsmall.
2. English: dense, hybrid, and hybrid + MiniLM-L4.
3. Report Recall@1, Recall@3, MRR, NDCG@3, junk false inclusion, and the named
   hard-negative slices.
4. Apply the existing promotion rule: MRR +0.05 or Recall@1 +5 points, with
   Recall@3 regression no worse than 1 point.

Impact Review remains unchanged by this result. Off-the-shelf relevance scores
must not remove Impact candidates.
