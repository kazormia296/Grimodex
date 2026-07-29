"""Fixed-candidate quality contracts for the Phase 0b Gate 2 reranker study."""

from __future__ import annotations

from dataclasses import dataclass
import json
import math
from pathlib import Path
import random
from typing import Literal, Mapping, Sequence

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from .metrics import ranking_metrics


Gate2Method = Literal["dense", "rrf", "reranker"]
Gate2Slice = Literal["semantic", "lexical", "morphology", "no_match"]


def _to_camel(value: str) -> str:
    head, *tail = value.split("_")
    return head + "".join(part.capitalize() for part in tail)


class _Gate2Model(BaseModel):
    model_config = ConfigDict(
        alias_generator=_to_camel,
        extra="forbid",
        frozen=True,
        populate_by_name=True,
    )


class Gate2Candidate(_Gate2Model):
    candidate_id: str = Field(min_length=1)
    scene_id: str = Field(min_length=1)
    scene_title: str = Field(min_length=1)
    chunk_text: str = Field(min_length=1)
    char_start: int = Field(ge=0)
    char_end: int = Field(gt=0)
    dense_score: float
    dense_rank: int = Field(ge=1, le=30)
    sparse_rank: int | None = Field(default=None, ge=1, le=10)
    rrf_rank: int = Field(ge=1, le=30)
    relevant: bool

    @field_validator("dense_score")
    @classmethod
    def validate_dense_score(cls, value: float) -> float:
        if not math.isfinite(value):
            raise ValueError("dense score must be finite")
        return value

    @model_validator(mode="after")
    def validate_span(self) -> "Gate2Candidate":
        if self.char_end <= self.char_start:
            raise ValueError("charEnd must be greater than charStart")
        return self


class Gate2Query(_Gate2Model):
    schema_version: Literal[1]
    query_id: str = Field(min_length=1)
    language: Literal["ja", "en"]
    query: str = Field(min_length=1)
    query_slice: Gate2Slice = Field(alias="slice")
    expected_scene_titles: tuple[str, ...]
    min_score: float
    gate_score: float
    rescue_margin: float = Field(ge=0.0)
    candidates: tuple[Gate2Candidate, ...] = Field(min_length=30, max_length=30)

    @field_validator("min_score", "gate_score")
    @classmethod
    def validate_threshold(cls, value: float) -> float:
        if not math.isfinite(value):
            raise ValueError("admission thresholds must be finite")
        return value

    @model_validator(mode="after")
    def validate_fixed_candidate_contract(self) -> "Gate2Query":
        candidate_ids = [candidate.candidate_id for candidate in self.candidates]
        if len(candidate_ids) != len(set(candidate_ids)):
            raise ValueError("candidate ids must be unique within a query")
        dense_ranks = {candidate.dense_rank for candidate in self.candidates}
        if dense_ranks != set(range(1, 31)):
            raise ValueError("dense ranks must be exactly 1 through 30")
        rrf_ranks = {candidate.rrf_rank for candidate in self.candidates}
        if rrf_ranks != set(range(1, 31)):
            raise ValueError("RRF ranks must be exactly 1 through 30")

        expected = set(self.expected_scene_titles)
        if len(expected) != len(self.expected_scene_titles):
            raise ValueError("expected scene titles must be unique")
        for candidate in self.candidates:
            should_be_relevant = candidate.scene_title in expected
            if candidate.relevant != should_be_relevant:
                raise ValueError(
                    "candidate relevant label must match expected scene titles"
                )
        if self.query_slice == "no_match" and expected:
            raise ValueError("no_match queries cannot name an expected scene")
        if self.query_slice != "no_match" and not expected:
            raise ValueError("positive queries must name an expected scene")
        return self


class ParityCase(_Gate2Model):
    pair_id: str = Field(min_length=1)
    group_id: str = Field(min_length=1)
    query: str = Field(min_length=1)
    passage: str = Field(min_length=1)
    relevant: bool


