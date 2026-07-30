from __future__ import annotations

import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from pydantic import ValidationError

from grimodex_lfm_eval.shadow_corpus import (
    CorpusValidationError,
    ShadowLabelRecord,
    StageTarget,
    build_label_template,
    build_safe_report,
    create_holdout_lock,
    load_shadow_log_jsonl,
    pair_shadow_records,
    verify_holdout_lock,
)


def _hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _ranking(
    *,
    relevant_scene_rank: int | None = 1,
    reverse_reranker: bool = False,
) -> list[dict[str, object]]:
    rows: list[dict[str, object]] = []
    for dense_rank in range(1, 31):
        reranked_rank = 31 - dense_rank if reverse_reranker else dense_rank
        rows.append(
            {
                "candidateHash": _hash(f"candidate-{dense_rank}"),
                "sceneHash": _hash(
                    "reference-scene"
                    if dense_rank == relevant_scene_rank
                    else f"scene-{dense_rank}"
                ),
                "denseRank": dense_rank,
                "currentRank": dense_rank,
                "rerankedRank": reranked_rank,
                "denseScore": 1.0 - dense_rank / 100,
                "rerankerScore": float(31 - reranked_rank),
                "tokenization": {
                    "queryTokensBefore": 180,
                    "queryTokensAfter": 180,
                    "candidateTokensBefore": 350,
                    "candidateTokensAfter": 329,
                    "queryTruncated": False,
                    "candidateTruncated": dense_rank == 30,
                    "userMessageTokensKept": 40,
                    "sceneTailTokensKept": 140,
                },
            }
        )
    return sorted(rows, key=lambda row: int(row["rerankedRank"]))


def _shadow_record(
    *,
    query_name: str = "query-a",
    project_name: str = "work-a",
    language: str = "ja",
    relevant_scene_rank: int | None = 1,
    reverse_reranker: bool = False,
    baseline_injected_ranks: tuple[int, ...] = (1, 2, 3),
    reranked_injected_ranks: tuple[int, ...] = (1, 2, 3),
) -> dict[str, object]:
    ranking = _ranking(
        relevant_scene_rank=relevant_scene_rank,
        reverse_reranker=reverse_reranker,
    )
    by_dense_rank = {
        int(row["denseRank"]): row for row in ranking
    }
    return {
        "schemaVersion": 1,
        "recordedAt": "2026-07-30T00:00:00.000Z",
        "status": "completed",
        "runHash": _hash(f"run-{query_name}"),
        "generation": 1,
        "requestHash": _hash(f"request-{query_name}"),
        "workspaceHash": _hash(f"workspace-{project_name}"),
        "workspaceOpenRevision": 1,
        "projectHash": _hash(project_name),
        "language": language,
        "localInferenceExpected": False,
        "mainProcessRssBytes": 100_000_000,
        "queryHash": _hash(query_name),
        "candidateSetHash": _hash(f"candidates-{query_name}"),
        "modelId": (
            "hotchpotch/japanese-reranker-xsmall-v2"
            if language == "ja"
            else "cross-encoder/ms-marco-MiniLM-L4-v2"
        ),
        "modelRevision": _hash(f"revision-{language}"),
        "manifestSha256": _hash(f"manifest-{language}"),
        "candidateCount": 30,
        "retrievalLatencyMs": 25,
        "queueLatencyMs": 2,
        "ipcRoundTripMs": 900,
        "nativeLatencyMs": 850,
        "endToEndLatencyMs": 930,
        "modelLoadMs": 0,
        "modelWasCold": False,
        "comparison": {
            "baselineSceneOrder": [
                str(by_dense_rank[rank]["sceneHash"]) for rank in range(1, 31)
            ],
            "rerankedSceneOrder": [
                str(row["sceneHash"]) for row in ranking
            ],
            "baselineInjectedSceneIds": [
                str(by_dense_rank[rank]["sceneHash"])
                for rank in baseline_injected_ranks
            ],
            "counterfactualInjectedSceneIds": [
                str(by_dense_rank[rank]["sceneHash"])
                for rank in reranked_injected_ranks
            ],
            "baselineInjectedCandidateHashes": [
                str(by_dense_rank[rank]["candidateHash"])
                for rank in baseline_injected_ranks
            ],
            "counterfactualInjectedCandidateHashes": [
                str(by_dense_rank[rank]["candidateHash"])
                for rank in reranked_injected_ranks
            ],
            "injectedSetChanged": (
                set(baseline_injected_ranks) != set(reranked_injected_ranks)
            ),
            "injectedOrderChanged": (
                baseline_injected_ranks != reranked_injected_ranks
            ),
            "firstPresentedChanged": (
                baseline_injected_ranks[0] != reranked_injected_ranks[0]
            ),
            "ranking": ranking,
        },
    }


