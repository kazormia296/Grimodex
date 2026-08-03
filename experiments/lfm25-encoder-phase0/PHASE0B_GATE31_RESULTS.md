# Phase 0b Gate 3.1 — distinct full-scene correction

Date: 2026-07-30

Host: AMD Ryzen 5 3600, 6 physical / 12 logical cores

Verdict: **Hold for both full-scene workloads; Gate 4 remains provisional**

## Decision

Gate 3.1 corrects the original Gate 3 lower-bound workload. The old result
measured 30 candidate windows from only 18 distinct scene IDs. This gate uses
30 distinct complete scenes selected by the production-shaped dense + FTS
path, converts their complete ProseMirror documents through
`prosemirrorToText`, creates every 384-token scene window at stride 256,
infers every window, and aggregates each scene as `max(window score)`.

Neither model reaches the five-second Target band on the complete-scene
workload:

| Model | Configuration | Full scenes p50 | Full scenes p95 | Bootstrap 95% CI for p95 | Maximum | Verdict |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| `ja_xsmall` | batch 4, 8 threads, bucketed | 10.497 s | **11.267 s** | 10.953–11.850 s | 11.850 s | **Hold** |
| `modernbert_ja_30m` | batch 4, 6 threads, bucketed | 9.987 s | **11.751 s** | 10.664–12.281 s | 12.281 s | **Hold** |

The separate 30-window cap stress remains inside Target:

| Model | Configuration | Cap stress p50 | Cap stress p95 | Bootstrap 95% CI for p95 | Maximum | Verdict |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| `ja_xsmall` | batch 4, 8 threads, bucketed | 1.743 s | **1.856 s** | 1.819–1.950 s | 1.950 s | **Target** |
| `modernbert_ja_30m` | batch 4, 6 threads, bucketed | 1.629 s | **2.481 s** | 2.027–2.521 s | 2.521 s | **Target** |

The boundaries remain:

| Band | End-to-end p95 |
| --- | ---: |
| Target | <= 5 seconds |
| Conditional | <= 10 seconds |
| Hold | <= 20 seconds |
| Reject / hard stop | > 20 seconds |

Gate 4 was implemented and measured before this correction was received. Its
synthetic 240-case result remains useful engineering evidence, but it is not a
formal gate result and does not authorize human-corpus expansion or product
integration. Formal Gate 4 eligibility is `false` for both model reports.

## Why the conclusion changed

The complete 30-scene workload expands to 184 windows:

| Distribution | Value |
| --- | ---: |
| Distinct full scenes | 30 |
| Windows | 184 |
| Windows per scene p50 | 7 |
| Windows per scene p95 | 8 |
| Windows per scene maximum | 8 |
| Original scene tokens | 47,510 |
| Window scene tokens including overlap | 67,222 |
| Query tokens | 88 |
| Attention tokens across all pairs | 84,150 |
| Padded tokens | 84,732 |
| Blindly truncated scenes | **0** |

The cap stress contains exactly 30 real windows of 384 scene tokens each,
14,280 attention tokens in total, and no padding. It isolates one-window-per-
scene cost and passes. The full workload contains 6.13 times as many windows,
and nearly all elapsed time is backbone forward:

| Model | Phase | p50 | p95 |
| --- | --- | ---: | ---: |
| `ja_xsmall` | Full-scene tokenization + windowing | 0.068 s | 0.092 s |
| `ja_xsmall` | Full-scene pair encoding | 0.015 s | 0.017 s |
| `ja_xsmall` | Full-scene forward | 10.395 s | 11.169 s |
| `modernbert_ja_30m` | Full-scene tokenization + windowing | 0.070 s | 0.090 s |
| `modernbert_ja_30m` | Full-scene pair encoding | 0.014 s | 0.015 s |
| `modernbert_ja_30m` | Full-scene forward | 9.878 s | 11.651 s |

The old Gate 3 p95 values were 1.371 seconds and 1.676 seconds. The corrected
full-scene measurements are respectively 8.22 and 7.01 times slower. Reaching
Target requires at least a 2.25x improvement for xsmall and a 2.35x
improvement for ModernBERT at the measured p95.

## Frozen workload and candidate policy

The exporter uses a deterministic public medium Japanese sample workspace.
For the Codex-style change `記憶。失われた。取り戻した`, production semantic
search returns 60 chunks from 27 distinct scenes and FTS returns 34 distinct
scenes. Their union contains 38 scenes; the product RRF policy freezes the top
30 inferred scenes without padding.