def load_gate2_jsonl(path: Path) -> list[Gate2Query]:
    records: list[Gate2Query] = []
    seen: set[str] = set()
    with path.open("r", encoding="utf-8") as source:
        for line_number, line in enumerate(source, start=1):
            stripped = line.strip()
            if not stripped:
                continue
            try:
                payload = json.loads(stripped)
                record = Gate2Query.model_validate(payload)
            except (json.JSONDecodeError, ValueError) as error:
                raise ValueError(f"{path}:{line_number}: {error}") from error
            if record.query_id in seen:
                raise ValueError(f"duplicate query id: {record.query_id}")
            seen.add(record.query_id)
            records.append(record)
    if not records:
        raise ValueError(f"Gate 2 candidate file is empty: {path}")
    return records


def load_parity_jsonl(
    path: Path,
    *,
    expected_pair_count: int | None = None,
) -> list[ParityCase]:
    records: list[ParityCase] = []
    seen: set[str] = set()
    with path.open("r", encoding="utf-8") as source:
        for line_number, line in enumerate(source, start=1):
            stripped = line.strip()
            if not stripped:
                continue
            try:
                record = ParityCase.model_validate_json(stripped)
            except ValueError as error:
                raise ValueError(f"{path}:{line_number}: {error}") from error
            if record.pair_id in seen:
                raise ValueError(f"duplicate parity pair id: {record.pair_id}")
            seen.add(record.pair_id)
            records.append(record)
    if not records:
        raise ValueError(f"parity pair file is empty: {path}")
    if expected_pair_count is not None and len(records) != expected_pair_count:
        raise ValueError(
            f"parity needs exactly {expected_pair_count} fixed pairs, "
            f"found {len(records)}"
        )
    grouped: dict[str, list[ParityCase]] = {}
    for record in records:
        grouped.setdefault(record.group_id, []).append(record)
    for group_id, members in sorted(grouped.items()):
        if not any(member.relevant for member in members) or not any(
            not member.relevant for member in members
        ):
            raise ValueError(
                f"parity group {group_id} needs positive and negative pairs"
            )
    return records


def rank_candidates(
    query: Gate2Query,
    *,
    method: Gate2Method,
    scores: Mapping[str, float] | None = None,
    candidate_limit: Literal[12, 30] = 30,
) -> list[Gate2Candidate]:
    if candidate_limit not in (12, 30):
        raise ValueError("Gate 2 candidate limit must be 12 or 30")
    selected = [
        candidate
        for candidate in query.candidates
        if candidate.rrf_rank <= candidate_limit
    ]
    if method == "dense":
        return sorted(
            selected,
            key=lambda candidate: (candidate.dense_rank, candidate.candidate_id),
        )
    if method == "rrf":
        return sorted(
            selected,
            key=lambda candidate: (candidate.rrf_rank, candidate.candidate_id),
        )
    if method != "reranker":
        raise ValueError(f"unknown Gate 2 method: {method}")
    if scores is None:
        raise ValueError("reranker scores are required")
    selected_ids = {candidate.candidate_id for candidate in selected}
    missing = selected_ids - set(scores)
    if missing:
        raise ValueError(f"reranker scores are missing candidates: {sorted(missing)}")
    invalid = [
        candidate_id
        for candidate_id in selected_ids
        if not math.isfinite(float(scores[candidate_id]))
    ]
    if invalid:
        raise ValueError(f"reranker scores must be finite: {sorted(invalid)}")
    return sorted(
        selected,
        key=lambda candidate: (
            -float(scores[candidate.candidate_id]),
            candidate.rrf_rank,
            candidate.candidate_id,
        ),
    )


def select_injected_candidates(
    query: Gate2Query,
    ranking: Sequence[Gate2Candidate],
    *,
    hybrid: bool,
    max_chunks: int = 3,
) -> list[Gate2Candidate]:
    """Apply the existing dense admission policy, then distinct-scene backfill."""

    if max_chunks <= 0:
        return []
    dense_pass = (
        bool(query.candidates)
        and max(candidate.dense_score for candidate in query.candidates)
        >= query.gate_score
    )
    rescue_floor = query.min_score - query.rescue_margin
    eligible: list[Gate2Candidate] = []
    for candidate in ranking:
        dense_confident = candidate.dense_score >= query.min_score
        sparse_rescue = (
            hybrid
            and candidate.sparse_rank is not None
            and candidate.dense_score >= rescue_floor
        )
        if sparse_rescue or (dense_pass and dense_confident):
            eligible.append(candidate)
    if not eligible:
        return []

    distinct: list[Gate2Candidate] = []
    backfill: list[Gate2Candidate] = []
    seen_scenes: set[str] = set()
    for candidate in eligible:
        if candidate.scene_id in seen_scenes:
            backfill.append(candidate)
        else:
            seen_scenes.add(candidate.scene_id)
            distinct.append(candidate)
    return [*distinct, *backfill][:max_chunks]


