from __future__ import annotations

import json
from pathlib import Path
import tempfile
import unittest

from pydantic import ValidationError

from grimodex_lfm_eval.reranker_gate2 import (
    Gate2Candidate,
    Gate2Query,
    ParityPair,
    compare_candidate_depths,
    compare_to_hybrid,
    evaluate_logit_parity,
    evaluate_method,
    load_gate2_jsonl,
    load_parity_jsonl,
    rank_candidates,
    select_injected_candidates,
)
from grimodex_lfm_eval.reranker_phase0b import load_phase0b_config


CONFIG_PATH = (
    Path(__file__).resolve().parents[1] / "configs" / "phase0b-rerankers.yaml"
)


def _candidates(
    *,
    relevant_rank: int = 4,
    relevant_scene: str = "scene-gold",
) -> list[Gate2Candidate]:
    candidates: list[Gate2Candidate] = []
    for rank in range(1, 31):
        is_relevant = rank == relevant_rank
        scene_id = relevant_scene if is_relevant else f"scene-{rank:02d}"
        candidates.append(
            Gate2Candidate(
                candidate_id=f"candidate-{rank:02d}",
                scene_id=scene_id,
                scene_title="Gold scene" if is_relevant else f"Scene {rank:02d}",
                chunk_text=f"Passage {rank}",
                char_start=rank * 10,
                char_end=rank * 10 + 9,
                dense_score=0.90 - rank / 1000,
                dense_rank=rank,
                sparse_rank=rank if rank <= 10 else None,
                rrf_rank=rank,
                relevant=is_relevant,
            )
        )
    return candidates


def _query(
    *,
    query_id: str = "ja-001",
    relevant_rank: int = 4,
    query_slice: str = "semantic",
) -> Gate2Query:
    expected = [] if query_slice == "no_match" else ["Gold scene"]
    return Gate2Query(
        schema_version=1,
        query_id=query_id,
        language="ja",
        query="失踪した王女が港へ向かった場面",
        query_slice=query_slice,
        expected_scene_titles=expected,
        min_score=0.80,
        gate_score=0.85,
        rescue_margin=0.05,
        candidates=_candidates(relevant_rank=relevant_rank)
        if expected
        else [
            candidate.model_copy(update={"relevant": False})
            for candidate in _candidates(relevant_rank=relevant_rank)
        ],
    )


class Gate2ReferenceConfigTests(unittest.TestCase):
    def test_every_model_pins_a_separate_official_reference_onnx(self) -> None:
        config = load_phase0b_config(CONFIG_PATH)

        for model in config.models:
            with self.subTest(model=model.key):
                self.assertEqual(model.reference.artifact, "onnx/model.onnx")
                self.assertEqual(len(model.reference.artifact_sha256), 64)
                self.assertNotEqual(
                    model.reference.local_snapshot,
                    model.local_snapshot,
                )
                self.assertIn(model.reference.artifact, model.reference.files)


class Gate2DatasetContractTests(unittest.TestCase):
    def test_query_requires_one_fixed_top30_candidate_set(self) -> None:
        query = _query()

        self.assertEqual(len(query.candidates), 30)
        self.assertEqual(
            {candidate.dense_rank for candidate in query.candidates},
            set(range(1, 31)),
        )
        self.assertEqual(
            {candidate.rrf_rank for candidate in query.candidates},
            set(range(1, 31)),
        )

    def test_duplicate_rank_and_label_drift_are_rejected(self) -> None:
        candidates = _candidates()
        duplicate_rank = candidates[1].model_copy(update={"dense_rank": 1})
        with self.assertRaisesRegex(ValidationError, "dense ranks"):
            _query().model_copy(
                update={"candidates": [candidates[0], duplicate_rank, *candidates[2:]]}
            ).model_validate(
                {
                    **_query().model_dump(),
                    "candidates": [
                        candidates[0].model_dump(),
                        duplicate_rank.model_dump(),
                        *[candidate.model_dump() for candidate in candidates[2:]],
                    ],
                }
            )

        mislabeled = candidates[0].model_copy(update={"relevant": True})
        with self.assertRaisesRegex(ValidationError, "relevant"):
            Gate2Query.model_validate(
                {
                    **_query().model_dump(),
                    "candidates": [
                        mislabeled.model_dump(),
                        *[candidate.model_dump() for candidate in candidates[1:]],
                    ],
                }
            )

    def test_jsonl_loader_rejects_duplicate_query_ids(self) -> None:
        line = _query().model_dump_json(by_alias=True)
        with tempfile.TemporaryDirectory() as temporary_directory:
            path = Path(temporary_directory) / "candidates.jsonl"
            path.write_text(f"{line}\n{line}\n", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "duplicate query"):
                load_gate2_jsonl(path)

    def test_parity_loader_requires_a_positive_and_negative_per_group(self) -> None:
        rows = [
            {
                "pairId": "positive-only",
                "groupId": "group",
                "query": "query",
                "passage": "passage",
                "relevant": True,
            }
        ]
        with tempfile.TemporaryDirectory() as temporary_directory:
            path = Path(temporary_directory) / "pairs.jsonl"
            path.write_text(
                "\n".join(json.dumps(row) for row in rows) + "\n",
                encoding="utf-8",
            )
            with self.assertRaisesRegex(ValueError, "positive and negative"):
                load_parity_jsonl(path)


