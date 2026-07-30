# Phase 0b Gate 4 — provisional minimal Impact probe

Date: 2026-07-30

Host: AMD Ryzen 5 3600, 6 physical / 12 logical cores

Verdict: **provisional synthetic result only; no Gate 4 promotion while Gate 3.1 is Hold**

## Decision

This probe was completed before the production-shaped full-scene latency
prerequisite was measured. Gate 3.1 subsequently expanded the same 30-scene
candidate workload to 184 windows and placed both finalists in Hold:

| Model               | Gate 3.1 full-scene p95 | Gate 3.1 saturated 30-window p95 | Formal Gate 4 eligible |
| ------------------- | ----------------------: | -------------------------------: | ---------------------- |
| `ja_xsmall`         |                11.267 s |                          1.856 s | **No**                 |
| `modernbert_ja_30m` |                11.751 s |                          2.481 s | **No**                 |

The full evidence and workload accounting are recorded in
[`PHASE0B_GATE31_RESULTS.md`](./PHASE0B_GATE31_RESULTS.md). Gate 3's original
30-window Target result remains a useful lower bound, but it is not the
production-shaped cost of processing 30 complete scenes. Gate 3.1 therefore
blocks formal Gate 4 promotion and any human-corpus expansion from this branch.

Within that non-promoting scope, the fixed synthetic protocol selected
`modernbert_ja_30m` with a frozen masked-mean linear head. Its
validation-selected threshold passed the fresh locked synthetic test without a
false negative:

| Metric                                | Locked test |      Gate |
| ------------------------------------- | ----------: | --------: |
| Affected recall                       |   **1.000** |   >= 0.95 |
| Synthetic direct-contradiction recall |   **1.000** |      1.00 |
| Candidate reduction                   |   **0.450** |   >= 0.30 |
| Challenge affected recall             |   **1.000** |   >= 0.80 |
| Average Precision                     |       0.993 |  reported |
| Precision                             |       0.909 |  reported |
| F1                                    |       0.952 |  reported |
| ROC-AUC                               |       0.993 | auxiliary |
| Brier score                           |       0.103 |  reported |
| Expected Calibration Error            |       0.250 |  reported |

The runner-local machine verdict is `continue_to_human_corpus`, with
`phase1Ready: false`. It describes only the synthetic classifier probe and is
non-authorizing once the Gate 3.1 prerequisite is applied. The effective
project verdict is **Hold**. The corpus is controlled, synthetic, and
`unreviewed`; it has no human-verified contradiction subset and does not
represent real manuscript distributions.

The result supports one conclusion only:

> A small Japanese backbone contains Impact-separation signal worth preserving
> as offline research evidence if the full-scene latency prerequisite is solved.

It does not support product candidate removal, a default-enabled triage path,
human-corpus expansion, or a claim that 45% of real Impact candidates can
safely be discarded.

## Four-candidate comparison

Checkpoint selection and low-threshold selection used validation only. All
four candidates separated the standard validation templates, so challenge
robustness was required before a finalist could be selected.

| Model               | Mode           | Best / completed epoch | Validation AP | Validation recall | Validation reduction | Validation Brier | Low threshold | Challenge recall | Challenge reduction | Challenge verdict   |
| ------------------- | -------------- | ---------------------: | ------------: | ----------------: | -------------------: | ---------------: | ------------: | ---------------: | ------------------: | ------------------- |
| `ja_xsmall`         | frozen head    |                  2 / 5 |         1.000 |             1.000 |                0.500 |            0.057 |        0.1767 |        **1.000** |               0.400 | Pass                |
| `ja_xsmall`         | full fine-tune |                  1 / 4 |         1.000 |             1.000 |                0.500 |           <0.001 |        0.9923 |        **0.200** |               0.900 | **Fail**            |
| `modernbert_ja_30m` | frozen head    |                11 / 14 |         1.000 |             1.000 |                0.500 |            0.084 |        0.4802 |        **1.000** |           **0.500** | **Pass / selected** |
| `modernbert_ja_30m` | full fine-tune |                  1 / 4 |         1.000 |             1.000 |                0.500 |            0.187 |        0.5444 |            0.800 |               0.600 | Pass                |

The full xsmall model still ranked every challenge positive above every
challenge negative (`AP = 1.000`). Its failure was threshold transfer:
validation positives saturated above 0.992, while structurally different
challenge positives ranged much lower. Applying the frozen validation
threshold therefore retained only 20% of challenge positives.

The two frozen heads transferred more conservatively. ModernBERT frozen was
selected because it kept 100% challenge recall while reducing 50% of
challenge candidates, versus 40% for xsmall frozen.

This is not evidence that ModernBERT is universally better than xsmall. It is
the deterministic winner for this small synthetic probe. The next human-data
gate should retain xsmall frozen as a comparator and should not promote
xsmall full fine-tuning without a larger calibration set or a more
conservative threshold rule.

## Locked-test details

The fresh test contains 40 records from four story packs: 20 positives and 20
negatives. At the validation threshold `0.4802494943141937`, the selected
model produced:

- 20 true positives;
- 18 true negatives;
- 2 false positives;
- 0 false negatives.

The two false positives were both story 22 hard negatives:

- a correct past-state age reference, probability `0.497868`;
- an alias-only historical quotation, probability `0.575110`.

Every positive slice therefore retained recall 1.00, including numeric,
alias/name, affiliation/role, ability with negation, phase-specific state,
dialogue, narration, direct contradiction, and implication conflict.

Calibration is not production-ready. The locked-test ECE of 0.250 and the
false positives immediately above the threshold show that these probabilities
must remain ranking/triage evidence, not user-facing confidence.