@dataclass(frozen=True)
class QueryEvaluation:
    query_id: str
    query_slice: Gate2Slice
    positive_chunk_rank: int | None
    chunk_reciprocal_rank: float
    chunk_ndcg_at_3: float
    scene_reciprocal_rank: float
    scene_recall_at_1: float
    scene_recall_at_3: float
    injected_candidate_ids: tuple[str, ...]
    injected_scene_ids: tuple[str, ...]
    gold_scene_included: bool
    injected_junk_count: int
    is_no_match: bool


@dataclass(frozen=True)
class ChunkAggregate:
    mrr: float
    ndcg_at_3: float


@dataclass(frozen=True)
class SceneAggregate:
    recall_at_1: float
    recall_at_3: float
    mrr: float


@dataclass(frozen=True)
class InjectionAggregate:
    gold_scene_inclusion: float
    junk_injection_rate: float
    no_match_injection_rate: float


@dataclass(frozen=True)
class MethodEvaluation:
    method: Gate2Method
    candidate_limit: int
    chunk: ChunkAggregate
    scene: SceneAggregate
    injection: InjectionAggregate
    queries: tuple[QueryEvaluation, ...]


def _mean(values: Sequence[float]) -> float:
    return sum(values) / len(values) if values else 0.0


def _evaluate_query(
    query: Gate2Query,
    ranking: Sequence[Gate2Candidate],
    *,
    hybrid: bool,
) -> QueryEvaluation:
    chunk_grades = [int(candidate.relevant) for candidate in ranking]
    chunk_metrics = ranking_metrics(chunk_grades, k_values=(3,))
    positive_chunk_rank = next(
        (
            rank
            for rank, candidate in enumerate(ranking, start=1)
            if candidate.relevant
        ),
        None,
    )

    scene_relevance: list[int] = []
    seen_scenes: set[str] = set()
    for candidate in ranking:
        if candidate.scene_id in seen_scenes:
            continue
        seen_scenes.add(candidate.scene_id)
        scene_relevance.append(int(candidate.relevant))
    first_relevant_scene_rank = next(
        (
            rank
            for rank, grade in enumerate(scene_relevance, start=1)
            if grade > 0
        ),
        None,
    )

    injected = select_injected_candidates(query, ranking, hybrid=hybrid)
    gold_included = any(candidate.relevant for candidate in injected)
    junk_count = sum(not candidate.relevant for candidate in injected)
    return QueryEvaluation(
        query_id=query.query_id,
        query_slice=query.query_slice,
        positive_chunk_rank=positive_chunk_rank,
        chunk_reciprocal_rank=chunk_metrics.reciprocal_rank,
        chunk_ndcg_at_3=chunk_metrics.ndcg_at[3],
        scene_reciprocal_rank=(
            1.0 / first_relevant_scene_rank
            if first_relevant_scene_rank is not None
            else 0.0
        ),
        scene_recall_at_1=float(first_relevant_scene_rank == 1),
        scene_recall_at_3=float(
            first_relevant_scene_rank is not None
            and first_relevant_scene_rank <= 3
        ),
        injected_candidate_ids=tuple(
            candidate.candidate_id for candidate in injected
        ),
        injected_scene_ids=tuple(candidate.scene_id for candidate in injected),
        gold_scene_included=gold_included,
        injected_junk_count=junk_count,
        is_no_match=not query.expected_scene_titles,
    )


