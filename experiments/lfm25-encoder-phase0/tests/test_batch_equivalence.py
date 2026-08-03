from __future__ import annotations

import unittest

from grimodex_lfm_eval.benchmark import batched_predict


class BatchEquivalenceTests(unittest.TestCase):
    def test_batch_size_and_length_bucketing_preserve_prediction_order(self) -> None:
        inputs = ["a", "longer input", "mid", "the longest input here", "xy"]

        def predict_batch(batch: list[str]) -> list[float]:
            return [len(value) / 100.0 for value in batch]

        baseline = batched_predict(
            inputs,
            batch_size=1,
            predict_batch=predict_batch,
            bucket_by_length=False,
            length_key=len,
        )
        batched = batched_predict(
            inputs,
            batch_size=4,
            predict_batch=predict_batch,
            bucket_by_length=True,
            length_key=len,
        )

        self.assertEqual(baseline, batched)
        self.assertEqual(batched, [0.01, 0.12, 0.03, 0.22, 0.02])

    def test_predictor_must_return_one_probability_per_input(self) -> None:
        with self.assertRaises(ValueError):
            batched_predict(
                ["a", "b"],
                batch_size=2,
                predict_batch=lambda _batch: [0.5],
            )


if __name__ == "__main__":
    unittest.main()