def _load_records(*records: dict[str, object]):
    with tempfile.TemporaryDirectory() as temporary_directory:
        path = Path(temporary_directory) / "shadow.jsonl"
        path.write_text(
            "".join(f"{json.dumps(record)}\n" for record in records),
            encoding="utf-8",
        )
        return load_shadow_log_jsonl(path)


def _verified_label(
    draft: ShadowLabelRecord,
    *,
    query_kind: str = "positive",
    no_match_type: str | None = None,
    split: str | None = None,
    work_family_name: str | None = None,
    relevant_candidate_hash: str | None = None,
    reference_scene_hashes: tuple[str, ...] = (_hash("reference-scene"),),
    slices: tuple[str, ...] = ("long-query", "truncated-512"),
) -> ShadowLabelRecord:
    payload = draft.model_dump(by_alias=True)
    payload["workFamilyHash"] = _hash(
        work_family_name or f"family-{draft.work_hash}"
    )
    payload["reviewStatus"] = "human-verified"
    payload["queryKind"] = query_kind
    payload["noMatchType"] = no_match_type
    payload["slices"] = list(slices)
    payload["referenceSceneHashes"] = list(reference_scene_hashes)
    if split is not None:
        payload["split"] = split
    for judgment in payload["judgments"]:
        judgment["relevanceGrade"] = (
            3
            if judgment["candidateHash"] == relevant_candidate_hash
            else 0
        )
    return ShadowLabelRecord.model_validate(payload)


class ShadowCorpusLogContractTests(unittest.TestCase):
    def test_template_pools_dense_hybrid_and_reranker_top_ten_without_text(
        self,
    ) -> None:
        records = _load_records(
            _shadow_record(reverse_reranker=True),
            {
                **_shadow_record(query_name="stale-query"),
                "status": "stale",
                "comparison": None,
            },
        )

        labels = build_label_template(
            records,
            split="shadow-private-dev",
        )

        self.assertEqual(len(labels), 1)
        candidate_hashes = {
            judgment.candidate_hash for judgment in labels[0].judgments
        }
        self.assertEqual(
            candidate_hashes,
            {
                *(_hash(f"candidate-{rank}") for rank in range(1, 11)),
                *(_hash(f"candidate-{rank}") for rank in range(21, 31)),
            },
        )
        serialized = labels[0].model_dump_json(by_alias=True)
        self.assertNotIn("userMessage", serialized)
        self.assertNotIn("sceneTail", serialized)
        self.assertNotIn("candidateText", serialized)
        self.assertNotIn("manuscript", serialized)

    def test_completed_log_rejects_unknown_manuscript_fields(self) -> None:
        payload = _shadow_record()
        payload["manuscriptText"] = "private prose"

        with self.assertRaisesRegex(CorpusValidationError, "manuscriptText"):
            _load_records(payload)

    def test_completed_log_requires_exact_dense_current_and_reranker_ranks(
        self,
    ) -> None:
        payload = _shadow_record()
        comparison = payload["comparison"]
        assert isinstance(comparison, dict)
        ranking = comparison["ranking"]
        assert isinstance(ranking, list)
        ranking[0]["denseRank"] = 2

        with self.assertRaisesRegex(CorpusValidationError, "dense ranks"):
            _load_records(payload)