def evaluate_method(
    queries: Sequence[Gate2Query],
    *,
    method: Gate2Method,
    scores_by_query: Mapping[str, Mapping[str, float]] | None = None,
    candidate_limit: Literal[12, 30] = 30,
) -> MethodEvaluation:
    if not queries:
        raise ValueError("Gate 2 evaluation requires queries")
    query_ids = [query.query_id for query in queries]
    if len(query_ids) != len(set(query_ids)):
        raise ValueError("Gate 2 evaluation query ids must be unique")

    results: list[QueryEvaluation] = []
    for query in queries:
        scores = scores_by_query.get(query.query_id) if scores_by_query else None
        ranking = rank_candidates(
            query,
            method=method,
            scores=scores,
            candidate_limit=candidate_limit,
        )
        results.append(
            _evaluate_query(query, ranking, hybrid=method != "dense")
        )

    positives = [result for result in results if not result.is_no_match]
    no_matches = [result for result in results if result.is_no_match]
    injected_count = sum(len(result.injected_candidate_ids) for result in results)
    junk_count = sum(result.injected_junk_count for result in results)
    return MethodEvaluation(
        method=method,
        candidate_limit=candidate_limit,
        chunk=ChunkAggregate(
            mrr=_mean(
                [result.chunk_reciprocal_rank for result in positives]
            ),
            ndcg_at_3=_mean([result.chunk_ndcg_at_3 for result in positives]),
        ),
        scene=SceneAggregate(
            recall_at_1=_mean(
                [result.scene_recall_at_1 for result in positives]
            ),
            recall_at_3=_mean(
                [result.scene_recall_at_3 for result in positives]
            ),
            mrr=_mean([result.scene_reciprocal_rank for result in positives]),
        ),
        injection=InjectionAggregate(
            gold_scene_inclusion=_mean(
                [float(result.gold_scene_included) for result in positives]
            ),
            junk_injection_rate=(
                junk_count / injected_count if injected_count else 0.0
            ),
            no_match_injection_rate=_mean(
                [
                    float(bool(result.injected_candidate_ids))
                    for result in no_matches
                ]
            ),
        ),
        queries=tuple(results),
    )


@dataclass(frozen=True)
class ConfidenceInterval:
    lower: float
    upper: float


@dataclass(frozen=True)
class WorstRegression:
    query_id: str
    delta_scene_reciprocal_rank: float


@dataclass(frozen=True)
class SliceComparison:
    query_count: int
    delta_mrr: float
    delta_recall_at_1: float
    delta_recall_at_3: float


@dataclass(frozen=True)
class Gate2Comparison:
    promote: bool
    delta_mrr: float
    delta_recall_at_1: float
    delta_recall_at_3: float
    paired_bootstrap: dict[str, ConfidenceInterval]
    improved_queries: int
    worsened_queries: int
    unchanged_queries: int
    no_match_regressions: tuple[str, ...]
    worst_regressions: tuple[WorstRegression, ...]
    slices: dict[str, SliceComparison]


def _paired_bootstrap_interval(
    deltas: Sequence[float],
    *,
    iterations: int,
    seed: int,
) -> ConfidenceInterval:
    if not deltas:
        return ConfidenceInterval(lower=0.0, upper=0.0)
    if iterations <= 0:
        raise ValueError("bootstrap iterations must be positive")
    generator = random.Random(seed)
    samples = sorted(
        _mean([deltas[generator.randrange(len(deltas))] for _ in deltas])
        for _ in range(iterations)
    )
    lower_index = max(0, math.floor(0.025 * (len(samples) - 1)))
    upper_index = min(
        len(samples) - 1,
        math.ceil(0.975 * (len(samples) - 1)),
    )
    return ConfidenceInterval(
        lower=samples[lower_index],
        upper=samples[upper_index],
    )