| Input | Fixed value |
| --- | --- |
| Workload | `data/public/gate31/impact-scenes-ja.json` |
| Workload SHA-256 | `a3d570c6a4f8d870ef2cff8bfd9ffca1dfe182a93203a342464a4ad1874e83e3` |
| Dense fetch | 60 chunks |
| Inferred scene limit | 30 |
| Full-scene conversion | `src/lib/prosemirror.ts#prosemirrorToText` |
| Fusion implementation | `src/features/impact-review/narrowingCore.ts#fuseSceneCandidates` |
| Scene window | 384 tokens |
| Window stride | 256 tokens |
| Scene aggregation | `max(window score)` |
| Explicit-link policy | retain and bypass classifier |

Explicit semantic links are author-confirmed dependencies. They are always
retained and do not consume the 30 inferred-scene limit, so the product result
may exceed 30 total scenes. The fixed performance workload has no explicit
links and therefore measures exactly 30 classifier-triaged inferred scenes.

The exporter was rerun against the same generated workspace and produced a
byte-identical file with the recorded SHA-256. Each record also retains the
source ProseMirror content hash, extracted plain-text hash, ranking
provenance, and source-file hashes.

## Supply-chain and runner identity

Runner commit:
`b4a5eae6b987eb47b56999a650505b1fe63a3829`

Runner SHA-256:
`1d6bdd10672d9d103688a48a1714d57c34bec090158864c9d6f29b76525f3f93`

| Key | Model revision | Weight SHA-256 | Verified manifest SHA-256 |
| --- | --- | --- | --- |
| `ja_xsmall` | `de99fd2f16c7b5df1df1bcc1d9ad2c16d88ce93a` | `93a48c41e3deeb772a024057ed163f803dfe550052b9e2155cbe2b9631602961` | `a800f06b4742ac2f791ba15ccfbadc6a67e895d295f1b62787e3f3367fa0cf0d` |
| `modernbert_ja_30m` | `8cb03f54cb9e30e72459e5f1cedc6d89c7d8dcb5` | `de292c27183e6b158bafbe91e61afd4c107aeed702b94394ac643f2f6aa62065` | `6f0b22e0384b0706e5876ea704c12816857444f575e45c4a9ceff981dc31fb15` |

The pre-windowed pair builder was checked against each official tokenizer on
an untruncated text pair before timing. Both were byte-for-byte identical at
the `input_ids` boundary. Complete snapshot manifests and weight hashes were
verified offline before every model load. The same untrained seed-42 FP32
linear head over masked-mean backbone output was retained, so scores make no
quality claim.

Raw local result identities:

| Result | SHA-256 |
| --- | --- |
| `artifacts/phase0b/gate31/final-ja_xsmall.json` | `5a7ef01cbf87504c7681860f0eb3366544176efaab4b5d87456b78f25a4accb2` |
| `artifacts/phase0b/gate31/final-modernbert_ja_30m.json` | `f68f51de2e9e28ddc1de5b6097ed44e873725d58719c0f8f6e64371a9c6f0885` |

Each formal workload excludes three warmups and contains 30 measured samples.

## Configuration pilot

The focused pilot reused the best Gate 3 neighborhood and measured both
full-scene and cap-stress workloads for every candidate configuration.

### `ja_xsmall`

| Batch | Threads | Full scenes | Cap stress |
| ---: | ---: | ---: | ---: |
| 4 | 6 | 12.437 s | 2.335 s |
| 8 | 6 | 14.945 s | 2.245 s |
| 4 | 8 | **11.629 s** | **1.909 s** |
| 8 | 8 | 13.440 s | 2.153 s |
| 2 | 12 | 14.338 s | 2.430 s |
| 4 | 12 | 22.980 s | 5.184 s |

### `modernbert_ja_30m`

| Batch | Threads | Full scenes | Cap stress |
| ---: | ---: | ---: | ---: |
| 2 | 6 | 9.797 s | **1.680 s** |
| 4 | 6 | **9.722 s** | 1.954 s |
| 2 | 8 | 10.896 s | 1.792 s |
| 4 | 8 | 10.437 s | 1.724 s |

