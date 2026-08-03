from __future__ import annotations

from pathlib import Path
import unittest

from pydantic import ValidationError

from grimodex_lfm_eval.impact_gate31 import (
    aggregate_scene_scores,
    load_impact_gate31_config,
    load_impact_gate31_workload,
    summarize_window_plan,
    window_token_ids,
)
from grimodex_lfm_eval.shadow_corpus import (
    NO_MATCH_ONLY_SLICES,
    CandidateJudgment,
    ShadowLabelRecord,
)


EXPERIMENT_ROOT = Path(__file__).resolve().parents[1]
CONFIG_PATH = EXPERIMENT_ROOT / "configs" / "phase0b-impact-gate31.yaml"


def _verified_label(
    *,
    query_kind: str,
    slices: tuple[str, ...],
) -> ShadowLabelRecord:
    return ShadowLabelRecord(
        schema_version=1,
        split="shadow-private-dev",
        work_family_hash="a" * 64,
        work_hash="b" * 64,
        query_hash="c" * 64,
        candidate_set_hash="d" * 64,
        language="ja",
        model_id="example/model",
        model_revision="1" * 40,
        manifest_sha256="e" * 64,
        review_status="human-verified",
        query_kind=query_kind,
        no_match_type=(
            "unsupported-in-workspace" if query_kind == "no-match" else None
        ),
        slices=slices,
        reference_scene_hashes=(
            () if query_kind == "no-match" else ("f" * 64,)
        ),
        judgments=(
            CandidateJudgment(
                candidate_hash="0" * 64,
                scene_hash="1" * 64,
                dense_rank=1,
                hybrid_rank=1,
                reranker_rank=1,
                relevance_grade=0 if query_kind == "no-match" else 3,
            ),
        ),
    )


class ShadowSliceQueryKindTests(unittest.TestCase):
    def test_no_match_only_slices_reject_human_verified_positive_labels(
        self,
    ) -> None:
        self.assertEqual(
            NO_MATCH_ONLY_SLICES,
            frozenset(
                {
                    "hard-no-match",
                    "same-name-different-character",
                    "similar-event-wrong-target",
                    "generic-fiction-overlap",
                    "proper-noun-only",
                    "scene-tail-distractor",
                }
            ),
        )
        for query_slice in sorted(NO_MATCH_ONLY_SLICES):
            with self.subTest(query_slice=query_slice):
                with self.assertRaisesRegex(
                    ValidationError,
                    "no-match-only slice",
                ):
                    _verified_label(
                        query_kind="positive",
                        slices=(query_slice,),
                    )

    def test_no_match_only_slices_accept_human_verified_no_match_labels(
        self,
    ) -> None:
        for query_slice in sorted(NO_MATCH_ONLY_SLICES):
            with self.subTest(query_slice=query_slice):
                label = _verified_label(
                    query_kind="no-match",
                    slices=(query_slice,),
                )
                self.assertEqual(label.query_kind, "no-match")


class ImpactGate31ContractTests(unittest.TestCase):
    def test_config_freezes_full_scene_and_cap_stress_contracts(self) -> None:
        config = load_impact_gate31_config(CONFIG_PATH)

        self.assertEqual(config.schema_version, 1)
        self.assertEqual(config.benchmark.max_pair_tokens, 512)
        self.assertEqual(config.benchmark.query_token_budget, 128)
        self.assertEqual(config.benchmark.scene_window_tokens, 384)
        self.assertEqual(config.benchmark.scene_window_stride, 256)
        self.assertEqual(config.benchmark.full_scene_count, 30)
        self.assertEqual(config.benchmark.cap_stress_window_count, 30)
        self.assertEqual(config.benchmark.repetitions, 30)
        self.assertEqual(config.benchmark.target_seconds, 5.0)

    def test_workload_contains_thirty_distinct_full_product_scenes(self) -> None:
        config = load_impact_gate31_config(CONFIG_PATH)
        workload = load_impact_gate31_workload(CONFIG_PATH, config)

        self.assertEqual(len(workload.scenes), 30)
        self.assertEqual(
            len({scene.scene_id for scene in workload.scenes}),
            30,
        )
        self.assertTrue(all(scene.plain_text.strip() for scene in workload.scenes))
        self.assertTrue(
            all(scene.source_content_sha256 for scene in workload.scenes)
        )
        self.assertEqual(workload.selection.dense_fetch, 60)
        self.assertEqual(workload.selection.inferred_limit, 30)
        self.assertEqual(
            workload.selection.explicit_link_policy,
            "retain-and-bypass-classifier",
        )
        self.assertEqual(workload.selection.selected_inferred_scene_count, 30)
        self.assertEqual(workload.selection.explicit_scene_count, 0)
        self.assertEqual(
            workload.provenance.plain_text_extractor,
            "src/lib/prosemirror.ts#prosemirrorToText",
        )

    def test_scene_windowing_covers_every_token_without_blind_truncation(
        self,
    ) -> None:
        tokens = list(range(800))

        windows = window_token_ids(tokens, window_size=384, stride=256)

        self.assertEqual(
            [len(window) for window in windows],
            [384, 384, 288],
        )
        self.assertEqual(windows[0], tuple(range(0, 384)))
        self.assertEqual(windows[1], tuple(range(256, 640)))
        self.assertEqual(windows[2], tuple(range(512, 800)))
        self.assertEqual(
            set().union(*(set(window) for window in windows)),
            set(tokens),
        )

    def test_window_plan_reports_required_scene_distribution_and_tokens(
        self,
    ) -> None:
        plans = {
            "scene-a": window_token_ids(
                list(range(800)),
                window_size=384,
                stride=256,
            ),
            "scene-b": window_token_ids(
                list(range(100)),
                window_size=384,
                stride=256,
            ),
        }

        summary = summarize_window_plan(plans)

        self.assertEqual(summary["sceneCount"], 2)
        self.assertEqual(summary["windowCount"], 4)
        self.assertEqual(summary["windowsPerScene"]["p50"], 2.0)
        self.assertEqual(summary["windowsPerScene"]["p95"], 2.9)
        self.assertEqual(summary["windowsPerScene"]["max"], 3)
        self.assertEqual(summary["sceneTokens"], 900)
        self.assertEqual(summary["windowSceneTokens"], 1156)
        self.assertEqual(summary["truncatedSceneCount"], 0)

    def test_scene_score_is_the_maximum_of_all_window_scores(self) -> None:
        scores = aggregate_scene_scores(
            ("scene-a", "scene-a", "scene-b", "scene-a"),
            (0.2, 0.9, -0.1, 0.5),
        )

        self.assertEqual(scores, {"scene-a": 0.9, "scene-b": -0.1})

    def test_cap_stress_contract_is_exactly_thirty_full_windows(self) -> None:
        config = load_impact_gate31_config(CONFIG_PATH)
        windows = [
            tuple(range(config.benchmark.scene_window_tokens))
            for _ in range(config.benchmark.cap_stress_window_count)
        ]

        self.assertEqual(len(windows), 30)
        self.assertTrue(all(len(window) == 384 for window in windows))


if __name__ == "__main__":
    unittest.main()
