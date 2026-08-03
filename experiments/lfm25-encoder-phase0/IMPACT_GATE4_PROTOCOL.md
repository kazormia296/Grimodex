# Phase 0b Gate 4 — minimal Impact probe protocol

Gate 4 asks whether either Gate 3 backbone contains enough signal to justify
collecting a larger, human-reviewed Impact Review corpus. It does not authorize
candidate removal, product integration, Phase 1, or model-weight distribution.

Formal use of this protocol requires both Gate 3.1 full-scene and saturated
30-window workloads to reach the Target band. The recorded Gate 3.1 run placed
both finalists in Hold on full scenes, so the implementation and synthetic run
are retained as provisional research evidence only. They do not currently
authorize human-corpus collection.

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
- Accepted historical selection-protocol snapshot identity:
  `phase0b-impact-gate4-selection-v2`, SHA-256
  `98c01672ef1a550f4209598f8708d577ea4a70313af54aac76f4159715f3c33b`.
- Gate 3.1 prerequisite: `hold`; formal Gate 4 eligibility: `false`.
- Test-consumption registry:
  `data/public/gate4/test-consumption/`.

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
6. If no candidate qualifies on both validation and challenge, emit
   `stop_before_locked_test`; do not select a fallback, run test prediction, or
   create a locked-test report.
7. Before the selected finalist can access test prediction, exclusively claim
   a corpus/protocol-level consumption fingerprint outside the run output.
   Only then open the locked test once.

Test labels never select a checkpoint, threshold, model, or training mode.
If the selection protocol changes after test has been opened, that test split
is consumed and a fresh holdout is required.

Changing `--output` does not change the consumption identity. Its fingerprint
is the SHA-256 of the corpus digest, test story IDs, selection protocol
version/digest, exact model revisions, and training modes. The committed
consumption record for the accepted test is:

```text
data/public/gate4/test-consumption/
  d61d6d2724432fa54b667e2eb05199e1a9862090dc633a3a9331a1bfe0f7c1e7.json
```

The registry uses exclusive creation. A crash after the claim still consumes
the test, because rerunning after partial test access would no longer be blind.

## Probe decision

The synthetic assessment is `signal_detected` only when all of these hold:

- locked-test affected recall at least 0.95;
- locked-test synthetic direct-contradiction recall 1.00;
- locked-test candidate reduction at least 0.30;
- challenge affected recall at least 0.80.

Failure yields `insufficient_signal`. This synthetic field is separate from
the project decision. For the frozen provisional config, every report also
emits:

```json
{
  "gate31Prerequisite": "hold",
  "formalGate4Eligible": false,
  "continueToHumanCorpus": false,
  "effectiveVerdict": "hold_on_latency_prerequisite",
  "phase1Ready": false
}
```

If the synthetic metrics fail, `effectiveVerdict` is
`stop_on_synthetic_probe`. If no finalist clears validation and challenge,
the test stays unopened and `effectiveVerdict` is
`stop_before_locked_test`.

The runner verdict is local to this synthetic probe. Project promotion also
requires a Gate 3.1 Pass. Only after that prerequisite passes may the next
evidence stage add work-isolated human labels from real shadow data, retain a
fresh holdout, raise the target recall toward 0.99, and repeat calibration and
runtime checks.

## Historical reproduction boundary

The Gate 3 local snapshots must already exist and pass their complete manifest
and weight SHA-256 checks. The following is the accepted historical invocation;
the current test fingerprint is now consumed and must not be rerun:

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

Changing `<new-run-id>` cannot bypass the committed consumption registry. A
future run requires a Gate 3.1 Pass, a newly frozen work-isolated holdout, and
an intentionally updated protocol identity. Generated checkpoints,
probabilities, and locked reports stay under ignored `artifacts/`; the
consumption record and aggregate decision evidence are committed.
