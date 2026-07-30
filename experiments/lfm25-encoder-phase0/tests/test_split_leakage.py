from __future__ import annotations

import unittest

from grimodex_lfm_eval.dataset import (
    DatasetValidationError,
    deterministic_negative_sample,
    validate_story_splits,
    validate_unique_ids,
)


class SplitLeakageTests(unittest.TestCase):
    def test_story_cannot_cross_train_and_test(self) -> None:
        records_by_split = {
            "train": [{"id": "train-1", "storyId": "shared-story"}],
            "validation": [{"id": "validation-1", "storyId": "validation-story"}],
            "test": [{"id": "test-1", "storyId": "shared-story"}],
        }

        with self.assertRaisesRegex(DatasetValidationError, "shared-story"):
            validate_story_splits(records_by_split)

    def test_duplicate_stable_id_is_rejected(self) -> None:
        with self.assertRaisesRegex(DatasetValidationError, "duplicate-id"):
            validate_unique_ids(
                [
                    {"id": "duplicate-id", "storyId": "story-a"},
                    {"id": "duplicate-id", "storyId": "story-b"},
                ]
            )

    def test_negative_sampling_is_stable_across_input_order(self) -> None:
        candidates = [
            {"id": "negative-a"},
            {"id": "negative-b"},
            {"id": "negative-c"},
            {"id": "negative-d"},
        ]

        forward = deterministic_negative_sample(candidates, count=2, seed_material="q-1")
        reverse = deterministic_negative_sample(
            list(reversed(candidates)),
            count=2,
            seed_material="q-1",
        )

        self.assertEqual(forward, reverse)


if __name__ == "__main__":
    unittest.main()
