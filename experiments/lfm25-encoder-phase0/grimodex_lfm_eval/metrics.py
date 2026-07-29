"""Dependency-light quality metrics used by Phase 0 reports."""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Sequence


@dataclass(frozen=True)
class BinaryMetrics:
    positive_recall: float
    false_negative_rate: float
    precision: float
    f1: float
    average_precision: float
    roc_auc: float
    brier_score: float
    expected_calibration_error: float
    candidate_retention: float
    candidate_reduction: float


@dataclass(frozen=True)
class RankingMetrics:
    recall_at: dict[int, float]
    reciprocal_rank: float
    ndcg_at: dict[int, float]


def _validate_binary_inputs(
    labels: Sequence[int],
    probabilities: Sequence[float],
) -> None:
    if not labels or len(labels) != len(probabilities):
        raise ValueError("labels and probabilities must have equal nonzero length")
    if any(label not in (0, 1) for label in labels):
        raise ValueError("labels must be binary")
    if any(not math.isfinite(value) or not 0.0 <= value <= 1.0 for value in probabilities):
        raise ValueError("probabilities must be finite values between zero and one")


def _average_precision(labels: Sequence[int], probabilities: Sequence[float]) -> float:
    positive_count = sum(labels)
    if positive_count == 0:
        return 0.0
    ranked = sorted(
        zip(probabilities, labels, strict=True),
        key=lambda item: item[0],
        reverse=True,
    )
    true_positives = 0
    precision_sum = 0.0
    for rank, (_probability, label) in enumerate(ranked, start=1):
        if label == 1:
            true_positives += 1
            precision_sum += true_positives / rank
    return precision_sum / positive_count


def _roc_auc(labels: Sequence[int], probabilities: Sequence[float]) -> float:
    positive_scores = [
        probability
        for label, probability in zip(labels, probabilities, strict=True)
        if label == 1
    ]
    negative_scores = [
        probability
        for label, probability in zip(labels, probabilities, strict=True)
        if label == 0
    ]
    if not positive_scores or not negative_scores:
        return 0.0
    wins = 0.0
    for positive in positive_scores:
        for negative in negative_scores:
            if positive > negative:
                wins += 1.0
            elif positive == negative:
                wins += 0.5
    return wins / (len(positive_scores) * len(negative_scores))


def _expected_calibration_error(
    labels: Sequence[int],
    probabilities: Sequence[float],
    *,
    bins: int,
) -> float:
    if bins <= 0:
        raise ValueError("bins must be positive")
    total = len(labels)
    calibration_error = 0.0
    for bin_index in range(bins):
        lower = bin_index / bins
        upper = (bin_index + 1) / bins
        members = [
            (label, probability)
            for label, probability in zip(labels, probabilities, strict=True)
            if lower <= probability < upper
            or (bin_index == bins - 1 and probability == 1.0)
        ]
        if not members:
            continue
        accuracy = sum(label for label, _ in members) / len(members)
        confidence = sum(probability for _, probability in members) / len(members)
        calibration_error += (len(members) / total) * abs(accuracy - confidence)
    return calibration_error


def binary_classification_metrics(
    labels: Sequence[int],
    probabilities: Sequence[float],
    *,
    threshold: float = 0.5,
    calibration_bins: int = 10,
) -> BinaryMetrics:
    _validate_binary_inputs(labels, probabilities)
    if not 0.0 <= threshold <= 1.0:
        raise ValueError("threshold must be between zero and one")

    predictions = [int(probability >= threshold) for probability in probabilities]
    true_positive = sum(
        label == 1 and prediction == 1
        for label, prediction in zip(labels, predictions, strict=True)
    )
    false_negative = sum(
        label == 1 and prediction == 0
        for label, prediction in zip(labels, predictions, strict=True)
    )
    false_positive = sum(
        label == 0 and prediction == 1
        for label, prediction in zip(labels, predictions, strict=True)
    )
    positive_count = true_positive + false_negative
    recall = true_positive / positive_count if positive_count else 0.0
    precision_denominator = true_positive + false_positive
    precision = (
        true_positive / precision_denominator if precision_denominator else 0.0
    )
    f1 = (
        2.0 * precision * recall / (precision + recall)
        if precision + recall
        else 0.0
    )
    retention = sum(predictions) / len(predictions)

    return BinaryMetrics(
        positive_recall=recall,
        false_negative_rate=1.0 - recall if positive_count else 0.0,
        precision=precision,
        f1=f1,
        average_precision=_average_precision(labels, probabilities),
        roc_auc=_roc_auc(labels, probabilities),
        brier_score=sum(
            (probability - label) ** 2
            for label, probability in zip(labels, probabilities, strict=True)
        )
        / len(labels),
        expected_calibration_error=_expected_calibration_error(
            labels,
            probabilities,
            bins=calibration_bins,
        ),
        candidate_retention=retention,
        candidate_reduction=1.0 - retention,
    )


def ranking_metrics(
    relevance_grades: Sequence[int],
    *,
    k_values: Sequence[int] = (1, 3),
) -> RankingMetrics:
    if not relevance_grades:
        raise ValueError("relevance_grades must be non-empty")
    if any(grade < 0 for grade in relevance_grades):
        raise ValueError("relevance grades must be non-negative")
    if not k_values or any(k <= 0 for k in k_values):
        raise ValueError("k_values must contain positive values")

    total_relevant = sum(grade > 0 for grade in relevance_grades)
    first_relevant = next(
        (index for index, grade in enumerate(relevance_grades, start=1) if grade > 0),
        None,
    )
    recall_at: dict[int, float] = {}
    ndcg_at: dict[int, float] = {}
    ideal = sorted(relevance_grades, reverse=True)

    for k in k_values:
        top_k = relevance_grades[:k]
        found = sum(grade > 0 for grade in top_k)
        recall_at[k] = found / total_relevant if total_relevant else 0.0

        dcg = sum(
            ((2**grade) - 1) / math.log2(rank + 1)
            for rank, grade in enumerate(top_k, start=1)
        )
        ideal_dcg = sum(
            ((2**grade) - 1) / math.log2(rank + 1)
            for rank, grade in enumerate(ideal[:k], start=1)
        )
        ndcg_at[k] = dcg / ideal_dcg if ideal_dcg else 0.0

    return RankingMetrics(
        recall_at=recall_at,
        reciprocal_rank=1.0 / first_relevant if first_relevant is not None else 0.0,
        ndcg_at=ndcg_at,
    )
