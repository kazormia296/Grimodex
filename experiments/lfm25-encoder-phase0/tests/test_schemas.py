from __future__ import annotations

import unittest

from pydantic import ValidationError

from grimodex_lfm_eval.schemas import ImpactRecord, RelevancePair


COMMON_PROVENANCE = {
    "language": "ja",
    "storyId": "story-01",
    "source": "synthetic",
    "generatorVersion": "phase0-test-v1",
    "reviewStatus": "human-verified",
    "license": "synthetic",
}


class SchemaTests(unittest.TestCase):
    def test_relevance_pair_round_trips_camel_case_contract(self) -> None:
        pair = RelevancePair.model_validate(
            {
                **COMMON_PROVENANCE,
                "id": "relevance-001",
                "task": "relevance",
                "queryId": "query-001",
                "query": "朱紐に触れたときの記憶",
                "candidateText": "朱音が紐に触れると、知らない記憶が流れ込んだ。",
                "relevanceGrade": 2,
            }
        )

        dumped = pair.model_dump(mode="json", by_alias=True)

        self.assertEqual(dumped["storyId"], "story-01")
        self.assertEqual(dumped["queryId"], "query-001")
        self.assertEqual(dumped["relevanceGrade"], 2)

    def test_impact_span_must_match_scene_text_exactly(self) -> None:
        with self.assertRaises(ValidationError):
            ImpactRecord.model_validate(
                {
                    **COMMON_PROVENANCE,
                    "id": "impact-001",
                    "task": "impact",
                    "entry": {
                        "id": "character-akane",
                        "name": "朱音",
                        "type": "character",
                    },
                    "diffPayload": {"change_id": "change-001"},
                    "sceneText": "朱音は剣を握ったことがない。",
                    "label": 1,
                    "affectedSpans": [
                        {
                            "text": "剣を握った",
                            "start": 0,
                            "end": 5,
                        }
                    ],
                    "difficulty": ["direct-contradiction"],
                }
            )

    def test_positive_impact_record_requires_an_affected_span(self) -> None:
        with self.assertRaises(ValidationError):
            ImpactRecord.model_validate(
                {
                    **COMMON_PROVENANCE,
                    "id": "impact-002",
                    "task": "impact",
                    "entry": {
                        "id": "character-akane",
                        "name": "朱音",
                        "type": "character",
                    },
                    "diffPayload": {"change_id": "change-002"},
                    "sceneText": "朱音は剣を握ったことがない。",
                    "label": 1,
                    "affectedSpans": [],
                    "difficulty": ["direct-contradiction"],
                }
            )

    def test_private_source_requires_private_license(self) -> None:
        with self.assertRaises(ValidationError):
            RelevancePair.model_validate(
                {
                    **COMMON_PROVENANCE,
                    "id": "private-001",
                    "task": "relevance",
                    "source": "private",
                    "license": "project-owned",
                    "queryId": "query-private",
                    "query": "secret",
                    "candidateText": "secret scene",
                    "relevanceGrade": 1,
                }
            )


if __name__ == "__main__":
    unittest.main()