class Gate2RankingAndInjectionTests(unittest.TestCase):
    def test_reranker_only_reorders_the_frozen_candidate_ids(self) -> None:
        query = _query()
        scores = {
            candidate.candidate_id: float(index)
            for index, candidate in enumerate(query.candidates)
        }

        reranked = rank_candidates(query, method="reranker", scores=scores)

        self.assertEqual(
            {candidate.candidate_id for candidate in reranked},
            {candidate.candidate_id for candidate in query.candidates},
        )
        self.assertEqual(reranked[0].candidate_id, "candidate-30")

    def test_reranker_does_not_bypass_the_existing_admission_gate(self) -> None:
        query = _query()
        inadmissible = query.candidates[-1].model_copy(
            update={
                "candidate_id": "inadmissible",
                "dense_score": 0.10,
                "sparse_rank": None,
            }
        )
        candidates = [*query.candidates[:-1], inadmissible]
        query = Gate2Query.model_validate(
            {
                **query.model_dump(),
                "candidates": [
                    {
                        **candidate.model_dump(),
                        "dense_rank": index,
                        "rrf_rank": index,
                    }
                    for index, candidate in enumerate(candidates, start=1)
                ],
            }
        )
        scores = {candidate.candidate_id: 0.0 for candidate in query.candidates}
        scores["inadmissible"] = 100.0

        ranking = rank_candidates(query, method="reranker", scores=scores)
        injected = select_injected_candidates(query, ranking, hybrid=True)

        self.assertNotIn("inadmissible", [candidate.candidate_id for candidate in injected])

    def test_injection_prioritizes_distinct_scenes_then_backfills(self) -> None:
        query = _query()
        first = query.candidates[0].model_copy(
            update={"scene_id": "same", "scene_title": "Same"}
        )
        second = query.candidates[1].model_copy(
            update={"scene_id": "same", "scene_title": "Same"}
        )
        third = query.candidates[2].model_copy(
            update={"scene_id": "other", "scene_title": "Other"}
        )
        remaining = [
            candidate.model_copy(
                update={"dense_score": 0.10, "sparse_rank": None}
            )
            for candidate in query.candidates[3:]
        ]
        query = Gate2Query.model_validate(
            {
                **query.model_dump(),
                "candidates": [
                    first.model_dump(),
                    second.model_dump(),
                    third.model_dump(),
                    *[candidate.model_dump() for candidate in remaining],
                ],
            }
        )
        scores = {
            candidate.candidate_id: 100.0 - index
            for index, candidate in enumerate(query.candidates)
        }

        ranking = rank_candidates(query, method="reranker", scores=scores)
        injected = select_injected_candidates(query, ranking, hybrid=True)

        self.assertEqual(
            [candidate.candidate_id for candidate in injected],
            [first.candidate_id, third.candidate_id, second.candidate_id],
        )


