# Phase 0b Gate 4 — minimal Impact probe protocol

Gate 4 asks whether either Gate 3 backbone contains enough signal to justify
collecting a larger, human-reviewed Impact Review corpus. It does not authorize
candidate removal, product integration, Phase 1, or model-weight distribution.

## Fixed scope

- Japanese only.
- 240 controlled synthetic records across 24 story packs.
- 120 positives and 120 same-change hard negatives.
- Story-level split: train 140, validation 40, locked test 40, challenge 20.
- Review status: `unreviewed`; no synthetic direct contradiction is described
  as human-verified.
- Pair cap: 512 tokens with the Codex change preserved and only the scene
  truncated.
- Models: the exact xsmall and ModernBERT revisions verified in Gate 3.
- Training modes: frozen masked-mean linear head and full fine-tuning.
- One fixed exploratory seed, 42.

Every controlled change creates exactly two records with the same production-
shaped diff payload:

1. one positive with an exact affected span;
2. one hard negative that mentions the same entry or old value without being
   affected by the changed field.

The committed builder and JSONL must remain byte-equivalent. The public
provenance manifest records the corpus digest and explicitly preserves its
synthetic, unreviewed status.

## Leakage-resistant selection order

The runner performs these stages in order:

1. Train all four model/mode combinations on train only.
2. Select each checkpoint by validation Average Precision.
3. Select the low threshold on validation only. It must retain at least 0.95
   positive recall and 1.00 synthetic direct-contradiction recall while
   maximizing candidate reduction.
4. Apply the frozen validation threshold to challenge before selecting a
   finalist. A candidate needs challenge recall of at least 0.80.
5. Rank qualifying candidates by challenge recall, challenge reduction,
   validation Average Precision, validation reduction, validation recall,
   validation Brier score, then the declared deterministic tie-breakers.
6. Open the locked test exactly once for the selected finalist. The report is
   created with exclusive-file semantics and cannot overwrite prior evidence.

Test labels never select a checkpoint, threshold, model, or training mode.
If the selection protocol changes after test has been opened, that test split
is consumed and a fresh holdout is required.

## Probe decision

`continue_to_human_corpus` requires all of:

- locked-test affected recall at least 0.95;
- locked-test synthetic direct-contradiction recall 1.00;
- locked-test candidate reduction at least 0.30;
- challenge affected recall at least 0.80.

Failure yields `stop_probe`. Passing is intentionally capped at
`continue_to_human_corpus`; `phase1Ready` is always false because this corpus
has no human-verified direct-contradiction subset and does not represent real
manuscript distributions.

Before any product-default decision, the next evidence stage must add
work-isolated human labels from real shadow data, retain a fresh holdout, raise
the target recall toward 0.99, and repeat calibration and runtime checks.

## Reproduction

The Gate 3 local snapshots must already exist and pass their complete manifest
and weight SHA-256 checks.

```bash
cd experiments/lfm25-encoder-phase0

uv run --frozen --extra cpu \
  python tools/build_impact_gate4_corpus.py

HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 \
  TOKENIZERS_PARALLELISM=false \
  uv run --frozen --extra cpu \
  python -m grimodex_lfm_eval.impact_gate4_runner \
  --config configs/phase0b-impact-gate4.yaml \
  --output artifacts/phase0b/gate4/<new-run-id>
```

Generated checkpoints, probabilities, and locked reports stay under ignored
`artifacts/`. Only aggregate, report-safe results are promoted to the
committed decision record.