Pilot values are one measured observation after one warmup and are used only
for configuration selection. Both formal configurations optimize the primary
full-scene workload while keeping cap stress inside Target.

## Memory and environment

| Model | Idle resident delta | Peak inference delta |
| --- | ---: | ---: |
| `ja_xsmall` | 628.4 MiB | 734.7 MiB |
| `modernbert_ja_30m` | 628.5 MiB | 726.3 MiB |

| Component | Value |
| --- | --- |
| OS | Arch Linux, kernel `7.1.4-arch1-1`, x86_64 |
| Python | 3.14.6 |
| PyTorch | 2.11.0+cpu |
| Transformers | 5.5.0 |
| Tokenizers | 0.22.2 |
| Hugging Face Hub | 1.5.0 |
| CUDA | unavailable; CPU is normative |
| Inter-op threads | 1 |
| Offline mode | `HF_HUB_OFFLINE=1`, `TRANSFORMERS_OFFLINE=1` |

## Exact commands

### Fixed workload

```bash
python3 scripts/seed-sample-ja.py <workspace> --scale medium

pnpm exec tsx experiments/lfm25-encoder-phase0/tools/freeze_impact_gate31_scenes.ts \
  --native-module electron/native/grimodex-node/grimodex-node.node \
  --resources src-tauri/resources/semantic \
  --workspace <workspace> \
  --output experiments/lfm25-encoder-phase0/data/public/gate31/impact-scenes-ja.json
```

### Focused pilots

```bash
HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 \
  .venv/bin/python -m grimodex_lfm_eval.impact_gate31_benchmark \
  --config configs/phase0b-impact-gate31.yaml \
  --model ja_xsmall \
  --mode pilot \
  --batch-sizes 4,8 \
  --thread-counts physical,8 \
  --bucket-modes bucketed \
  --pilot-repetitions 1 \
  --output artifacts/phase0b/gate31/pilot-ja_xsmall.json

HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 \
  .venv/bin/python -m grimodex_lfm_eval.impact_gate31_benchmark \
  --config configs/phase0b-impact-gate31.yaml \
  --model ja_xsmall \
  --mode pilot \
  --batch-sizes 2,4 \
  --thread-counts 12 \
  --bucket-modes bucketed \
  --pilot-repetitions 1 \
  --output artifacts/phase0b/gate31/pilot-ja_xsmall-t12.json

HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 \
  .venv/bin/python -m grimodex_lfm_eval.impact_gate31_benchmark \
  --config configs/phase0b-impact-gate31.yaml \
  --model modernbert_ja_30m \
  --mode pilot \
  --batch-sizes 2,4 \
  --thread-counts physical,8 \
  --bucket-modes bucketed \
  --pilot-repetitions 1 \
  --output artifacts/phase0b/gate31/pilot-modernbert_ja_30m.json
```

### Formal runs

```bash
HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 \
  .venv/bin/python -m grimodex_lfm_eval.impact_gate31_benchmark \
  --config configs/phase0b-impact-gate31.yaml \
  --model ja_xsmall \
  --mode early-gate \
  --batch-sizes 4 \
  --thread-counts 8 \
  --bucket-modes bucketed \
  --output artifacts/phase0b/gate31/final-ja_xsmall.json

HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 \
  .venv/bin/python -m grimodex_lfm_eval.impact_gate31_benchmark \
  --config configs/phase0b-impact-gate31.yaml \
  --model modernbert_ja_30m \
  --mode early-gate \
  --batch-sizes 4 \
  --thread-counts physical \
  --bucket-modes bucketed \
  --output artifacts/phase0b/gate31/final-modernbert_ja_30m.json
```

## Final scope

Gate 3.1 is a successful corrective gate. It shows that 30 saturated windows
are affordable, but 30 complete sample scenes are not Target-class under the
current FP32 CPU/windowing design. Therefore:

1. keep Gate 4 results provisional;
2. do not begin human-corpus expansion or product classifier integration;
3. retain the reproducible workload and runner for a later runtime/input
   redesign;
4. treat a new ONNX/INT8 runtime, fewer admitted inferred scenes, a larger
   stride, hierarchical scene pooling, or another bounded full-scene design as
   a separate gate with explicit recall-risk evaluation.

This result does not claim that either backbone is intrinsically unsuitable.
It holds the specific combination of both current FP32 CPU backbones, 30
inferred complete scenes, 384/256 sliding windows, and all-window inference.