def compare_to_hybrid(
    baseline: MethodEvaluation,
    candidate: MethodEvaluation,
    *,
    bootstrap_iterations: int = 10_000,
    seed: int = 20260730,
) -> Gate2Comparison:
    baseline_by_id = {result.query_id: result for result in baseline.queries}
    candidate_by_id = {result.query_id: result for result in candidate.queries}
    if baseline_by_id.keys() != candidate_by_id.keys():
        raise ValueError("paired Gate 2 reports must contain identical query ids")

    positive_ids = [
        query_id
        for query_id, result in baseline_by_id.items()
        if not result.is_no_match
    ]
    mrr_deltas = [
        candidate_by_id[query_id].scene_reciprocal_rank
        - baseline_by_id[query_id].scene_reciprocal_rank
        for query_id in positive_ids
    ]
    recall_1_deltas = [
        candidate_by_id[query_id].scene_recall_at_1
        - baseline_by_id[query_id].scene_recall_at_1
        for query_id in positive_ids
    ]
    recall_3_deltas = [
        candidate_by_id[query_id].scene_recall_at_3
        - baseline_by_id[query_id].scene_recall_at_3
        for query_id in positive_ids
    ]
    delta_mrr = candidate.scene.mrr - baseline.scene.mrr
    delta_recall_1 = candidate.scene.recall_at_1 - baseline.scene.recall_at_1
    delta_recall_3 = candidate.scene.recall_at_3 - baseline.scene.recall_at_3

    query_mrr_delta = {
        query_id: candidate_by_id[query_id].scene_reciprocal_rank
        - baseline_by_id[query_id].scene_reciprocal_rank
        for query_id in positive_ids
    }
    tolerance = 1e-12
    improved = sum(value > tolerance for value in query_mrr_delta.values())
    worsened = sum(value < -tolerance for value in query_mrr_delta.values())
    unchanged = len(query_mrr_delta) - improved - worsened

    no_match_regressions = tuple(
        query_id
        for query_id, baseline_result in baseline_by_id.items()
        if baseline_result.is_no_match
        and candidate_by_id[query_id].injected_junk_count
        > baseline_result.injected_junk_count
    )
    worst = tuple(
        WorstRegression(
            query_id=query_id,
            delta_scene_reciprocal_rank=delta,
        )
        for query_id, delta in sorted(
            query_mrr_delta.items(),
            key=lambda item: (item[1], item[0]),
        )
        if delta < -tolerance
    )[:10]

    slices: dict[str, SliceComparison] = {}
    slice_names = sorted(
        {
            baseline_by_id[query_id].query_slice
            for query_id in positive_ids
        }
    )
    for slice_name in slice_names:
        ids = [
            query_id
            for query_id in positive_ids
            if baseline_by_id[query_id].query_slice == slice_name
        ]
        slices[slice_name] = SliceComparison(
            query_count=len(ids),
            delta_mrr=_mean(
                [
                    candidate_by_id[query_id].scene_reciprocal_rank
                    - baseline_by_id[query_id].scene_reciprocal_rank
                    for query_id in ids
                ]
            ),
            delta_recall_at_1=_mean(
                [
                    candidate_by_id[query_id].scene_recall_at_1
                    - baseline_by_id[query_id].scene_recall_at_1
                    for query_id in ids
                ]
            ),
            delta_recall_at_3=_mean(
                [
                    candidate_by_id[query_id].scene_recall_at_3
                    - baseline_by_id[query_id].scene_recall_at_3
                    for query_id in ids
                ]
            ),
        )

    promote = (
        (delta_mrr >= 0.05 or delta_recall_1 >= 0.05)
        and delta_recall_3 >= -0.01
        and not no_match_regressions
    )
    return Gate2Comparison(
        promote=promote,
        delta_mrr=delta_mrr,
        delta_recall_at_1=delta_recall_1,
        delta_recall_at_3=delta_recall_3,
        paired_bootstrap={
            "mrr": _paired_bootstrap_interval(
                mrr_deltas,
                iterations=bootstrap_iterations,
                seed=seed,
            ),
            "recallAt1": _paired_bootstrap_interval(
                recall_1_deltas,
                iterations=bootstrap_iterations,
                seed=seed + 1,
            ),
            "recallAt3": _paired_bootstrap_interval(
                recall_3_deltas,
                iterations=bootstrap_iterations,
                seed=seed + 2,
            ),
        },
        improved_queries=improved,
        worsened_queries=worsened,
        unchanged_queries=unchanged,
        no_match_regressions=no_match_regressions,
        worst_regressions=worst,
        slices=slices,
    )


@dataclass(frozen=True)
class CandidateDepthComparison:
    top12: MethodEvaluation
    top30: MethodEvaluation
    rescued_below_12: int
    rescue_query_ids: list[str]
    added_candidates: int
    added_hard_negatives: int


