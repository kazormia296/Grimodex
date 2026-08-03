from __future__ import annotations

from collections import defaultdict
import json
from pathlib import Path
import tempfile
import unittest

from grimodex_lfm_eval.impact_gate4 import (
    LockedTestEvaluationError,
    assess_probe_signal,
    build_impact_probe_records,
    build_impact_probe_split_manifest,
    load_impact_gate4_config,
    load_impact_gate4_records,
    write_locked_test_report,
)


EXPERIMENT_ROOT = Path(__file__).resolve().parents[1]
CONFIG_PATH = EXPERIMENT_ROOT / "configs" / "phase0b-impact-gate4.yaml"


class ImpactGate4ConfigTests(unittest.TestCase):
    def test_config_pins_probe_scope_models_and_decision_contract(self) -> None:
        config = load_impact_gate4_config(CONFIG_PATH)

        self.assertEqual(config.schema_version, 1)
        self.assertEqual(config.corpus.record_count, 240)
        self.assertEqual(
            config.corpus.story_counts,
            {
                "train": 14,
                "validation": 4,
                "test": 4,
                "challenge": 2,
            },
        )
        self.assertEqual(config.training.modes, ("frozen_head", "full_finetune"))
        self.assertEqual(config.training.seed, 42)
        self.assertEqual(config.training.max_pair_tokens, 512)
        self.assertEqual(config.thresholds.minimum_recall, 0.95)
        self.assertEqual(config.thresholds.minimum_direct_recall, 1.0)
        self.assertEqual(config.thresholds.minimum_candidate_reduction, 0.30)
        self.assertEqual(config.thresholds.minimum_challenge_recall, 0.80)
        self.assertEqual(
            config.protocol.selection_protocol_version,
            "phase0b-impact-gate4-selection-v2",
        )
        self.assertEqual(config.protocol.gate31_prerequisite, "hold")
        self.assertFalse(config.protocol.formal_gate4_eligible)
        self.assertEqual(
            config.protocol.test_consumption_registry,
            "data/public/gate4/test-consumption",
        )
        self.assertEqual(
            {model.key: model.revision for model in config.models},
            {
                "ja_xsmall": "de99fd2f16c7b5df1df1bcc1d9ad2c16d88ce93a",
                "modernbert_ja_30m": (
                    "8cb03f54cb9e30e72459e5f1cedc6d89c7d8dcb5"
                ),
            },
        )


class ImpactGate4CorpusTests(unittest.TestCase):
    def test_committed_corpus_matches_the_deterministic_controlled_builder(self) -> None:
        config = load_impact_gate4_config(CONFIG_PATH)
        committed = load_impact_gate4_records(CONFIG_PATH, config)
        generated = build_impact_probe_records()

        self.assertEqual(
            [
                record.model_dump(mode="json", by_alias=True)
                for record in committed
            ],
            [
                record.model_dump(mode="json", by_alias=True)
                for record in generated
            ],
        )
        self.assertEqual(len(committed), 240)
        self.assertEqual(sum(record.label for record in committed), 120)
        self.assertEqual(
            {record.review_status for record in committed},
            {"unreviewed"},
        )

        split_manifest = build_impact_probe_split_manifest()
        split_by_story = {
            story_id: split
            for split in ("train", "validation", "test", "challenge")
            for story_id in getattr(split_manifest, split)
        }
        counts = defaultdict(int)
        for record in committed:
            counts[split_by_story[record.story_id]] += 1
        self.assertEqual(
            dict(counts),
            {
                "train": 140,
                "validation": 40,
                "test": 40,
                "challenge": 20,
            },
        )

        required_slices = {
            "base-summary",
            "base-content",
            "detail",
            "alias-name",
            "phase-summary",
            "phase-content",
            "phase-detail",
            "numeric",
            "affiliation-role-relationship",
            "life-death-ownership-location-state",
            "ability-presence-absence",
            "direct-contradiction",
            "implication-conflict",
            "dialogue",
            "narration",
            "negation",
            "hypothetical-dream-flashback-lie-quotation",
            "past-state-negative",
            "unrelated-changed-field-negative",
            "alias-only-negative",
        }
        actual_slices = {
            difficulty
            for record in committed
            for difficulty in record.difficulty
        }
        self.assertLessEqual(required_slices, actual_slices)

    def test_each_controlled_change_has_one_positive_and_one_hard_negative(self) -> None:
        records = build_impact_probe_records()
        by_change_id = defaultdict(list)
        for record in records:
            by_change_id[str(record.diff_payload["change_id"])].append(record)

        self.assertEqual(len(by_change_id), 120)
        for change_records in by_change_id.values():
            self.assertEqual(len(change_records), 2)
            self.assertEqual(
                sorted(record.label for record in change_records),
                [0, 1],
            )
            self.assertEqual(
                len({record.story_id for record in change_records}),
                1,
            )
            self.assertEqual(
                len({record.entry.id for record in change_records}),
                1,
            )
            positive = next(
                record for record in change_records if record.label == 1
            )
            self.assertTrue(positive.affected_spans)
            for span in positive.affected_spans:
                self.assertEqual(
                    positive.scene_text[span.start : span.end],
                    span.text,
                )


class ImpactGate4DecisionTests(unittest.TestCase):
    def test_probe_signal_is_separate_from_formal_project_decision(self) -> None:
        promoted = assess_probe_signal(
            positive_recall=0.95,
            direct_recall=1.0,
            candidate_reduction=0.30,
            challenge_recall=0.80,
        )
        stopped = assess_probe_signal(
            positive_recall=0.90,
            direct_recall=1.0,
            candidate_reduction=0.50,
            challenge_recall=1.0,
        )

        self.assertEqual(promoted.synthetic_probe_assessment, "signal_detected")
        self.assertEqual(promoted.gate31_prerequisite, "hold")
        self.assertFalse(promoted.formal_gate4_eligible)
        self.assertFalse(promoted.continue_to_human_corpus)
        self.assertEqual(
            promoted.effective_verdict,
            "hold_on_latency_prerequisite",
        )
        self.assertFalse(promoted.phase1_ready)
        self.assertEqual(
            stopped.synthetic_probe_assessment,
            "insufficient_signal",
        )
        self.assertEqual(stopped.effective_verdict, "stop_on_synthetic_probe")
        self.assertFalse(stopped.continue_to_human_corpus)
        self.assertFalse(stopped.phase1_ready)

    def test_locked_test_report_requires_validation_threshold_and_is_write_once(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            output = Path(temporary_directory) / "locked-test.json"
            report = {
                "schemaVersion": 1,
                "split": "test",
                "thresholdSource": "validation",
                "threshold": 0.42,
            }

            write_locked_test_report(output, report)
            self.assertEqual(
                json.loads(output.read_text(encoding="utf-8")),
                report,
            )
            with self.assertRaisesRegex(
                LockedTestEvaluationError,
                "already exists",
            ):
                write_locked_test_report(output, report)

            invalid_output = Path(temporary_directory) / "invalid.json"
            with self.assertRaisesRegex(
                LockedTestEvaluationError,
                "validation",
            ):
                write_locked_test_report(
                    invalid_output,
                    {
                        **report,
                        "thresholdSource": "test",
                    },
                )


if __name__ == "__main__":
    unittest.main()
