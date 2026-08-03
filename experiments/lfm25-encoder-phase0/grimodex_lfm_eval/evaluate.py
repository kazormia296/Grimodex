"""Evaluate already-produced binary predictions without selecting on test data."""

from __future__ import annotations

import argparse
import json
from dataclasses import asdict
from pathlib import Path
from typing import Any

from .metrics import binary_classification_metrics


def evaluate_prediction_file(
    path: Path,
    *,
    split: str,
    threshold: float,
) -> dict[str, Any]:
    labels: list[int] = []
    probabilities: list[float] = []
    with path.open("r", encoding="utf-8") as source:
        for line_number, line in enumerate(source, start=1):
            if not line.strip():
                continue
            payload = json.loads(line)
            if payload.get("split") != split:
                continue
            try:
                labels.append(int(payload["label"]))
                probabilities.append(float(payload["probability"]))
            except (KeyError, TypeError, ValueError) as error:
                raise ValueError(f"{path}:{line_number}: invalid prediction") from error
    metrics = binary_classification_metrics(
        labels,
        probabilities,
        threshold=threshold,
    )
    return {
        "schemaVersion": 1,
        "split": split,
        "threshold": threshold,
        "sampleCount": len(labels),
        "metrics": asdict(metrics),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--predictions", type=Path, required=True)
    parser.add_argument("--split", required=True)
    parser.add_argument("--threshold", type=float, required=True)
    parser.add_argument("--output", type=Path, required=True)
    arguments = parser.parse_args()
    result = evaluate_prediction_file(
        arguments.predictions,
        split=arguments.split,
        threshold=arguments.threshold,
    )
    arguments.output.parent.mkdir(parents=True, exist_ok=True)
    arguments.output.write_text(
        json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