class ShadowCorpusLabelContractTests(unittest.TestCase):
    def test_verified_label_requires_complete_union_judgments(self) -> None:
        records = _load_records(_shadow_record())
        draft = build_label_template(
            records,
            split="shadow-private-dev",
        )[0]
        payload = draft.model_dump(by_alias=True)
        payload["workFamilyHash"] = _hash("story-family")
        payload["reviewStatus"] = "human-verified"
        payload["queryKind"] = "positive"
        payload["slices"] = ["question-only"]
        payload["referenceSceneHashes"] = [_hash("reference-scene")]

        with self.assertRaisesRegex(ValidationError, "relevanceGrade"):
            ShadowLabelRecord.model_validate(payload)

    def test_verified_label_requires_a_human_assigned_work_family(self) -> None:
        records = _load_records(_shadow_record())
        draft = build_label_template(
            records,
            split="shadow-private-dev",
        )[0]
        payload = _verified_label(
            draft,
            relevant_candidate_hash=_hash("candidate-1"),
        ).model_dump(by_alias=True)
        payload["workFamilyHash"] = None

        with self.assertRaisesRegex(ValidationError, "workFamilyHash"):
            ShadowLabelRecord.model_validate(payload)

    def test_no_match_requires_a_type_and_only_zero_grades(self) -> None:
        records = _load_records(
            _shadow_record(relevant_scene_rank=None),
        )
        draft = build_label_template(
            records,
            split="shadow-private-dev",
        )[0]
        relevant_hash = draft.judgments[0].candidate_hash

        with self.assertRaisesRegex(ValidationError, "noMatchType"):
            _verified_label(
                draft,
                query_kind="no-match",
                no_match_type=None,
                relevant_candidate_hash=None,
                reference_scene_hashes=(),
            )
        with self.assertRaisesRegex(ValidationError, "grade 0"):
            _verified_label(
                draft,
                query_kind="no-match",
                no_match_type="unsupported-in-workspace",
                relevant_candidate_hash=relevant_hash,
                reference_scene_hashes=(),
            )

    def test_pairing_rejects_work_leakage_between_dev_and_holdout(self) -> None:
        records = _load_records(
            _shadow_record(query_name="query-a", project_name="shared-work"),
            _shadow_record(query_name="query-b", project_name="shared-work"),
        )
        drafts = build_label_template(
            records,
            split="shadow-private-dev",
        )
        labels = [
            _verified_label(drafts[0]),
            _verified_label(drafts[1], split="frozen-holdout"),
        ]

        with self.assertRaisesRegex(CorpusValidationError, "work leakage"):
            pair_shadow_records(records, labels)

    def test_pairing_rejects_derived_projects_from_one_work_family_across_splits(
        self,
    ) -> None:
        records = _load_records(
            _shadow_record(query_name="query-a", project_name="copy-a"),
            _shadow_record(query_name="query-b", project_name="copy-b"),
        )
        drafts = build_label_template(
            records,
            split="shadow-private-dev",
        )
        labels = [
            _verified_label(
                drafts[0],
                work_family_name="shared-story-family",
            ),
            _verified_label(
                drafts[1],
                split="frozen-holdout",
                work_family_name="shared-story-family",
            ),
        ]

        with self.assertRaisesRegex(CorpusValidationError, "work family leakage"):
            pair_shadow_records(records, labels)

    def test_pairing_allows_the_same_query_in_independent_work_families(
        self,
    ) -> None:
        records = _load_records(
            _shadow_record(
                query_name="shared-question",
                project_name="independent-work-a",
            ),
            _shadow_record(
                query_name="shared-question",
                project_name="independent-work-b",
            ),
        )
        drafts = build_label_template(
            records,
            split="shadow-private-dev",
        )
        labels = [
            _verified_label(
                draft,
                work_family_name=f"family-{draft.work_hash}",
            )
            for draft in drafts
        ]

        self.assertEqual(len(pair_shadow_records(records, labels)), 2)

    def test_pairing_rejects_the_same_query_within_one_work_family(
        self,
    ) -> None:
        records = _load_records(
            _shadow_record(
                query_name="shared-question",
                project_name="derived-copy-a",
            ),
            _shadow_record(
                query_name="shared-question",
                project_name="derived-copy-b",
            ),
        )
        drafts = build_label_template(
            records,
            split="shadow-private-dev",
        )
        labels = [
            _verified_label(
                draft,
                work_family_name="shared-story-family",
            )
            for draft in drafts
        ]

        with self.assertRaisesRegex(
            CorpusValidationError,
            "duplicate query hash within one work family",
        ):
            pair_shadow_records(records, labels)

    def test_pairing_rejects_missing_or_extra_top_ten_union_candidates(self) -> None:
        records = _load_records(_shadow_record(reverse_reranker=True))
        draft = build_label_template(
            records,
            split="shadow-private-dev",
        )[0]
        payload = _verified_label(
            draft,
            relevant_candidate_hash=_hash("candidate-1"),
        ).model_dump(by_alias=True)
        payload["judgments"] = payload["judgments"][:-1]
        incomplete = ShadowLabelRecord.model_validate(payload)

        with self.assertRaisesRegex(CorpusValidationError, "judgment pool"):
            pair_shadow_records(records, [incomplete])


