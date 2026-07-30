from __future__ import annotations

import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from grimodex_lfm_eval.impact_gate4 import (
    LockedTestEvaluationError,
    build_locked_test_consumption_identity,
    claim_locked_test_consumption,
    load_impact_gate4_config,
    locked_test_consumption_path,
)
from grimodex_lfm_eval import impact_gate4_runner
from grimodex_lfm_eval.impact_gate4_runner import (
    CandidateSelection,
    ChallengeSelection,
    run_gate4,
    select_finalist,
)
from grimodex_lfm_eval.metrics import BinaryMetrics


EXPERIMENT_ROOT = Path(__file__).resolve().parents[1]
CONFIG_PATH = EXPERIMENT_ROOT / "configs" / "phase0b-impact-gate4.yaml"


def _metrics(
    *,
    recall: float = 1.0,
    reduction: float = 0.5,
) -> BinaryMetrics:
    return BinaryMetrics(
        positive_recall=recall,
        false_negative_rate=1.0 - recall,
        precision=1.0,
        f1=recall,
        average_precision=1.0,
        roc_auc=1.0,
        brier_score=0.1,
        expected_calibration_error=0.1,
        candidate_retention=1.0 - reduction,
        candidate_reduction=reduction,
    )


def _candidate(
    model_key: str,
    mode: str,
    *,
    qualifies: bool,
) -> CandidateSelection:
    return CandidateSelection(
        model_key=model_key,
        mode=mode,  # type: ignore[arg-type]
        best_epoch=1,
        epochs_completed=1,
        training_seconds=0.1,
        validation_metrics=_metrics(),
        validation_direct_recall=1.0,
        low_threshold=0.4,
        high_threshold=0.8,
        qualifies_on_validation=qualifies,
        checkpoint_path="/tmp/gate4-review-unused.pt",
        manifest_sha256="0" * 64,
        loading_info={
            "missingKeys": [],
            "unexpectedKeys": [],
            "mismatchedKeys": [],
            "errors": [],
        },
    )


def _challenge(
    candidate: CandidateSelection,
    *,
    qualifies: bool,
) -> ChallengeSelection:
    return ChallengeSelection(
        model_key=candidate.model_key,
        mode=candidate.mode,
        metrics=_metrics(recall=1.0 if qualifies else 0.0),
        direct_recall=1.0 if qualifies else 0.0,
        qualifies=qualifies,
    )


def _fake_train_candidate(*, model_key: str, mode: str, **_kwargs: object):
    return _candidate(model_key, mode, qualifies=True)


class Gate4FinalistEligibilityTests(unittest.TestCase):
    def test_select_finalist_returns_none_when_no_candidate_qualifies(self) -> None:
        validation_failed = _candidate(
            "ja_xsmall",
            "frozen_head",
            qualifies=False,
        )
        challenge_failed = _candidate(
            "modernbert_ja_30m",
            "frozen_head",
            qualifies=True,
        )

        selected = select_finalist(
            [validation_failed, challenge_failed],
            [
                _challenge(validation_failed, qualifies=True),
                _challenge(challenge_failed, qualifies=False),
            ],
        )

        self.assertIsNone(selected)

    def test_run_stops_before_locked_test_when_challenge_qualifies_none(self) -> None:
        def fail_challenge(
            *,
            candidate: CandidateSelection,
            **_kwargs: object,
        ) -> ChallengeSelection:
            return _challenge(candidate, qualifies=False)

        with tempfile.TemporaryDirectory() as temporary_directory:
            output_root = Path(temporary_directory) / "run"
            with (
                patch.object(
                    impact_gate4_runner,
                    "train_candidate",
                    side_effect=_fake_train_candidate,
                ),
                patch.object(
                    impact_gate4_runner,
                    "evaluate_challenge_candidate",
                    side_effect=fail_challenge,
                ),
                patch.object(
                    impact_gate4_runner,
                    "evaluate_locked_finalist",
                    side_effect=AssertionError("locked test must stay unopened"),
                ) as locked_test,
            ):
                report_path = run_gate4(CONFIG_PATH, output_root)

            locked_test.assert_not_called()
            self.assertFalse((output_root / "locked-test.json").exists())
            report = json.loads(report_path.read_text(encoding="utf-8"))
            self.assertEqual(
                report["effectiveVerdict"],
                "stop_before_locked_test",
            )
            self.assertEqual(
                report["selectionPhase"]["testStatus"],
                "not_opened_no_eligible_finalist",
            )
            self.assertEqual(report["lockedTestPhase"]["status"], "not_opened")
            self.assertNotIn("lockedTest", report)


