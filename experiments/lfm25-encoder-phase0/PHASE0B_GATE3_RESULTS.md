# Phase 0b Gate 3 — Impact Review pre-training speed

Date: 2026-07-30

Host: AMD Ryzen 5 3600, 6 physical / 12 logical cores

Verdict: **Target for both candidates; proceed to Gate 4**

## Decision

Gate 3 measures only the preprocessing cost of a future Impact Review binary
classifier. It does not train or evaluate affected/unaffected quality. Both
candidates process the fixed 30-scene workload inside the five-second Target
band with the same untrained seed-42 binary head:

| Candidate | Selected configuration | End-to-end p50 | End-to-end p95 | Bootstrap 95% CI for p95 | Maximum | Target use | Verdict |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| `ja_xsmall` | batch 4, 8 threads, bucketed | 1.174 s | **1.371 s** | 1.239–1.643 s | 1.643 s | 27.4% | **Target** |
| `modernbert_ja_30m` | batch 2, 6 threads, bucketed | 1.230 s | **1.676 s** | 1.539–1.993 s | 1.993 s | 33.5% | **Target** |

The Gate 3 boundaries are:

| Band | 30-scene end-to-end p95 |
| --- | ---: |
| Target | <= 5 seconds |
| Conditional | <= 10 seconds |
| Hold | <= 20 seconds |
| Reject / hard stop | > 20 seconds |

The observed p95 values retain 14.58x and 11.94x headroom respectively
against the hard stop. The intended Gate 4 ordering remains:

1. `japanese-reranker-xsmall-v2` as the primary Impact initialization.
2. `modernbert-ja-30m` as the neutral backbone baseline.
3. No off-the-shelf score may remove an Impact candidate; affected/unaffected
   behavior remains unmeasured until the labeled probe.

## Fixed workload

The workload reuses one query's 30 public Japanese candidate scenes only as a
stable speed distribution. It does not reuse the Gate 2 relevance labels as
Impact labels.

| Input | Fixed value |
| --- | --- |
| Candidate source | `data/public/gate2/candidates-ja.jsonl` |
| Source SHA-256 | `cd1dbf5fbf18c9d28a5f924f0771bcb169c635279300670eb39c2bc053bd0234` |
| Source query | `ja-r01` |
| Canonical diff SHA-256 | `c5899c8f683283e3b16e4554bc26378f31f8759d520796401ec4f329d4c8b48e` |
| Candidate count | 30 |
| Diff budget | 128 tokens |
| Scene budget | 384 tokens |
| Pair cap | 512 tokens, `only_second` truncation |

Both tokenizers produced the same distribution for this workload:

| Distribution | Tokens |
| --- | ---: |
| Canonical diff | 89 |
| Scene minimum | 63 |
| Scene p50 | 259 |
| Scene p95 | 287 |
| Scene maximum | 291 |
| Scenes truncated at 384 | 0 |

The real public scenes are shorter than the cap. This result therefore covers
the selected 30-scene distribution, not a synthetic worst case of 30 fully
occupied 384-token windows. Gate 4 must retain the window/stride contract when
building longer-scene examples.

## Supply-chain identity

Benchmark runner commit:
`a9389b0b90b67665538c0db32ecdc3defb5900f4`

| Key | Model revision | Weight SHA-256 | Verified manifest SHA-256 |
| --- | --- | --- | --- |
| `ja_xsmall` | `de99fd2f16c7b5df1df1bcc1d9ad2c16d88ce93a` | `93a48c41e3deeb772a024057ed163f803dfe550052b9e2155cbe2b9631602961` | `a800f06b4742ac2f791ba15ccfbadc6a67e895d295f1b62787e3f3367fa0cf0d` |
| `modernbert_ja_30m` | `8cb03f54cb9e30e72459e5f1cedc6d89c7d8dcb5` | `de292c27183e6b158bafbe91e61afd4c107aeed702b94394ac643f2f6aa62065` | `6f0b22e0384b0706e5876ea704c12816857444f575e45c4a9ceff981dc31fb15` |

Every offline load verified the complete selected snapshot and weight digest.
`trust_remote_code=False` was used. Loading the backbone intentionally
discarded only the checkpoint's original task head:

- xsmall unexpected keys: `classifier.weight`, `classifier.bias`,
  `head.dense.weight`, `head.norm.weight`;
- ModernBERT unexpected keys: `decoder.bias`, `head.dense.weight`,
  `head.norm.weight`;
- both models: no missing keys, mismatched keys, or load errors.

The measurement head is identical across candidates:
`fp32 Linear(hidden_size, 1)` initialized under seed 42 over masked-mean
`last_hidden_state`. Its logits have no quality interpretation.

## Formal timing breakdown

Each warm measurement excludes three warmups and contains 30 samples.

### `ja_xsmall`

| Phase | p50 | p95 | Bootstrap 95% CI for p95 | Maximum |
| --- | ---: | ---: | ---: | ---: |
| Tokenization | 0.028 s | 0.030 s | 0.029–0.032 s | 0.032 s |
| Backbone + temporary head | 1.142 s | 1.340 s | 1.208–1.609 s | 1.609 s |
| End to end | 1.174 s | **1.371 s** | 1.239–1.643 s | 1.643 s |

- p50 throughput: 25.55 candidates/second
- measured effective CPU use: 7.81 cores
- independent cold start, five processes: p50 3.676 s, p95 3.950 s,
  maximum 3.997 s — Target

