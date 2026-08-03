from __future__ import annotations

import unittest

from grimodex_lfm_eval.metrics import (
    binary_classification_metrics,
    ranking_metrics,
)


class MetricsTests(unittest.TestCase):
    def test_binary_metrics_report_recall_reduction_and_brier(self) -> None:
        metrics = binary_classification_metrics(
            labels=[1, 1, 0, 0],
            probabilities=[0.9, 0.8, 0.4, 0.1],
            threshold=0.5,
        )

        self.assertEqual(metrics.positive_recall, 1.0)
        self.assertEqual(metrics.false_negative_rate, 0.0)
        self.assertEqual(metrics.candidate_reduction, 0.5)
        self.assertAlmostEqual(metrics.brier_score, 0.055)

    def test_ranking_metrics_use_graded_relevance(self) -> None:
        metrics = ranking_metrics([0, 2, 1], k_values=(1, 3))

        self.assertEqual(metrics.recall_at[1], 0.0)
        self.assertEqual(metrics.recall_at[3], 1.0)
        self.assertEqual(metrics.reciprocal_rank, 0.5)
        self.assertGreater(metrics.ndcg_at[3], 0.0)
        self.assertLessEqual(metrics.ndcg_at[3], 1.0)

    def test_metric_inputs_must_have_equal_nonzero_length(self) -> None:
        with self.assertRaises(ValueError):
            binary_classification_metrics([1], [0.9, 0.1])


if __name__ == "__main__":
    unittest.main()