class Gate4LockedTestConsumptionTests(unittest.TestCase):
    def test_consumption_registry_is_independent_of_run_output(self) -> None:
        config = load_impact_gate4_config(CONFIG_PATH)
        identity = build_locked_test_consumption_identity(config)

        with tempfile.TemporaryDirectory() as temporary_directory:
            record_path = (
                Path(temporary_directory)
                / f"{identity.fingerprint_sha256}.json"
            )
            claim_locked_test_consumption(
                record_path,
                identity,
                opened_at_commit="a" * 40,
                opened_at="2026-07-30T11:25:52.967697+00:00",
            )

            with self.assertRaisesRegex(
                LockedTestEvaluationError,
                "already consumed",
            ):
                claim_locked_test_consumption(
                    record_path,
                    identity,
                    opened_at_commit="b" * 40,
                    opened_at="2026-07-30T12:00:00+00:00",
                )

    def test_current_locked_test_has_a_committed_consumption_record(self) -> None:
        config = load_impact_gate4_config(CONFIG_PATH)
        identity = build_locked_test_consumption_identity(config)
        record_path = locked_test_consumption_path(
            CONFIG_PATH,
            config,
            identity,
        )

        record = json.loads(record_path.read_text(encoding="utf-8"))
        self.assertTrue(record["consumed"])
        self.assertEqual(
            record["fingerprintSha256"],
            identity.fingerprint_sha256,
        )
        self.assertEqual(record["corpusSha256"], config.corpus.sha256)
        self.assertEqual(
            record["selectionProtocolVersion"],
            config.protocol.selection_protocol_version,
        )


class Gate4ReportPhaseTests(unittest.TestCase):
    def test_final_report_separates_selection_and_locked_test_phases(self) -> None:
        def pass_challenge(
            *,
            candidate: CandidateSelection,
            **_kwargs: object,
        ) -> ChallengeSelection:
            return _challenge(candidate, qualifies=True)

        locked_report = {
            "assessment": {
                "syntheticProbeAssessment": "signal_detected",
                "gate31Prerequisite": "hold",
                "formalGate4Eligible": False,
                "continueToHumanCorpus": False,
                "effectiveVerdict": "hold_on_latency_prerequisite",
                "phase1Ready": False,
                "failedRequirements": [],
            },
            "testMetrics": _metrics(),
        }
        with tempfile.TemporaryDirectory() as temporary_directory:
            output_root = Path(temporary_directory) / "run"
            with (
                patch.object(
                    impact_gate4_runner,
                    "train_candidate",
                    side_effect=_fake_train_candidate,
                ),
                patch.object(
                    impact_gate4_runner,
                    "evaluate_challenge_candidate",
                    side_effect=pass_challenge,
                ),
                patch.object(
                    impact_gate4_runner,
                    "evaluate_locked_finalist",
                    return_value=locked_report,
                ),
            ):
                report_path = run_gate4(CONFIG_PATH, output_root)

            selection = json.loads(
                (output_root / "selection.json").read_text(encoding="utf-8")
            )
            report = json.loads(report_path.read_text(encoding="utf-8"))
            self.assertEqual(
                selection["selectionPhase"]["testStatus"],
                "unopened_at_selection",
            )
            self.assertEqual(
                report["selectionPhase"]["testStatus"],
                "unopened_at_selection",
            )
            self.assertEqual(report["lockedTestPhase"]["status"], "opened_once")
            self.assertEqual(
                report["effectiveVerdict"],
                "hold_on_latency_prerequisite",
            )
            self.assertNotIn("selectionData", report)


if __name__ == "__main__":
    unittest.main()
