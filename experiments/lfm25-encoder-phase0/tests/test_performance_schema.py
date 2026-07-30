from __future__ import annotations

import unittest

from pydantic import ValidationError

from grimodex_lfm_eval.benchmark import (
    classify_speed_gate,
    summarize_timing_samples,
)
from grimodex_lfm_eval.performance_schema import (
    GateVerdict,
    TimingMeasurement,
    Workload,
)


class PerformanceSchemaTests(unittest.TestCase):
    def test_warmup_values_are_not_included_in_summary(self) -> None:
        summary = summarize_timing_samples(
            [100.0, 200.0] + [float(value) for value in range(1, 31)],
            warmup_count=2,
            minimum_samples=30,
            bootstrap_iterations=100,
            random_seed=42,
        )

        self.assertEqual(summary.sample_count, 30)
        self.assertEqual(summary.maximum_seconds, 30.0)
        self.assertLess(summary.p95_seconds, 30.0)

    def test_too_few_samples_for_p95_is_rejected(self) -> None:
        with self.assertRaises(ValueError):
            summarize_timing_samples(
                [0.1] * 29,
                warmup_count=0,
                minimum_samples=30,
            )

    def test_measurement_enforces_short_input_sample_floor(self) -> None:
        with self.assertRaises(ValidationError):
            TimingMeasurement.model_validate(
                {
                    "workload": "single_pair",
                    "inputTokens": 1024,
                    "candidateCount": 1,
                    "batchSize": 1,
                    "threadCount": 1,
                    "bucketed": False,
                    "warmupCount": 2,
                    "timing": {
                        "sampleCount": 29,
                        "p50Seconds": 0.1,
                        "p95Seconds": 0.2,
                        "maximumSeconds": 0.3,
                        "bootstrap95Ci": [0.15, 0.25],
                    },
                }
            )

    def test_workload_speed_budgets_map_to_verdicts(self) -> None:
        self.assertEqual(
            classify_speed_gate(Workload.RELEVANCE, candidate_count=30, p95_seconds=1.9),
            GateVerdict.TARGET,
        )
        self.assertEqual(
            classify_speed_gate(Workload.RELEVANCE, candidate_count=30, p95_seconds=3.0),
            GateVerdict.CONDITIONAL,
        )
        self.assertEqual(
            classify_speed_gate(Workload.RELEVANCE, candidate_count=30, p95_seconds=6.0),
            GateVerdict.HOLD,
        )
        self.assertEqual(
            classify_speed_gate(Workload.RELEVANCE, candidate_count=30, p95_seconds=8.1),
            GateVerdict.REJECT,
        )
        self.assertEqual(
            classify_speed_gate(Workload.IMPACT, candidate_count=30, p95_seconds=4.9),
            GateVerdict.TARGET,
        )


if __name__ == "__main__":
    unittest.main()