### `modernbert_ja_30m`

| Phase | p50 | p95 | Bootstrap 95% CI for p95 | Maximum |
| --- | ---: | ---: | ---: | ---: |
| Tokenization | 0.032 s | 0.038 s | 0.036–0.041 s | 0.041 s |
| Backbone + temporary head | 1.192 s | 1.631 s | 1.496–1.946 s | 1.946 s |
| End to end | 1.230 s | **1.676 s** | 1.539–1.993 s | 1.993 s |

- p50 throughput: 24.39 candidates/second
- measured effective CPU use: 5.89 cores
- independent cold start, five processes: p50 3.733 s, p95 3.917 s,
  maximum 3.959 s — Target

## Memory

The memory figures are process-RSS deltas from the lightweight runner before
PyTorch, Transformers, the tokenizer, and the FP32 model were loaded.

| Candidate | Idle resident delta | Peak loaded/inference delta |
| --- | ---: | ---: |
| `ja_xsmall` | 627.1 MiB | 716.8 MiB |
| `modernbert_ja_30m` | 627.5 MiB | 722.4 MiB |

Latency is the formal Gate 3 decision criterion, so this memory cost does not
reverse the speed pass. It is nevertheless too material to treat as free:
Gate 4 and any later product-runtime gate must distinguish the FP32 training
path from an exported ONNX/quantized inference path and measure coexistence
with the semantic embedder.

## Environment

| Component | Value |
| --- | --- |
| OS | Arch Linux, kernel `7.1.4-arch1-1`, x86_64 |
| Python | 3.14.6 |
| PyTorch | 2.11.0+cpu |
| Transformers | 5.5.0 |
| Tokenizers | 0.22.2 |
| Hugging Face Hub | 1.5.0 |
| CPU governor | `schedutil` |
| CUDA | unavailable; CPU is normative |
| Inter-op threads | 1 |
| `OMP_NUM_THREADS` / `MKL_NUM_THREADS` | unset |
| `TOKENIZERS_PARALLELISM` | `false` |

## Exact commands

All measurements after bootstrap ran with Hugging Face and Transformers
offline mode enabled.

### Bootstrap and repeat verification

```bash
.venv/bin/python tools/bootstrap_impact_gate3.py \
  --config configs/phase0b-impact-gate3.yaml

HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 \
  .venv/bin/python tools/bootstrap_impact_gate3.py \
  --config configs/phase0b-impact-gate3.yaml
```

### Pilot matrix

```bash
HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 \
  .venv/bin/python -m grimodex_lfm_eval.impact_gate3_benchmark \
  --config configs/phase0b-impact-gate3.yaml \
  --model ja_xsmall \
  --mode pilot \
  --batch-sizes 1,2,4,8 \
  --thread-counts 1,2,4,physical,8 \
  --bucket-modes naive,bucketed \
  --pilot-repetitions 1 \
  --skip-cold \
  --output artifacts/phase0b/gate3/pilot-ja_xsmall.json

HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 \
  .venv/bin/python -m grimodex_lfm_eval.impact_gate3_benchmark \
  --config configs/phase0b-impact-gate3.yaml \
  --model modernbert_ja_30m \
  --mode pilot \
  --batch-sizes 1,2,4,8 \
  --thread-counts 1,2,4,physical,8 \
  --bucket-modes naive,bucketed \
  --pilot-repetitions 1 \
  --skip-cold \
  --output artifacts/phase0b/gate3/pilot-modernbert_ja_30m.json
```

The pilot tested 40 configurations per model. Its best single observations
were 1.104 s for xsmall at batch 4 / 8 threads / bucketed and 0.997 s for
ModernBERT at batch 2 / 6 physical threads / bucketed. Pilot values were used
only for configuration selection.

### Formal runs

```bash
HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 \
  .venv/bin/python -m grimodex_lfm_eval.impact_gate3_benchmark \
  --config configs/phase0b-impact-gate3.yaml \
  --model ja_xsmall \
  --mode early-gate \
  --batch-sizes 4 \
  --thread-counts 8 \
  --bucket-modes bucketed \
  --output artifacts/phase0b/gate3/final-ja_xsmall.json

HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 \
  .venv/bin/python -m grimodex_lfm_eval.impact_gate3_benchmark \
  --config configs/phase0b-impact-gate3.yaml \
  --model modernbert_ja_30m \
  --mode early-gate \
  --batch-sizes 2 \
  --thread-counts 6 \
  --bucket-modes bucketed \
  --output artifacts/phase0b/gate3/final-modernbert_ja_30m.json
```

### Contract and dataset checks

```bash
.venv/bin/python -m pytest -q
.venv/bin/python tools/validate_dataset.py data/public
```

The final local verification completed with 77 tests passed, nine subtests
passed, and the committed public dataset valid.

## Final scope

Gate 3 succeeded as an early cost gate. It authorizes the proposed Gate 4
minimal Impact probe of 200–300 labeled cases comparing frozen-head and
full-fine-tuning variants for both initializations. It does not authorize:

- using current relevance logits for affected/unaffected decisions;
- deleting, hiding, or deprioritizing an Impact candidate in the product;
- claiming positive recall, precision, calibration, or break-even quality;
- shipping a PyTorch/FP32 runtime.