class Gate2MetricsTests(unittest.TestCase):
    def test_evaluation_reports_chunk_scene_and_injection_metrics(self) -> None:
        query = _query(relevant_rank=4)
        hybrid = evaluate_method([query], method="rrf")
        scores = {candidate.candidate_id: 0.0 for candidate in query.candidates}
        scores["candidate-04"] = 10.0
        reranked = evaluate_method(
            [query],
            method="reranker",
            scores_by_query={query.query_id: scores},
        )

        self.assertAlmostEqual(hybrid.chunk.mrr, 0.25)
        self.assertAlmostEqual(hybrid.scene.mrr, 0.25)
        self.assertEqual(hybrid.queries[0].positive_chunk_rank, 4)
        self.assertEqual(reranked.chunk.mrr, 1.0)
        self.assertEqual(reranked.scene.recall_at_1, 1.0)
        self.assertEqual(reranked.injection.gold_scene_inclusion, 1.0)
        self.assertGreaterEqual(reranked.injection.junk_injection_rate, 0.0)

    def test_scene_recall_is_binary_when_a_query_has_multiple_gold_scenes(self) -> None:
        candidates = _candidates(relevant_rank=4)
        candidates[0] = candidates[0].model_copy(
            update={
                "scene_id": "scene-second-gold",
                "scene_title": "Second gold scene",
                "relevant": True,
            }
        )
        query = Gate2Query(
            schema_version=1,
            query_id="ja-multi-gold",
            language="ja",
            query="二つの正解場面のどちらか",
            query_slice="semantic",
            expected_scene_titles=["Gold scene", "Second gold scene"],
            min_score=0.80,
            gate_score=0.85,
            rescue_margin=0.05,
            candidates=candidates,
        )

        result = evaluate_method([query], method="rrf")

        self.assertEqual(result.scene.recall_at_1, 1.0)
        self.assertEqual(result.scene.recall_at_3, 1.0)

    def test_quality_gate_uses_paired_bootstrap_and_counts_query_changes(self) -> None:
        queries = [
            _query(query_id=f"ja-{index:03d}", relevant_rank=4)
            for index in range(1, 21)
        ]
        baseline = evaluate_method(queries, method="rrf")
        scores_by_query = {
            query.query_id: {
                candidate.candidate_id: (
                    10.0 if candidate.relevant else -float(candidate.rrf_rank)
                )
                for candidate in query.candidates
            }
            for query in queries
        }
        reranked = evaluate_method(
            queries,
            method="reranker",
            scores_by_query=scores_by_query,
        )

        comparison = compare_to_hybrid(
            baseline,
            reranked,
            bootstrap_iterations=500,
            seed=20260730,
        )

        self.assertTrue(comparison.promote)
        self.assertGreaterEqual(comparison.delta_mrr, 0.05)
        self.assertEqual(comparison.improved_queries, 20)
        self.assertEqual(comparison.worsened_queries, 0)
        self.assertIn("mrr", comparison.paired_bootstrap)

    def test_top30_reports_rescues_below_twelve_and_added_hard_negatives(self) -> None:
        query = _query(relevant_rank=20)
        scores = {
            candidate.candidate_id: (
                10.0 if candidate.relevant else -float(candidate.rrf_rank)
            )
            for candidate in query.candidates
        }

        comparison = compare_candidate_depths(
            [query],
            scores_by_query={query.query_id: scores},
        )

        self.assertEqual(comparison.rescued_below_12, 1)
        self.assertEqual(comparison.rescue_query_ids, [query.query_id])
        self.assertEqual(comparison.added_candidates, 18)
        self.assertEqual(comparison.added_hard_negatives, 17)


class Gate2ParityTests(unittest.TestCase):
    def test_logit_parity_checks_direction_and_near_identical_ranking(self) -> None:
        pairs = [
            ParityPair(
                pair_id=f"pair-{index}-{label}",
                group_id=f"group-{index}",
                relevant=label == "positive",
            )
            for index in range(6)
            for label in ("positive", "negative")
        ]
        reference: dict[str, float] = {}
        quantized: dict[str, float] = {}
        for index in range(6):
            reference[f"pair-{index}-positive"] = 2.0 + index
            reference[f"pair-{index}-negative"] = -2.0 - index
            quantized[f"pair-{index}-positive"] = 1.9 + index
            quantized[f"pair-{index}-negative"] = -1.9 - index

        report = evaluate_logit_parity(
            pairs,
            reference_scores=reference,
            quantized_scores=quantized,
            tokenization_matches=True,
            token_type_ids_verified=True,
        )

        self.assertTrue(report.passed)
        self.assertEqual(report.positive_direction_failures, [])
        self.assertGreaterEqual(report.pairwise_ranking_agreement, 0.9)

    def test_parity_rejects_a_reversed_positive_negative_pair(self) -> None:
        pairs = [
            ParityPair(pair_id="p", group_id="g", relevant=True),
            ParityPair(pair_id="n", group_id="g", relevant=False),
        ]
        report = evaluate_logit_parity(
            pairs,
            reference_scores={"p": 1.0, "n": -1.0},
            quantized_scores={"p": -1.0, "n": 1.0},
            tokenization_matches=True,
            token_type_ids_verified=True,
        )

        self.assertFalse(report.passed)
        self.assertEqual(report.positive_direction_failures, ["g"])


if __name__ == "__main__":
    unittest.main()
