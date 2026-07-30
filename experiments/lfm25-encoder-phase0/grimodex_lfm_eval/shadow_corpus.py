"""Privacy-safe contracts for expanding the Semantic Recall shadow corpus.

The product shadow log contains hashes, ranks, scores, token counts, and
latencies only. Human labels live in ignored private storage and join to that
log by hashes. Aggregate reports intentionally omit every workspace, project,
query, candidate, and scene identifier.
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass
import hashlib
import json
import math
from pathlib import Path
from typing import Annotated, Any, Literal, Mapping, Sequence

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    ValidationError,
    field_validator,
    model_validator,
)


CorpusLanguage = Literal["ja", "en"]
CorpusSplit = Literal["shadow-private-dev", "frozen-holdout"]
ReviewStatus = Literal["unreviewed", "human-verified"]
QueryKind = Literal["positive", "no-match"]
NoMatchType = Literal["out-of-domain", "unsupported-in-workspace"]
CorpusSlice = Literal[
    "question-only",
    "short-tail",
    "near-500-char-tail",
    "truncated-512",
    "topic-mismatch",
    "proper-noun-heavy",
    "long-query",
    "implicit-reference",
    "dialogue-fact",
    "omitted-subject",
    "alias",
    "phase-change",
    "similar-scene",
    "gold-below-dense-10",
    "semantic",
    "morphology",
    "lexical-proper-noun",
    "hard-no-match",
    "same-name-different-character",
    "similar-event-wrong-target",
    "generic-fiction-overlap",
    "proper-noun-only",
    "scene-tail-distractor",
]
Sha256 = Annotated[str, StringConstraints(pattern=r"^[a-f0-9]{64}$")]


class CorpusValidationError(ValueError):
    """Raised when shadow evidence or private labels violate the corpus contract."""


def _to_camel(value: str) -> str:
    head, *tail = value.split("_")
    return head + "".join(part.capitalize() for part in tail)


class _CorpusModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=_to_camel,
        extra="forbid",
        frozen=True,
        populate_by_name=True,
        str_strip_whitespace=True,
    )


class ShadowTokenization(_CorpusModel):
    query_tokens_before: int = Field(ge=0)
    query_tokens_after: int = Field(ge=0, le=512)
    candidate_tokens_before: int = Field(ge=0)
    candidate_tokens_after: int = Field(ge=0, le=512)
    query_truncated: bool
    candidate_truncated: bool
    user_message_tokens_kept: int = Field(ge=0, le=512)
    scene_tail_tokens_kept: int = Field(ge=0, le=512)

    @model_validator(mode="after")
    def validate_token_accounting(self) -> "ShadowTokenization":
        if self.query_tokens_after > self.query_tokens_before:
            raise ValueError("queryTokensAfter cannot exceed queryTokensBefore")
        if self.candidate_tokens_after > self.candidate_tokens_before:
            raise ValueError(
                "candidateTokensAfter cannot exceed candidateTokensBefore"
            )
        if (
            self.user_message_tokens_kept + self.scene_tail_tokens_kept
            > self.query_tokens_after
        ):
            raise ValueError(
                "kept user-message and scene-tail tokens exceed queryTokensAfter"
            )
        return self


class ShadowRanking(_CorpusModel):
    candidate_hash: Sha256
    scene_hash: Sha256
    dense_rank: int = Field(ge=1, le=30)
    current_rank: int = Field(ge=1, le=30)
    reranked_rank: int = Field(ge=1, le=30)
    dense_score: float
    reranker_score: float
    tokenization: ShadowTokenization

    @field_validator("dense_score", "reranker_score")
    @classmethod
    def validate_finite_score(cls, value: float) -> float:
        if not math.isfinite(value):
            raise ValueError("ranking scores must be finite")
        return value


class ShadowComparison(_CorpusModel):
    baseline_scene_order: tuple[Sha256, ...] = Field(max_length=30)
    reranked_scene_order: tuple[Sha256, ...] = Field(max_length=30)
    baseline_injected_scene_ids: tuple[Sha256, ...] = Field(max_length=3)
    counterfactual_injected_scene_ids: tuple[Sha256, ...] = Field(max_length=3)
    baseline_injected_candidate_hashes: tuple[Sha256, ...] = Field(max_length=3)
    counterfactual_injected_candidate_hashes: tuple[Sha256, ...] = Field(
        max_length=3
    )
    injected_set_changed: bool
    injected_order_changed: bool
    first_presented_changed: bool
    gold_candidate_present: bool | None = None
    baseline_gold_position: int | None = Field(default=None, ge=1, le=3)
    counterfactual_gold_position: int | None = Field(default=None, ge=1, le=3)
    baseline_gold_injection_mrr: float | None = Field(
        default=None,
        gt=0,
        le=1,
    )
    counterfactual_gold_injection_mrr: float | None = Field(
        default=None,
        gt=0,
        le=1,
    )
    is_no_match: bool | None = None
    failure_layer: Literal[
        "candidate-generation",
        "ranking",
        "admission",
        "none",
    ] | None = None
    ranking: tuple[ShadowRanking, ...] = Field(min_length=1, max_length=30)

    @model_validator(mode="after")
    def validate_rankings_and_injections(self) -> "ShadowComparison":
        candidate_hashes = [
            candidate.candidate_hash for candidate in self.ranking
        ]
        if len(candidate_hashes) != len(set(candidate_hashes)):
            raise ValueError("candidate hashes must be unique within a query")
        expected_ranks = set(range(1, len(self.ranking) + 1))
        for field_name, label in (
            ("dense_rank", "dense"),
            ("current_rank", "current"),
            ("reranked_rank", "reranker"),
        ):
            observed = {
                int(getattr(candidate, field_name))
                for candidate in self.ranking
            }
            if observed != expected_ranks:
                raise ValueError(
                    f"{label} ranks must be exactly 1 through "
                    f"{len(self.ranking)}"
                )

        known_candidates = set(candidate_hashes)
        for field_name in (
            "baseline_injected_candidate_hashes",
            "counterfactual_injected_candidate_hashes",
        ):
            injected = tuple(getattr(self, field_name))
            if len(injected) != len(set(injected)):
                raise ValueError(f"{field_name} must not contain duplicates")
            unknown = set(injected) - known_candidates
            if unknown:
                raise ValueError(
                    f"{field_name} contains candidates outside the frozen pool"
                )
        if len(self.baseline_injected_scene_ids) != len(
            self.baseline_injected_candidate_hashes
        ):
            raise ValueError("baseline injected scene and candidate counts differ")
        if len(self.counterfactual_injected_scene_ids) != len(
            self.counterfactual_injected_candidate_hashes
        ):
            raise ValueError(
                "counterfactual injected scene and candidate counts differ"
            )
        return self


class ShadowCompletedRecord(_CorpusModel):
    schema_version: Literal[1]
    recorded_at: str = Field(
        min_length=1,
        max_length=64,
        pattern=r"^\d{4}-\d{2}-\d{2}T",
    )
    status: Literal["completed"]
    run_hash: Sha256
    generation: int = Field(ge=1)
    request_hash: Sha256
    workspace_hash: Sha256
    workspace_open_revision: int = Field(ge=0)
    project_hash: Sha256
    language: CorpusLanguage
    local_inference_expected: bool
    main_process_rss_bytes: int = Field(ge=0)
    query_hash: Sha256
    candidate_set_hash: Sha256
    model_id: str = Field(
        min_length=1,
        max_length=256,
        pattern=r"^[A-Za-z0-9._/@:+-]+$",
    )
    model_revision: str = Field(
        min_length=1,
        max_length=256,
        pattern=r"^[A-Za-z0-9._/@:+-]+$",
    )
    manifest_sha256: Sha256
    candidate_count: int = Field(ge=1, le=30)
    retrieval_latency_ms: float | None = Field(default=None, ge=0)
    queue_latency_ms: float | None = Field(default=None, ge=0)
    ipc_round_trip_ms: float | None = Field(default=None, ge=0)
    native_latency_ms: float | None = Field(default=None, ge=0)
    end_to_end_latency_ms: float | None = Field(default=None, ge=0)
    model_load_ms: float | None = Field(default=None, ge=0)
    model_was_cold: bool | None = None
    comparison: ShadowComparison

    @model_validator(mode="after")
    def validate_candidate_count(self) -> "ShadowCompletedRecord":
        if len(self.comparison.ranking) != self.candidate_count:
            raise ValueError(
                "candidateCount must match comparison.ranking length"
            )
        return self


class CandidateJudgment(_CorpusModel):
    candidate_hash: Sha256
    scene_hash: Sha256
    dense_rank: int = Field(ge=1, le=30)
    hybrid_rank: int = Field(ge=1, le=30)
    reranker_rank: int = Field(ge=1, le=30)
    relevance_grade: int | None = Field(default=None, ge=0, le=3)


class ShadowLabelRecord(_CorpusModel):
    schema_version: Literal[1]
    split: CorpusSplit
    work_hash: Sha256
    query_hash: Sha256
    candidate_set_hash: Sha256
    language: CorpusLanguage
    model_id: str = Field(
        min_length=1,
        max_length=256,
        pattern=r"^[A-Za-z0-9._/@:+-]+$",
    )
    model_revision: str = Field(
        min_length=1,
        max_length=256,
        pattern=r"^[A-Za-z0-9._/@:+-]+$",
    )
    manifest_sha256: Sha256
    review_status: ReviewStatus
    query_kind: QueryKind | None = None
    no_match_type: NoMatchType | None = None
    slices: tuple[CorpusSlice, ...] = ()
    reference_scene_hashes: tuple[Sha256, ...] = ()
    judgments: tuple[CandidateJudgment, ...] = Field(min_length=1, max_length=30)

    @model_validator(mode="after")
    def validate_label_contract(self) -> "ShadowLabelRecord":
        judgment_hashes = [
            judgment.candidate_hash for judgment in self.judgments
        ]
        if len(judgment_hashes) != len(set(judgment_hashes)):
            raise ValueError("candidate judgments must be unique")
        if len(self.slices) != len(set(self.slices)):
            raise ValueError("slices must be unique")
        if len(self.reference_scene_hashes) != len(
            set(self.reference_scene_hashes)
        ):
            raise ValueError("referenceSceneHashes must be unique")

        if self.review_status == "unreviewed":
            return self
        if self.query_kind is None:
            raise ValueError(
                "human-verified labels require queryKind"
            )
        if not self.slices:
            raise ValueError("human-verified labels require at least one slice")
        if any(
            judgment.relevance_grade is None
            for judgment in self.judgments
        ):
            raise ValueError(
                "human-verified judgments require relevanceGrade"
            )
        if self.query_kind == "positive":
            if self.no_match_type is not None:
                raise ValueError("positive queries cannot define noMatchType")
            if not self.reference_scene_hashes:
                raise ValueError(
                    "positive queries require referenceSceneHashes"
                )
        else:
            if self.no_match_type is None:
                raise ValueError("no-match queries require noMatchType")
            if self.reference_scene_hashes:
                raise ValueError(
                    "no-match queries cannot define referenceSceneHashes"
                )
            if any(
                judgment.relevance_grade != 0
                for judgment in self.judgments
            ):
                raise ValueError(
                    "no-match candidate judgments must all use grade 0"
                )
        return self


@dataclass(frozen=True)
class PairedShadowCase:
    shadow: ShadowCompletedRecord
    label: ShadowLabelRecord


@dataclass(frozen=True)
class StageTarget:
    positive: int
    no_match: int
    works: int
    holdout_works: int
    requires_frozen_holdout: bool


DEFAULT_STAGE_TARGETS: Mapping[str, StageTarget] = {
    "shadow-initial": StageTarget(
        positive=50,
        no_match=30,
        works=3,
        holdout_works=0,
        requires_frozen_holdout=False,
    ),
    "experimental-opt-in": StageTarget(
        positive=100,
        no_match=60,
        works=4,
        holdout_works=1,
        requires_frozen_holdout=True,
    ),
    "default-candidate": StageTarget(
        positive=200,
        no_match=100,
        works=5,
        holdout_works=2,
        requires_frozen_holdout=True,
    ),
}


class HoldoutLock(_CorpusModel):
    schema_version: Literal[1]
    corpus_schema_version: Literal[1]
    split: Literal["frozen-holdout"]
    case_count: int = Field(ge=1)
    work_count: int = Field(ge=1)
    by_language: dict[CorpusLanguage, int]
    fingerprint_sha256: Sha256


_SAFE_SHADOW_KEYS = {
    "schemaVersion",
    "recordedAt",
    "status",
    "runHash",
    "generation",
    "requestHash",
    "workspaceHash",
    "workspaceOpenRevision",
    "projectHash",
    "language",
    "localInferenceExpected",
    "mainProcessRssBytes",
    "staleReason",
    "errorCode",
    "queryHash",
    "candidateSetHash",
    "modelId",
    "modelRevision",
    "manifestSha256",
    "candidateCount",
    "retrievalLatencyMs",
    "queueLatencyMs",
    "ipcRoundTripMs",
    "nativeLatencyMs",
    "endToEndLatencyMs",
    "modelLoadMs",
    "modelWasCold",
    "comparison",
}
_SHADOW_STATUSES = {"completed", "stale", "suppressed", "failed"}


def load_shadow_log_jsonl(path: Path) -> tuple[ShadowCompletedRecord, ...]:
    """Load completed privacy-sanitized product shadow records.

    Non-completed records remain operational evidence but cannot become corpus
    cases, so this loader validates their top-level safe field allowlist and
    skips them.
    """

    records: list[ShadowCompletedRecord] = []
    try:
        source = path.open("r", encoding="utf-8")
    except OSError as error:
        raise CorpusValidationError(f"cannot read shadow log {path}: {error}") from error
    with source:
        for line_number, line in enumerate(source, start=1):
            stripped = line.strip()
            if not stripped:
                continue
            try:
                payload = json.loads(stripped)
                if not isinstance(payload, dict):
                    raise TypeError("shadow record must be a JSON object")
                unknown = set(payload) - _SAFE_SHADOW_KEYS
                if unknown:
                    raise ValueError(
                        f"unknown shadow field(s): {sorted(unknown)}"
                    )
                status = payload.get("status")
                if status not in _SHADOW_STATUSES:
                    raise ValueError(f"unsupported shadow status: {status!r}")
                if status != "completed":
                    if payload.get("comparison") is not None:
                        raise ValueError(
                            "non-completed shadow records cannot contain comparison"
                        )
                    continue
                records.append(ShadowCompletedRecord.model_validate(payload))
            except (
                json.JSONDecodeError,
                TypeError,
                ValueError,
                ValidationError,
            ) as error:
                raise CorpusValidationError(
                    f"{path}:{line_number}: {error}"
                ) from error
    return tuple(records)


def load_label_jsonl(path: Path) -> tuple[ShadowLabelRecord, ...]:
    labels: list[ShadowLabelRecord] = []
    try:
        source = path.open("r", encoding="utf-8")
    except OSError as error:
        raise CorpusValidationError(f"cannot read label file {path}: {error}") from error
    with source:
        for line_number, line in enumerate(source, start=1):
            stripped = line.strip()
            if not stripped:
                continue
            try:
                labels.append(ShadowLabelRecord.model_validate_json(stripped))
            except ValueError as error:
                raise CorpusValidationError(
                    f"{path}:{line_number}: {error}"
                ) from error
    return tuple(labels)


def _record_identity(
    record: ShadowCompletedRecord,
) -> tuple[str, str]:
    return record.project_hash, record.query_hash


def _record_snapshot(record: ShadowCompletedRecord) -> dict[str, Any]:
    return {
        "workHash": record.project_hash,
        "queryHash": record.query_hash,
        "candidateSetHash": record.candidate_set_hash,
        "language": record.language,
        "modelId": record.model_id,
        "modelRevision": record.model_revision,
        "manifestSha256": record.manifest_sha256,
        "comparison": record.comparison.model_dump(
            by_alias=True,
            mode="json",
        ),
    }


def _unique_records(
    records: Sequence[ShadowCompletedRecord],
) -> dict[tuple[str, str], ShadowCompletedRecord]:
    unique: dict[tuple[str, str], ShadowCompletedRecord] = {}
    for record in records:
        key = _record_identity(record)
        previous = unique.get(key)
        if previous is None:
            unique[key] = record
            continue
        if _record_snapshot(previous) != _record_snapshot(record):
            raise CorpusValidationError(
                "conflicting shadow snapshots exist for one work/query hash"
            )
    return unique


def _judgment_pool(
    record: ShadowCompletedRecord,
) -> tuple[ShadowRanking, ...]:
    pooled = [
        candidate
        for candidate in record.comparison.ranking
        if min(
            candidate.dense_rank,
            candidate.current_rank,
            candidate.reranked_rank,
        )
        <= 10
    ]
    return tuple(
        sorted(
            pooled,
            key=lambda candidate: (
                min(
                    candidate.dense_rank,
                    candidate.current_rank,
                    candidate.reranked_rank,
                ),
                candidate.dense_rank,
                candidate.current_rank,
                candidate.reranked_rank,
                candidate.candidate_hash,
            ),
        )
    )


def build_label_template(
    records: Sequence[ShadowCompletedRecord],
    *,
    split: CorpusSplit,
) -> tuple[ShadowLabelRecord, ...]:
    """Create hash-only draft labels for the three-method top-10 union."""

    unique = _unique_records(records)
    if not unique:
        raise CorpusValidationError(
            "the shadow log contains no completed records"
        )
    labels: list[ShadowLabelRecord] = []
    for record in sorted(
        unique.values(),
        key=lambda item: (item.language, item.project_hash, item.query_hash),
    ):
        truncated = any(
            candidate.tokenization.query_truncated
            or candidate.tokenization.candidate_truncated
            for candidate in record.comparison.ranking
        )
        labels.append(
            ShadowLabelRecord(
                schema_version=1,
                split=split,
                work_hash=record.project_hash,
                query_hash=record.query_hash,
                candidate_set_hash=record.candidate_set_hash,
                language=record.language,
                model_id=record.model_id,
                model_revision=record.model_revision,
                manifest_sha256=record.manifest_sha256,
                review_status="unreviewed",
                query_kind=None,
                no_match_type=None,
                slices=("truncated-512",) if truncated else (),
                reference_scene_hashes=(),
                judgments=tuple(
                    CandidateJudgment(
                        candidate_hash=candidate.candidate_hash,
                        scene_hash=candidate.scene_hash,
                        dense_rank=candidate.dense_rank,
                        hybrid_rank=candidate.current_rank,
                        reranker_rank=candidate.reranked_rank,
                        relevance_grade=None,
                    )
                    for candidate in _judgment_pool(record)
                ),
            )
        )
    return tuple(labels)


def pair_shadow_records(
    records: Sequence[ShadowCompletedRecord],
    labels: Sequence[ShadowLabelRecord],
) -> tuple[PairedShadowCase, ...]:
    """Join private labels to safe shadow evidence and enforce work isolation."""

    indexed_records = _unique_records(records)
    seen_queries: set[str] = set()
    seen_label_keys: set[tuple[str, str]] = set()
    split_by_work: dict[str, CorpusSplit] = {}
    language_by_work: dict[str, CorpusLanguage] = {}
    model_by_language: dict[CorpusLanguage, tuple[str, str, str]] = {}
    cases: list[PairedShadowCase] = []

    for label in labels:
        key = (label.work_hash, label.query_hash)
        if key in seen_label_keys:
            raise CorpusValidationError(
                "duplicate private label for one work/query hash"
            )
        seen_label_keys.add(key)
        if label.query_hash in seen_queries:
            raise CorpusValidationError(
                "duplicate query hash would over-count one query"
            )
        seen_queries.add(label.query_hash)

        record = indexed_records.get(key)
        if record is None:
            raise CorpusValidationError(
                "private label has no matching completed shadow record"
            )
        fixed_fields = (
            ("candidateSetHash", label.candidate_set_hash, record.candidate_set_hash),
            ("language", label.language, record.language),
            ("modelId", label.model_id, record.model_id),
            ("modelRevision", label.model_revision, record.model_revision),
            ("manifestSha256", label.manifest_sha256, record.manifest_sha256),
        )
        for field_name, labelled, observed in fixed_fields:
            if labelled != observed:
                raise CorpusValidationError(
                    f"private label {field_name} does not match shadow evidence"
                )

        expected_pool = {
            candidate.candidate_hash: (
                candidate.scene_hash,
                candidate.dense_rank,
                candidate.current_rank,
                candidate.reranked_rank,
            )
            for candidate in _judgment_pool(record)
        }
        labelled_pool = {
            judgment.candidate_hash: (
                judgment.scene_hash,
                judgment.dense_rank,
                judgment.hybrid_rank,
                judgment.reranker_rank,
            )
            for judgment in label.judgments
        }
        if labelled_pool != expected_pool:
            raise CorpusValidationError(
                "private label judgment pool must equal dense top 10 union "
                "hybrid top 10 union reranker top 10"
            )
        injected = {
            *record.comparison.baseline_injected_candidate_hashes,
            *record.comparison.counterfactual_injected_candidate_hashes,
        }
        if not injected.issubset(labelled_pool):
            raise CorpusValidationError(
                "every injected candidate must be in the human judgment pool"
            )
        if (
            label.review_status == "human-verified"
            and record.candidate_count != 30
        ):
            raise CorpusValidationError(
                "human-verified promotion evidence requires exactly 30 candidates"
            )

        previous_split = split_by_work.setdefault(label.work_hash, label.split)
        if previous_split != label.split:
            raise CorpusValidationError(
                "work leakage: one work appears in shadow-private-dev and "
                "frozen-holdout"
            )
        previous_language = language_by_work.setdefault(
            label.work_hash,
            label.language,
        )
        if previous_language != label.language:
            raise CorpusValidationError(
                "one work cannot contribute multiple corpus languages"
            )
        model_identity = (
            label.model_id,
            label.model_revision,
            label.manifest_sha256,
        )
        previous_model = model_by_language.setdefault(
            label.language,
            model_identity,
        )
        if previous_model != model_identity:
            raise CorpusValidationError(
                "one language report cannot mix model identities, revisions, "
                "or manifests"
            )
        cases.append(PairedShadowCase(shadow=record, label=label))

    return tuple(
        sorted(
            cases,
            key=lambda case: (
                case.label.language,
                case.label.split,
                case.label.work_hash,
                case.label.query_hash,
            ),
        )
    )


def _grade_by_candidate(case: PairedShadowCase) -> dict[str, int]:
    return {
        judgment.candidate_hash: int(judgment.relevance_grade)
        for judgment in case.label.judgments
        if judgment.relevance_grade is not None
    }


def _ranking_recall_at_3(
    case: PairedShadowCase,
    rank_field: Literal["current_rank", "reranked_rank"],
) -> bool:
    grades = _grade_by_candidate(case)
    return any(
        int(getattr(candidate, rank_field)) <= 3
        and grades.get(candidate.candidate_hash, 0) >= 2
        for candidate in case.shadow.comparison.ranking
    )


def _injection_has_relevant(
    case: PairedShadowCase,
    candidate_hashes: Sequence[str],
) -> bool:
    grades = _grade_by_candidate(case)
    return any(
        grades.get(candidate_hash, 0) >= 2
        for candidate_hash in candidate_hashes
    )


def _reference_scene_present(case: PairedShadowCase) -> bool:
    reference = set(case.label.reference_scene_hashes)
    return any(
        candidate.scene_hash in reference
        for candidate in case.shadow.comparison.ranking
    )


def _rate(values: Sequence[bool]) -> float | None:
    if not values:
        return None
    return sum(values) / len(values)


def _quality_summary(
    verified: Sequence[PairedShadowCase],
) -> dict[str, Any]:
    positives = [
        case for case in verified if case.label.query_kind == "positive"
    ]
    no_matches = [
        case for case in verified if case.label.query_kind == "no-match"
    ]
    candidate_present = [
        case for case in positives if _reference_scene_present(case)
    ]
    admission_eligible = [
        case
        for case in candidate_present
        if _ranking_recall_at_3(case, "reranked_rank")
    ]

    def ranking_block(cases: Sequence[PairedShadowCase]) -> dict[str, Any]:
        return {
            "queries": len(cases),
            "baselineRecallAt3": _rate(
                [
                    _ranking_recall_at_3(case, "current_rank")
                    for case in cases
                ]
            ),
            "rerankerRecallAt3": _rate(
                [
                    _ranking_recall_at_3(case, "reranked_rank")
                    for case in cases
                ]
            ),
        }

    return {
        "endToEnd": ranking_block(positives),
        "conditionalReranker": ranking_block(candidate_present),
        "admission": {
            "queries": len(admission_eligible),
            "baselineRelevantInjectionRate": _rate(
                [
                    _injection_has_relevant(
                        case,
                        case.shadow.comparison.baseline_injected_candidate_hashes,
                    )
                    for case in admission_eligible
                ]
            ),
            "rerankerRelevantInjectionRate": _rate(
                [
                    _injection_has_relevant(
                        case,
                        case.shadow.comparison.counterfactual_injected_candidate_hashes,
                    )
                    for case in admission_eligible
                ]
            ),
        },
        "noMatch": {
            "queries": len(no_matches),
            "baselineInjectionRate": _rate(
                [
                    bool(
                        case.shadow.comparison.baseline_injected_candidate_hashes
                    )
                    for case in no_matches
                ]
            ),
            "rerankerInjectionRate": _rate(
                [
                    bool(
                        case.shadow.comparison.counterfactual_injected_candidate_hashes
                    )
                    for case in no_matches
                ]
            ),
        },
    }


def _language_summary(
    cases: Sequence[PairedShadowCase],
    language: CorpusLanguage,
) -> dict[str, Any]:
    selected = [case for case in cases if case.label.language == language]
    verified = [
        case
        for case in selected
        if case.label.review_status == "human-verified"
    ]
    positives = [
        case for case in verified if case.label.query_kind == "positive"
    ]
    no_matches = [
        case for case in verified if case.label.query_kind == "no-match"
    ]
    works = {case.label.work_hash for case in verified}
    holdout_works = {
        case.label.work_hash
        for case in verified
        if case.label.split == "frozen-holdout"
    }
    no_match_types = Counter(
        case.label.no_match_type
        for case in no_matches
        if case.label.no_match_type is not None
    )
    slices = Counter(
        query_slice
        for case in verified
        for query_slice in case.label.slices
    )
    judged_candidates = sum(
        judgment.relevance_grade is not None
        for case in selected
        for judgment in case.label.judgments
    )
    truncated_queries = sum(
        any(
            candidate.tokenization.query_truncated
            or candidate.tokenization.candidate_truncated
            for candidate in case.shadow.comparison.ranking
        )
        for case in verified
    )
    present_count = sum(_reference_scene_present(case) for case in positives)
    return {
        "draftQueries": len(selected) - len(verified),
        "verifiedQueries": len(verified),
        "positive": len(positives),
        "noMatch": len(no_matches),
        "works": len(works),
        "holdoutWorks": len(holdout_works),
        "judgedCandidates": judged_candidates,
        "truncatedQueries": truncated_queries,
        "noMatchTypes": dict(sorted(no_match_types.items())),
        "slices": dict(sorted(slices.items())),
        "candidateGeneration": {
            "positiveQueries": len(positives),
            "referenceScenePresent": present_count,
            "misses": len(positives) - present_count,
        },
        "quality": _quality_summary(verified),
    }


def build_safe_report(
    cases: Sequence[PairedShadowCase],
    *,
    holdout_lock_valid: bool,
    stage_targets: Mapping[str, StageTarget] = DEFAULT_STAGE_TARGETS,
) -> dict[str, Any]:
    """Build an aggregate-only report safe to retain outside private storage."""

    by_language = {
        language: _language_summary(cases, language)
        for language in ("ja", "en")
    }
    readiness: dict[str, dict[str, Any]] = {}
    for stage_name, target in stage_targets.items():
        readiness[stage_name] = {}
        for language in ("ja", "en"):
            observed = by_language[language]
            deficits = {
                "positive": max(0, target.positive - observed["positive"]),
                "noMatch": max(0, target.no_match - observed["noMatch"]),
                "works": max(0, target.works - observed["works"]),
                "holdoutWorks": max(
                    0,
                    target.holdout_works - observed["holdoutWorks"],
                ),
            }
            quantity_ready = not any(deficits.values())
            decision_ready = (
                quantity_ready
                and (
                    not target.requires_frozen_holdout
                    or holdout_lock_valid
                )
            )
            readiness[stage_name][language] = {
                "targets": {
                    "positive": target.positive,
                    "noMatch": target.no_match,
                    "works": target.works,
                    "holdoutWorks": target.holdout_works,
                },
                "observed": {
                    "positive": observed["positive"],
                    "noMatch": observed["noMatch"],
                    "works": observed["works"],
                    "holdoutWorks": observed["holdoutWorks"],
                },
                "deficits": deficits,
                "quantityReady": quantity_ready,
                "decisionReady": decision_ready,
                "requiresFrozenHoldout": target.requires_frozen_holdout,
            }
    return {
        "schemaVersion": 1,
        "privacyBoundary": (
            "aggregate-only; no workspace, project, query, candidate, scene, "
            "path, or manuscript identifiers"
        ),
        "gate2PublicRole": "validation-only",
        "holdoutLockValid": holdout_lock_valid,
        "byLanguage": by_language,
        "stageReadiness": readiness,
    }


def _holdout_payload(
    cases: Sequence[PairedShadowCase],
) -> list[dict[str, Any]]:
    holdout = [
        case
        for case in cases
        if case.label.split == "frozen-holdout"
        and case.label.review_status == "human-verified"
    ]
    if not holdout:
        raise CorpusValidationError(
            "cannot freeze an empty or unreviewed holdout"
        )
    return [
        {
            "shadow": _record_snapshot(case.shadow),
            "label": case.label.model_dump(by_alias=True, mode="json"),
        }
        for case in sorted(
            holdout,
            key=lambda item: (
                item.label.language,
                item.label.work_hash,
                item.label.query_hash,
            ),
        )
    ]


def _holdout_fingerprint(cases: Sequence[PairedShadowCase]) -> str:
    canonical = json.dumps(
        _holdout_payload(cases),
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(canonical).hexdigest()


def create_holdout_lock(
    cases: Sequence[PairedShadowCase],
) -> HoldoutLock:
    payload = _holdout_payload(cases)
    holdout_cases = [
        case
        for case in cases
        if case.label.split == "frozen-holdout"
        and case.label.review_status == "human-verified"
    ]
    by_language: dict[CorpusLanguage, int] = {
        "ja": sum(case.label.language == "ja" for case in holdout_cases),
        "en": sum(case.label.language == "en" for case in holdout_cases),
    }
    return HoldoutLock(
        schema_version=1,
        corpus_schema_version=1,
        split="frozen-holdout",
        case_count=len(payload),
        work_count=len(
            {case.label.work_hash for case in holdout_cases}
        ),
        by_language=by_language,
        fingerprint_sha256=_holdout_fingerprint(cases),
    )


def verify_holdout_lock(
    cases: Sequence[PairedShadowCase],
    lock: HoldoutLock,
) -> None:
    current = create_holdout_lock(cases)
    if current != lock:
        raise CorpusValidationError(
            "frozen holdout fingerprint or counts changed"
        )