## Corpus contract

| Property      | Fixed value                                                        |
| ------------- | ------------------------------------------------------------------ |
| Corpus        | `data/public/gate4/impact-probe-ja.jsonl`                          |
| SHA-256       | `4b65691569dc917d5060836fc23b765f07fb859cbb8ead20fe23e3962b2d021d` |
| Records       | 240                                                                |
| Story packs   | 24                                                                 |
| Labels        | 120 positive / 120 negative                                        |
| Train         | 14 stories / 140 records                                           |
| Validation    | 4 stories / 40 records                                             |
| Locked test   | 4 stories / 40 records                                             |
| Challenge     | 2 stories / 20 records                                             |
| Source        | synthetic                                                          |
| Review status | unreviewed                                                         |
| License       | synthetic                                                          |

Each of the 120 controlled changes has exactly one exact-span positive and one
same-change hard negative. The builder covers base summary/content/detail,
alias/name, phase summary/content/detail, numeric facts,
affiliation/role/relationship, life/death/ownership/location/state, ability
presence/absence, direct and implication conflicts, dialogue, narration,
negation, hypothetical/dream/flashback/lie/quotation, correct past-state
references, unrelated changed fields, and alias-only negatives.

The deterministic builder and committed JSONL are byte-equivalent. All
positive spans were revalidated against `sceneText`, IDs are unique, and no
story crosses train, validation, test, or challenge.

## Protocol amendment and consumed holdout

The first measurement run exposed a selection-protocol defect. It selected
xsmall full fine-tuning from validation alone because that candidate had the
lowest validation Brier score. Its then-opened test happened to pass at recall
1.00 and reduction 0.50, but the separately evaluated challenge recall was
only 0.20. Under the original rule the run correctly emitted `stop_probe`.

Post-run diagnostics showed that both frozen candidates retained challenge
recall 1.00. The failure was therefore not absence of backbone signal; it was
failure to use the already-declared challenge split as a pre-test robustness
guard.

The protocol was amended before a second test evaluation:

1. validation still selects checkpoints and thresholds;
2. challenge now filters and ranks finalists before test;
3. the first test split was treated as consumed and was never used again;
4. four new held-out story templates replaced it;
5. the replacement test was opened once for the selected finalist.

The first run remains under ignored local artifacts as failure evidence:
`artifacts/phase0b/gate4/seed42-run1/`. The accepted run is:
`artifacts/phase0b/gate4/seed42-run2-fresh-test/`.

This amendment is recorded because silently rerunning the original test or
discarding the challenge failure would invalidate the decision.

## Supply-chain and runtime identity

Runner commit:
`1101d583c95dfe5fc36ffebd42b4b8f5f2c62f10`

| Key                 | Revision                                   | Weight SHA-256                                                     | Verified manifest SHA-256                                          |
| ------------------- | ------------------------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `ja_xsmall`         | `de99fd2f16c7b5df1df1bcc1d9ad2c16d88ce93a` | `93a48c41e3deeb772a024057ed163f803dfe550052b9e2155cbe2b9631602961` | `a800f06b4742ac2f791ba15ccfbadc6a67e895d295f1b62787e3f3367fa0cf0d` |
| `modernbert_ja_30m` | `8cb03f54cb9e30e72459e5f1cedc6d89c7d8dcb5` | `de292c27183e6b158bafbe91e61afd4c107aeed702b94394ac643f2f6aa62065` | `6f0b22e0384b0706e5876ea704c12816857444f575e45c4a9ceff981dc31fb15` |

Every load ran offline, verified the complete selected snapshot and weight
digest, and used `trust_remote_code=False`. Only the original task heads were
discarded when loading the shared backbones; there were no missing,
mismatched, or load-error keys.

The run used Python 3.14.6, PyTorch 2.11.0+cpu, Transformers 5.5.0, seed 42,
batch size 4, eight CPU threads for xsmall, and six for ModernBERT. The
optimizer-loop times recorded by the runner exclude model loading,
tokenization, and frozen-backbone embedding extraction, so they are not
end-to-end training-time claims.

## Exact commands

```bash
cd experiments/lfm25-encoder-phase0

.venv/bin/python tools/build_impact_gate4_corpus.py
.venv/bin/python tools/validate_dataset.py data/public
.venv/bin/pytest

HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 \
  TOKENIZERS_PARALLELISM=false \
  .venv/bin/python -m grimodex_lfm_eval.impact_gate4_runner \
  --config configs/phase0b-impact-gate4.yaml \
  --output artifacts/phase0b/gate4/seed42-run2-fresh-test
```

Canonical repository quality evidence:

```bash
pnpm verify:quality
pnpm eval:impact -- --run \
  --report /tmp/grimodex-impact-gate4-report-escalated.json
```

The first sandboxed impact-gate attempt failed because `tsx` could not create
its local IPC socket (`listen EPERM`). The identical canonical command passed
outside that socket restriction: quality-workflow, ai-routing, tool-policy,
prompt-contract, and retrieval-grounding all passed. The model-training heavy
evaluation remains manual by design and is registered as deferred CI evidence.

## Stop condition and possible restart

Do not collect a human-reviewed Impact corpus, integrate the classifier, export
ONNX, or remove candidates from this result. The next authorized work is a
separate latency-design experiment that materially reduces the number or cost
of full-scene windows and then reruns the same Gate 3.1 workload. Only a future
Gate 3.1 Pass may reopen the human-corpus gate.

The synthetic probe, frozen thresholds, and consumed-holdout record remain
useful comparator evidence. They do not advance Phase 0b while the prerequisite
is Hold.
