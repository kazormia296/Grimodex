"""Validation-only threshold selection for conservative impact triage."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Sequence

from .metrics import binary_classification_metrics


class ThresholdSelectionError(ValueError):
    """Raised when threshold selection would leak locked evaluation data."""


@dataclass(frozen=True)
class PredictionRecord:
    probability: float
    label: Literal[0, 1]
    split: str
    direct_contradiction: bool = False


@dataclass(frozen=True)
class ThresholdSelection:
    low_threshold: float
    high_threshold: float
    positive_recall: float
    direct_recall: float
    candidate_reduction: float


def _recall(records: Sequence[PredictionRecord], threshold: float) -> float:
    positives = [record for record in records if record.label == 1]
    if not positives:
        return 1.0
    return sum(record.probability >= threshold for record in positives) / len(positives)


def select_impact_thresholds(
    records: Sequence[PredictionRecord],
    *,
    minimum_recall: float = 0.95,
    minimum_direct_recall: float = 1.0,
) -> ThresholdSelection:
    if not records:
        raise ThresholdSelectionError("validation predictions are required")
    if any(record.split != "validation" for record in records):
        raise ThresholdSelectionError(
            "threshold selection may use validation predictions only"
        )
    if not 0.0 <= minimum_recall <= 1.0:
        raise ValueError("minimum_recall must be between zero and one")
    if not 0.0 <= minimum_direct_recall <= 1.0:
        raise ValueError("minimum_direct_recall must be between zero and one")
    if not any(record.label == 1 for record in records):
        raise ThresholdSelectionError("validation predictions need a positive example")
    if any(not 0.0 <= record.probability <= 1.0 for record in records):
        raise ValueError("probabilities must be between zero and one")

    direct_records = [
        record
        for record in records
        if record.label == 1 and record.direct_contradiction
    ]
    candidates = sorted({0.0, *(record.probability for record in records)})
    feasible: list[tuple[float, float, float, float]] = []
    for threshold in candidates:
        positive_recall = _recall(records, threshold)
        direct_recall = _recall(direct_records, threshold)
        reduction = sum(record.probability < threshold for record in records) / len(records)
        if (
            positive_recall >= minimum_recall
            and direct_recall >= minimum_direct_recall
        ):
            feasible.append(
                (threshold, reduction, positive_recall, direct_recall)
            )
    if not feasible:
        raise ThresholdSelectionError(
            "no low threshold satisfies the requested recall constraints"
        )

    low_threshold, reduction, positive_recall, direct_recall = max(
        feasible,
        key=lambda candidate: (candidate[1], candidate[0]),
    )

    labels = [record.label for record in records]
    probabilities = [record.probability for record in records]
    high_candidates = [candidate for candidate in candidates if candidate >= low_threshold]
    high_threshold = max(
        high_candidates,
        key=lambda threshold: (
            binary_classification_metrics(
                labels,
                probabilities,
                threshold=threshold,
            ).f1,
            binary_classification_metrics(
                labels,
                probabilities,
                threshold=threshold,
            ).precision,
            threshold,
        ),
    )

    return ThresholdSelection(
        low_threshold=low_threshold,
        high_threshold=high_threshold,
        positive_recall=positive_recall,
        direct_recall=direct_recall,
        candidate_reduction=reduction,
    )
