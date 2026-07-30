# Phase 0 PR 1 local evidence

This is a reproducible decision record for the initial local host. Generated
JSON artifacts remain ignored because they contain host-specific measurements;
the exact commands and identifying hashes are retained here.

## Fixed inputs

- Model revision:
  `0b649ad0c684378b03d4d8304f7577a662ab89bc`
- Snapshot manifest SHA-256:
  `62767d0d2cbdbd9ca87a495f6b4ba9537ab5eb89138c835b44a792bcc0d798e7`
- Source-controlled PR 1 harness commit:
  `d2ab05fa2c0c2f444c3c54fe427ed0267720ef22`
- Runner: `grimodex-lfm-eval` 0.1.0,
  `python -m grimodex_lfm_eval.benchmark`
- Benchmark report schema version: 1
- `uv.lock` SHA-256:
  `2dd1b719b6b8994f9564e64309ab8a3c2355a45a2657cf442244a132f151750d`
- CPU: AMD Ryzen 5 3600, 6 physical / 12 logical cores
- CPU runtime: PyTorch 2.11.0+cpu, Transformers 5.1.0, Python 3.14.6
- GPU smoke device: NVIDIA GeForce RTX 2070 SUPER, 8 GB

The CPU runs left `OMP_NUM_THREADS`, `MKL_NUM_THREADS`, and
`OPENBLAS_NUM_THREADS` unset. `TOKENIZERS_PARALLELISM=false` was set by the
experiment configuration. `--thread-counts physical` resolved to six and the
runner applied `torch.set_num_threads(6)`; PyTorch reported 12 interop threads.

The accepted artifacts were produced from the PR 1 worktree that culminated
in the commit above. Before that commit, the Impact length generator was
corrected and interrupt-safe checkpointing was added. The accepted Relevance
and cold-start measurement paths and budgets were unchanged; the earlier
Impact row was explicitly discarded.

## Reproduction commands

The following commands are the invocations actually used, with line wrapping
added only for readability. They run from
`experiments/lfm25-encoder-phase0` after syncing the locked CPU or CUDA
environment.

### CPU and CUDA smoke

```bash
HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 \
  .venv-cu128/bin/python -m grimodex_lfm_eval.train \
  --config configs/relevance-1024.yaml \
  --smoke \
  --output artifacts/smoke/c0-cpu-cuda.json
```

### Configuration pilots

The first command compared naive and bucketed order and full and windowed
Impact modes at batch 4 / four threads:

```bash
.venv/bin/python -m grimodex_lfm_eval.benchmark \
  --config configs/benchmark-cpu.yaml \
  --mode pilot \
  --pilot-repetitions 1 \
  --lengths 256 \
  --candidate-counts 12,30 \
  --batch-sizes 4 \
  --thread-counts 4 \
  --skip-cold \
  --output artifacts/early-gate/pilot-thread4-batch4.json
```

The second command screened batch 8 on the physical-core and eight-thread
settings using the promising bucketed / full-context path:

```bash
HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 \
  .venv/bin/python -m grimodex_lfm_eval.benchmark \
  --config configs/benchmark-cpu.yaml \
  --mode pilot \
  --pilot-repetitions 1 \
  --skip-length-sweep \
  --batch-sizes 8 \
  --thread-counts physical,8 \
  --bucket-modes bucketed \
  --impact-context-modes full \
  --skip-cold \
  --output artifacts/early-gate/pilot-batch8-thread6-8.json
```

### Formal Relevance and cold-start run

```bash
HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 \
  .venv/bin/python -m grimodex_lfm_eval.benchmark \
  --config configs/benchmark-cpu.yaml \
  --mode early-gate \
  --skip-length-sweep \
  --batch-sizes 8 \
  --thread-counts physical \
  --bucket-modes bucketed \
  --impact-context-modes full \
  --output artifacts/early-gate/final-batch8-thread6.json
```

Only the Relevance and cold-start rows from this run are retained. Its Impact
row used the subsequently discarded 1,024-token-capped generator.

### Corrected Impact pilot

```bash
HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 \
  .venv/bin/python -m grimodex_lfm_eval.benchmark \
  --config configs/benchmark-cpu.yaml \
  --mode pilot \
  --pilot-repetitions 10 \
  --skip-length-sweep \
  --workloads impact \
  --batch-sizes 8 \
  --thread-counts physical \
  --bucket-modes bucketed \
  --impact-context-modes full \
  --skip-cold \
  --output artifacts/early-gate/impact-2048-chunk-1.json
```

