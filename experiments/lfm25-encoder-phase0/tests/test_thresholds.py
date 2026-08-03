from __future__ import annotations

import unittest

from grimodex_lfm_eval.thresholds import (
    PredictionRecord,
    ThresholdSelectionError,
    select_impact_thresholds,
)


class ThresholdTests(unittest.TestCase):
    def test_test_split_cannot_be_used_for_threshold_selection(self) -> None:
        with self.assertRaisesRegex(ThresholdSelectionError, "validation"):
            select_impact_thresholds(
                [
                    PredictionRecord(
                        probability=0.9,
                        label=1,
                        split="test",
                        direct_contradiction=True,
                    )
                ],
                minimum_recall=0.95,
            )

    def test_low_threshold_maximizes_reduction_under_recall_constraints(self) -> None:
        records = [
            PredictionRecord(0.95, 1, "validation", True),
            PredictionRecord(0.75, 1, "validation", False),
            PredictionRecord(0.60, 1, "validation", True),
            PredictionRecord(0.40, 0, "validation", False),
            PredictionRecord(0.10, 0, "validation", False),
        ]

        selection = select_impact_thresholds(
            records,
            minimum_recall=1.0,
            minimum_direct_recall=1.0,
        )

        self.assertEqual(selection.low_threshold, 0.60)
        self.assertEqual(selection.positive_recall, 1.0)
        self.assertEqual(selection.direct_recall, 1.0)
        self.assertEqual(selection.candidate_reduction, 0.4)
        self.assertGreaterEqual(selection.high_threshold, selection.low_threshold)


if __name__ == "__main__":
    unittest.main()
