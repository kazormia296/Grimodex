# Phase 0 PR 1 local evidence

This is a reproducible decision record for the initial local host. Generated
JSON artifacts remain ignored because they contain host-specific measurements;
the exact commands and identifying hashes are retained here.

## Fixed inputs

- Model revision:
  `0b649ad0c684378b03d4d8304f7577a662ab89bc`
- Snapshot manifest SHA-256:
  `62767d0d2cbdbd9ca87a495f6b4ba9537ab5eb89138c835b44a792bcc0d798e7`
- CPU: AMD Ryzen 5 3600, 6 physical / 12 logical cores
- CPU runtime: PyTorch 2.11.0+cpu, Transformers 5.1.0, Python 3.14.6
- GPU smoke device: NVIDIA GeForce RTX 2070 SUPER, 8 GB

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

| Workload                 | Samples |     p50 |     p95 | Bootstrap p95 95% CI | Verdict     |
| ------------------------ | ------: | ------: | ------: | -------------------: | ----------- |
| Relevance, 12 candidates |      30 | 12.423s | 13.555s |       13.192–13.739s | Reject      |
| Relevance, 30 candidates |      30 | 27.705s | 29.892s |       29.420–30.187s | Reject      |
| Cold start               |       5 |  5.410s |  5.435s |         5.384–5.439s | Conditional |

The corrected Impact workload was stopped after 10 samples because even its
53.853-second minimum is 2.69 times the 20-second hard-stop boundary. No formal
p95 is claimed for corrected Impact. The earlier, easier 1,024-token-capped
workload had already produced a 30-sample p95 of 30.375 seconds, so further
measurement could not change the Phase 0 decision and was intentionally
stopped.

The Node event-loop proxy changed from 1.080ms baseline p95 to 1.332ms while
the selected encoder workload ran, a +0.252ms delta. This is not renderer input
latency evidence. The encoder workload itself took 50.9 seconds in the
continuous-child probe.

## Decision

Both Semantic Recall reranking and Impact Review triage stop at PR 1 on this
CPU baseline. Corpus expansion, fine-tuning, and product integration do not
proceed because both warm tracks are in Reject. The offline harness remains
available for a future model, quantized runtime, or materially faster host.