### Host-contention proxy

```bash
HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 \
  node tools/host_contention_probe.mjs \
  --config configs/benchmark-contention.yaml \
  --output artifacts/contention-batch8-thread6.json
```

## C0 smoke

The verified offline snapshot completed one forward/backward optimizer step
over eight 256-token samples on both CPU and CUDA:

| Device | Finite loss |
| ------ | ----------: |
| CPU    |    0.982956 |
| CUDA   |    1.258116 |

This establishes runtime compatibility only. It does not satisfy the CPU
latency gate.

## C0.5 configuration search

One-sample pilots screened naive versus bucketed order, full versus windowed
impact context, batch sizes 4 and 8, and 4, 6-physical-core, and 8-thread
execution. Batch 8, bucketed order, full context, and 6 physical cores was the
fastest sampled configuration:

| Workload                 | Pilot minimum |
| ------------------------ | ------------: |
| Relevance, 12 candidates |       10.402s |
| Relevance, 30 candidates |       23.492s |
| Impact, 30 candidates    |       53.853s |

The first Impact pilot mistakenly generated candidates only through 1,024
tokens while labelling the cap as 2,048. That result was discarded. The
Impact result above comes from a 10-sample corrected pilot using the
256/512/.../2,048-token distribution and 36,864 attention tokens per
workload. Its p50 was 60.395 seconds and its pilot p95 was 65.020 seconds.

The wider matrix remains available in the runner. It was not promoted to a
complete formal measurement after the promising edge of the search already
missed every hard-stop budget.

## C0.5 formal decision

Run `20260729T194929Z` measured the selected configuration with three excluded
warmups followed by 30 relevance samples, plus five independent cold
processes:

| Workload                 | Samples |     p50 |     p95 | Bootstrap p95 95% CI | Budget boundary       | Ratio | Verdict     |
| ------------------------ | ------: | ------: | ------: | -------------------: | --------------------- | ----: | ----------- |
| Relevance, 12 candidates |      30 | 12.423s | 13.555s |       13.192–13.739s | Hard stop: 4s         | 3.39x | Reject      |
| Relevance, 30 candidates |      30 | 27.705s | 29.892s |       29.420–30.187s | Hard stop: 8s         | 3.74x | Reject      |
| Cold start               |       5 |  5.410s |  5.435s |         5.384–5.439s | Target: 5s; cond: 15s |     — | Conditional |

The corrected Impact workload was stopped after 10 samples because even its
53.853-second minimum is 2.69 times the 20-second hard-stop boundary. No formal
p95 is claimed for corrected Impact. The earlier, easier 1,024-token-capped
workload had already produced a 30-sample p95 of 30.375 seconds, so further
measurement could not change the Phase 0 decision and was intentionally
stopped.

| Corrected workload    | Samples | Minimum | Pilot p50 | Pilot p95 | Hard stop | Minimum ratio | Verdict |
| --------------------- | ------: | ------: | --------: | --------: | --------: | ------------: | ------- |
| Impact, 30 candidates |      10 | 53.853s |   60.395s |   65.020s |       20s |         2.69x | Reject  |

## Memory evidence

Memory was recorded as process RSS growth relative to the pre-model runtime
baseline. It is not absolute system RSS, GPU VRAM, or a formally promoted
acceptance gate.

| Workload                          | Incremental idle RSS | Incremental peak RSS |
| --------------------------------- | -------------------: | -------------------: |
| Relevance, 12 candidates (formal) |            653.8 MiB |          1,429.3 MiB |
| Relevance, 30 candidates (formal) |            653.8 MiB |          1,605.6 MiB |
| Corrected Impact, 30 candidates   |            653.8 MiB |          1,397.6 MiB |
| Cold start                        |         Not recorded |         Not recorded |

Memory was not promoted to a formal gate because latency had already rejected
both tracks. The values remain diagnostic evidence for future model or runtime
comparisons.

The Node event-loop proxy changed from 1.080ms baseline p95 to 1.332ms while
the selected encoder workload ran, a +0.252ms delta. This is not renderer input
latency evidence. The encoder workload itself took 50.9 seconds in the
continuous-child probe.

## Decision

Both Semantic Recall reranking and Impact Review triage stop at PR 1 on this
CPU baseline. Corpus expansion, fine-tuning, and product integration do not
proceed because both warm tracks are in Reject. The offline harness remains
available for a future model, quantized runtime, or materially faster host.