class ShadowCorpusReportTests(unittest.TestCase):
    def test_report_separates_candidate_generation_conditional_and_end_to_end(
        self,
    ) -> None:
        records = _load_records(
            _shadow_record(
                query_name="present",
                project_name="work-present",
                relevant_scene_rank=1,
            ),
            _shadow_record(
                query_name="candidate-miss",
                project_name="work-miss",
                relevant_scene_rank=None,
            ),
            _shadow_record(
                query_name="no-match",
                project_name="work-no-match",
                relevant_scene_rank=None,
                baseline_injected_ranks=(1, 2, 3),
                reranked_injected_ranks=(1, 2, 3),
            ),
        )
        drafts = build_label_template(
            records,
            split="shadow-private-dev",
        )
        labels = [
            _verified_label(
                drafts[0],
                relevant_candidate_hash=_hash("candidate-1"),
            ),
            _verified_label(
                drafts[1],
                relevant_candidate_hash=None,
            ),
            _verified_label(
                drafts[2],
                query_kind="no-match",
                no_match_type="unsupported-in-workspace",
                reference_scene_hashes=(),
            ),
        ]
        cases = pair_shadow_records(records, labels)

        report = build_safe_report(cases, holdout_lock_valid=False)
        japanese = report["byLanguage"]["ja"]

        self.assertEqual(
            japanese["candidateGeneration"],
            {
                "positiveQueries": 2,
                "referenceScenePresent": 1,
                "misses": 1,
            },
        )
        self.assertEqual(japanese["quality"]["endToEnd"]["queries"], 2)
        self.assertEqual(
            japanese["quality"]["conditionalReranker"]["queries"],
            1,
        )
        self.assertEqual(japanese["quality"]["noMatch"]["queries"], 1)
        self.assertEqual(
            japanese["quality"]["noMatch"]["rerankerInjectionRate"],
            1.0,
        )

    def test_admission_uses_method_specific_and_common_denominators(
        self,
    ) -> None:
        records = _load_records(
            _shadow_record(
                query_name="baseline-only",
                project_name="work-baseline",
                relevant_scene_rank=1,
                reverse_reranker=True,
                baseline_injected_ranks=(1,),
                reranked_injected_ranks=(30,),
            ),
            _shadow_record(
                query_name="reranker-only",
                project_name="work-reranker",
                relevant_scene_rank=30,
                reverse_reranker=True,
                baseline_injected_ranks=(1,),
                reranked_injected_ranks=(30,),
            ),
            _shadow_record(
                query_name="common",
                project_name="work-common",
                relevant_scene_rank=1,
                baseline_injected_ranks=(1,),
                reranked_injected_ranks=(1,),
            ),
        )
        drafts = build_label_template(
            records,
            split="shadow-private-dev",
        )
        relevant_rank_by_query = {
            _hash("baseline-only"): 1,
            _hash("reranker-only"): 30,
            _hash("common"): 1,
        }
        labels = [
            _verified_label(
                draft,
                relevant_candidate_hash=_hash(
                    f"candidate-{relevant_rank_by_query[draft.query_hash]}"
                ),
            )
            for draft in drafts
        ]

        admission = build_safe_report(
            pair_shadow_records(records, labels),
            holdout_lock_valid=False,
        )["byLanguage"]["ja"]["quality"]["admission"]

        self.assertEqual(admission["baseline"]["queries"], 2)
        self.assertEqual(admission["reranker"]["queries"], 2)
        self.assertEqual(admission["common"]["queries"], 1)
        self.assertEqual(
            admission["common"]["baselineRelevantInjectionRate"],
            1.0,
        )
        self.assertEqual(
            admission["common"]["rerankerRelevantInjectionRate"],
            1.0,
        )

    def test_report_is_aggregate_only_and_exposes_stage_deficits(self) -> None:
        record = _shadow_record(
            query_name="private-query-name",
            project_name="private-work-name",
        )
        records = _load_records(record)
        draft = build_label_template(
            records,
            split="shadow-private-dev",
        )[0]
        label = _verified_label(
            draft,
            relevant_candidate_hash=_hash("candidate-1"),
        )
        cases = pair_shadow_records(records, [label])

        report = build_safe_report(cases, holdout_lock_valid=False)
        serialized = json.dumps(report, ensure_ascii=False)
        readiness = report["stageReadiness"]["shadow-initial"]["ja"]

        self.assertEqual(report["schemaVersion"], 2)
        self.assertFalse(readiness["quantityReady"])
        self.assertEqual(readiness["deficits"]["positive"], 49)
        self.assertEqual(readiness["deficits"]["noMatch"], 30)
        self.assertEqual(readiness["deficits"]["works"], 2)
        self.assertNotIn(record["projectHash"], serialized)
        self.assertNotIn(record["queryHash"], serialized)
        self.assertNotIn(record["candidateSetHash"], serialized)
        self.assertNotIn(label.work_family_hash, serialized)
        self.assertNotIn("private-query-name", serialized)
        self.assertNotIn("private-work-name", serialized)
        self.assertNotIn("decisionReady", serialized)

    def test_evidence_readiness_requires_holdout_query_floors(self) -> None:
        records = _load_records(
            _shadow_record(query_name="dev-positive", project_name="dev"),
            _shadow_record(
                query_name="dev-no-match",
                project_name="dev",
                relevant_scene_rank=None,
            ),
            _shadow_record(query_name="holdout-a", project_name="holdout-a"),
            _shadow_record(query_name="holdout-b", project_name="holdout-b"),
        )
        drafts = build_label_template(
            records,
            split="shadow-private-dev",
        )
        labels = []
        for draft in drafts:
            if draft.query_hash == _hash("dev-no-match"):
                labels.append(
                    _verified_label(
                        draft,
                        query_kind="no-match",
                        no_match_type="unsupported-in-workspace",
                        work_family_name="dev-family",
                        reference_scene_hashes=(),
                    )
                )
                continue
            is_holdout = draft.query_hash in {
                _hash("holdout-a"),
                _hash("holdout-b"),
            }
            labels.append(
                _verified_label(
                    draft,
                    split="frozen-holdout" if is_holdout else None,
                    work_family_name=(
                        draft.query_hash if is_holdout else "dev-family"
                    ),
                    relevant_candidate_hash=_hash("candidate-1"),
                )
            )

        report = build_safe_report(
            pair_shadow_records(records, labels),
            holdout_lock_valid=True,
            stage_targets={
                "review": StageTarget(
                    positive=3,
                    no_match=1,
                    works=3,
                    holdout_works=2,
                    holdout_positive=1,
                    holdout_no_match=1,
                    max_work_contribution=1.0,
                    requires_frozen_holdout=True,
                )
            },
        )
        readiness = report["stageReadiness"]["review"]["ja"]

        self.assertTrue(readiness["quantityReady"])
        self.assertFalse(readiness["holdoutReady"])
        self.assertTrue(readiness["contributionReady"])
        self.assertFalse(readiness["evidenceReady"])
        self.assertEqual(readiness["deficits"]["holdoutNoMatch"], 1)
        self.assertNotIn("decisionReady", readiness)

    def test_evidence_readiness_caps_one_work_family_contribution(self) -> None:
        records = _load_records(
            *(
                _shadow_record(
                    query_name=f"query-{index}",
                    project_name=f"project-{index}",
                )
                for index in range(4)
            )
        )
        drafts = build_label_template(
            records,
            split="shadow-private-dev",
        )
        labels = [
            _verified_label(
                draft,
                work_family_name=(
                    "dominant-family" if index < 3 else "minor-family"
                ),
                relevant_candidate_hash=_hash("candidate-1"),
            )
            for index, draft in enumerate(drafts)
        ]
        report = build_safe_report(
            pair_shadow_records(records, labels),
            holdout_lock_valid=False,
            stage_targets={
                "review": StageTarget(
                    positive=4,
                    no_match=0,
                    works=2,
                    holdout_works=0,
                    holdout_positive=0,
                    holdout_no_match=0,
                    max_work_contribution=0.5,
                    requires_frozen_holdout=False,
                )
            },
        )
        readiness = report["stageReadiness"]["review"]["ja"]

        self.assertTrue(readiness["quantityReady"])
        self.assertTrue(readiness["holdoutReady"])
        self.assertFalse(readiness["contributionReady"])
        self.assertFalse(readiness["evidenceReady"])
        self.assertEqual(
            readiness["observed"]["maxPositiveFamilyContribution"],
            0.75,
        )

    def test_contribution_readiness_caps_positive_and_no_match_separately(
        self,
    ) -> None:
        records = _load_records(
            *(
                _shadow_record(
                    query_name=f"positive-{index}",
                    project_name=f"positive-work-{index}",
                )
                for index in range(4)
            ),
            _shadow_record(
                query_name="no-match-a",
                project_name="no-match-work-a",
                relevant_scene_rank=None,
            ),
            _shadow_record(
                query_name="no-match-b",
                project_name="no-match-work-b",
                relevant_scene_rank=None,
            ),
        )
        drafts = build_label_template(
            records,
            split="shadow-private-dev",
        )
        labels = []
        no_match_hashes = {_hash("no-match-a"), _hash("no-match-b")}
        for draft in drafts:
            if draft.query_hash in no_match_hashes:
                labels.append(
                    _verified_label(
                        draft,
                        query_kind="no-match",
                        no_match_type="unsupported-in-workspace",
                        work_family_name="no-match-monopoly",
                        reference_scene_hashes=(),
                    )
                )
            else:
                labels.append(
                    _verified_label(
                        draft,
                        work_family_name=f"family-{draft.work_hash}",
                        relevant_candidate_hash=_hash("candidate-1"),
                    )
                )

        report = build_safe_report(
            pair_shadow_records(records, labels),
            holdout_lock_valid=False,
            stage_targets={
                "review": StageTarget(
                    positive=4,
                    no_match=2,
                    works=5,
                    holdout_works=0,
                    holdout_positive=0,
                    holdout_no_match=0,
                    max_work_contribution=0.5,
                    requires_frozen_holdout=False,
                )
            },
        )
        readiness = report["stageReadiness"]["review"]["ja"]

        self.assertTrue(readiness["quantityReady"])
        self.assertEqual(
            readiness["observed"]["maxPositiveFamilyContribution"],
            0.25,
        )
        self.assertEqual(
            readiness["observed"]["maxNoMatchFamilyContribution"],
            1.0,
        )
        self.assertFalse(readiness["contributionReady"])
        self.assertFalse(readiness["evidenceReady"])

    def test_contribution_readiness_caps_holdout_query_kinds_separately(
        self,
    ) -> None:
        query_specs = (
            ("holdout-positive-a", "holdout", "positive"),
            ("holdout-positive-b", "holdout", "positive"),
            ("dev-positive-a", "dev", "positive"),
            ("dev-positive-b", "dev", "positive"),
            ("holdout-no-match-a", "holdout", "no-match"),
            ("holdout-no-match-b", "holdout", "no-match"),
            ("dev-no-match-a", "dev", "no-match"),
            ("dev-no-match-b", "dev", "no-match"),
        )
        records = _load_records(
            *(
                _shadow_record(
                    query_name=query_name,
                    project_name=f"project-{query_name}",
                    relevant_scene_rank=(
                        None if query_kind == "no-match" else 1
                    ),
                )
                for query_name, _split, query_kind in query_specs
            )
        )
        specs_by_hash = {
            _hash(query_name): (query_name, split, query_kind)
            for query_name, split, query_kind in query_specs
        }
        drafts = build_label_template(
            records,
            split="shadow-private-dev",
        )
        labels = []
        for draft in drafts:
            query_name, split, query_kind = specs_by_hash[draft.query_hash]
            family_name = (
                f"monopoly-{query_kind}"
                if split == "holdout"
                else f"family-{query_name}"
            )
            labels.append(
                _verified_label(
                    draft,
                    query_kind=query_kind,
                    no_match_type=(
                        "unsupported-in-workspace"
                        if query_kind == "no-match"
                        else None
                    ),
                    split=(
                        "frozen-holdout"
                        if split == "holdout"
                        else None
                    ),
                    work_family_name=family_name,
                    relevant_candidate_hash=(
                        _hash("candidate-1")
                        if query_kind == "positive"
                        else None
                    ),
                    reference_scene_hashes=(
                        (_hash("reference-scene"),)
                        if query_kind == "positive"
                        else ()
                    ),
                )
            )

        report = build_safe_report(
            pair_shadow_records(records, labels),
            holdout_lock_valid=True,
            stage_targets={
                "review": StageTarget(
                    positive=4,
                    no_match=4,
                    works=6,
                    holdout_works=2,
                    holdout_positive=2,
                    holdout_no_match=2,
                    max_work_contribution=0.5,
                    requires_frozen_holdout=True,
                )
            },
        )
        readiness = report["stageReadiness"]["review"]["ja"]

        self.assertTrue(readiness["quantityReady"])
        self.assertTrue(readiness["holdoutReady"])
        self.assertEqual(
            readiness["observed"]["maxPositiveFamilyContribution"],
            0.5,
        )
        self.assertEqual(
            readiness["observed"]["maxNoMatchFamilyContribution"],
            0.5,
        )
        self.assertEqual(
            readiness["observed"][
                "maxHoldoutPositiveFamilyContribution"
            ],
            1.0,
        )
        self.assertEqual(
            readiness["observed"][
                "maxHoldoutNoMatchFamilyContribution"
            ],
            1.0,
        )
        self.assertFalse(readiness["contributionReady"])
        self.assertFalse(readiness["evidenceReady"])

    def test_evidence_readiness_requires_named_slice_floors(self) -> None:
        records = _load_records(
            _shadow_record(
                query_name="positive",
                project_name="positive-work",
            ),
            _shadow_record(
                query_name="no-match",
                project_name="no-match-work",
                relevant_scene_rank=None,
            ),
        )
        drafts = build_label_template(
            records,
            split="shadow-private-dev",
        )
        labels = []
        for draft in drafts:
            if draft.query_hash == _hash("no-match"):
                labels.append(
                    _verified_label(
                        draft,
                        query_kind="no-match",
                        no_match_type="unsupported-in-workspace",
                        reference_scene_hashes=(),
                        slices=("question-only",),
                    )
                )
            else:
                labels.append(
                    _verified_label(
                        draft,
                        relevant_candidate_hash=_hash("candidate-1"),
                        slices=("question-only",),
                    )
                )

        target = StageTarget(
            positive=1,
            no_match=1,
            works=2,
            holdout_works=0,
            holdout_positive=0,
            holdout_no_match=0,
            max_work_contribution=1.0,
            requires_frozen_holdout=False,
            slice_minimums={
                "hard-no-match": 1,
                "scene-tail-distractor": 1,
                "truncated-512": 1,
                "similar-scene": 1,
            },
        )
        report = build_safe_report(
            pair_shadow_records(records, labels),
            holdout_lock_valid=False,
            stage_targets={"review": target},
        )
        readiness = report["stageReadiness"]["review"]["ja"]

        self.assertTrue(readiness["quantityReady"])
        self.assertTrue(readiness["contributionReady"])
        self.assertFalse(readiness["sliceReady"])
        self.assertFalse(readiness["evidenceReady"])
        self.assertEqual(
            readiness["deficits"]["slices"],
            {
                "hard-no-match": 1,
                "scene-tail-distractor": 1,
                "similar-scene": 1,
                "truncated-512": 1,
            },
        )

        covered_labels = []
        for draft in drafts:
            if draft.query_hash == _hash("no-match"):
                covered_labels.append(
                    _verified_label(
                        draft,
                        query_kind="no-match",
                        no_match_type="unsupported-in-workspace",
                        reference_scene_hashes=(),
                        slices=(
                            "hard-no-match",
                            "scene-tail-distractor",
                            "truncated-512",
                        ),
                    )
                )
            else:
                covered_labels.append(
                    _verified_label(
                        draft,
                        relevant_candidate_hash=_hash("candidate-1"),
                        slices=("similar-scene",),
                    )
                )
        covered = build_safe_report(
            pair_shadow_records(records, covered_labels),
            holdout_lock_valid=False,
            stage_targets={"review": target},
        )["stageReadiness"]["review"]["ja"]
        self.assertTrue(covered["sliceReady"])
        self.assertTrue(covered["evidenceReady"])

    def test_holdout_lock_detects_label_or_ranking_drift(self) -> None:
        records = _load_records(
            _shadow_record(
                query_name="holdout-query",
                project_name="holdout-work",
            ),
        )
        draft = build_label_template(
            records,
            split="frozen-holdout",
        )[0]
        label = _verified_label(
            draft,
            relevant_candidate_hash=_hash("candidate-1"),
        )
        cases = pair_shadow_records(records, [label])
        lock = create_holdout_lock(cases)

        verify_holdout_lock(cases, lock)

        changed_payload = label.model_dump(by_alias=True)
        changed_payload["judgments"][0]["relevanceGrade"] = 2
        changed = ShadowLabelRecord.model_validate(changed_payload)
        changed_cases = pair_shadow_records(records, [changed])
        with self.assertRaisesRegex(CorpusValidationError, "fingerprint"):
            verify_holdout_lock(changed_cases, lock)


if __name__ == "__main__":
    unittest.main()