def compare_candidate_depths(
    queries: Sequence[Gate2Query],
    *,
    scores_by_query: Mapping[str, Mapping[str, float]],
) -> CandidateDepthComparison:
    top12 = evaluate_method(
        queries,
        method="reranker",
        scores_by_query=scores_by_query,
        candidate_limit=12,
    )
    top30 = evaluate_method(
        queries,
        method="reranker",
        scores_by_query=scores_by_query,
        candidate_limit=30,
    )
    top12_by_id = {result.query_id: result for result in top12.queries}
    top30_by_id = {result.query_id: result for result in top30.queries}
    rescue_ids: list[str] = []
    for query in queries:
        before = top12_by_id[query.query_id]
        after = top30_by_id[query.query_id]
        injected_after = set(after.injected_candidate_ids)
        rescued_from_tail = any(
            candidate.relevant
            and candidate.rrf_rank > 12
            and candidate.candidate_id in injected_after
            for candidate in query.candidates
        )
        if (
            not before.gold_scene_included
            and after.gold_scene_included
            and rescued_from_tail
        ):
            rescue_ids.append(query.query_id)
    tail = [
        candidate
        for query in queries
        for candidate in query.candidates
        if candidate.rrf_rank > 12
    ]
    return CandidateDepthComparison(
        top12=top12,
        top30=top30,
        rescued_below_12=len(rescue_ids),
        rescue_query_ids=rescue_ids,
        added_candidates=len(tail),
        added_hard_negatives=sum(not candidate.relevant for candidate in tail),
    )


@dataclass(frozen=True)
class ParityPair:
    pair_id: str
    group_id: str
    relevant: bool


@dataclass(frozen=True)
class LogitParityReport:
    passed: bool
    pair_count: int
    positive_direction_failures: list[str]
    pairwise_ranking_agreement: float
    tokenization_matches: bool
    token_type_ids_verified: bool


def evaluate_logit_parity(
    pairs: Sequence[ParityPair],
    *,
    reference_scores: Mapping[str, float],
    quantized_scores: Mapping[str, float],
    tokenization_matches: bool,
    token_type_ids_verified: bool,
    minimum_pairwise_agreement: float = 0.9,
) -> LogitParityReport:
    if not pairs:
        raise ValueError("logit parity requires fixed pairs")
    pair_ids = [pair.pair_id for pair in pairs]
    if len(pair_ids) != len(set(pair_ids)):
        raise ValueError("parity pair ids must be unique")
    expected = set(pair_ids)
    if not expected.issubset(reference_scores) or not expected.issubset(
        quantized_scores
    ):
        raise ValueError("logit parity scores are incomplete")
    for score_map in (reference_scores, quantized_scores):
        if any(not math.isfinite(float(score_map[pair_id])) for pair_id in pair_ids):
            raise ValueError("logit parity scores must be finite")

    grouped: dict[str, list[ParityPair]] = {}
    for pair in pairs:
        grouped.setdefault(pair.group_id, []).append(pair)
    direction_failures: list[str] = []
    for group_id, members in sorted(grouped.items()):
        positives = [member for member in members if member.relevant]
        negatives = [member for member in members if not member.relevant]
        if not positives or not negatives:
            raise ValueError(
                f"parity group {group_id} needs positive and negative pairs"
            )
        reference_ok = min(
            float(reference_scores[pair.pair_id]) for pair in positives
        ) > max(float(reference_scores[pair.pair_id]) for pair in negatives)
        quantized_ok = min(
            float(quantized_scores[pair.pair_id]) for pair in positives
        ) > max(float(quantized_scores[pair.pair_id]) for pair in negatives)
        if not reference_ok or not quantized_ok:
            direction_failures.append(group_id)

    comparable = 0
    agreeing = 0
    for left_index, left in enumerate(pairs):
        for right in pairs[left_index + 1 :]:
            reference_delta = float(reference_scores[left.pair_id]) - float(
                reference_scores[right.pair_id]
            )
            if reference_delta == 0.0:
                continue
            quantized_delta = float(quantized_scores[left.pair_id]) - float(
                quantized_scores[right.pair_id]
            )
            comparable += 1
            if quantized_delta != 0.0 and (
                (reference_delta > 0.0) == (quantized_delta > 0.0)
            ):
                agreeing += 1
    agreement = agreeing / comparable if comparable else 1.0
    passed = (
        not direction_failures
        and agreement >= minimum_pairwise_agreement
        and tokenization_matches
        and token_type_ids_verified
    )
    return LogitParityReport(
        passed=passed,
        pair_count=len(pairs),
        positive_direction_failures=direction_failures,
        pairwise_ranking_agreement=agreement,
        tokenization_matches=tokenization_matches,
        token_type_ids_verified=token_type_ids_verified,
    )
