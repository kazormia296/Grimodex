#!/usr/bin/env python3
"""Validate public Phase 0 and Phase 0b Gate 2 data contracts."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from grimodex_lfm_eval.dataset import (
    DatasetValidationError,
    load_jsonl,
    load_split_manifest,
    validate_story_splits,
)
from grimodex_lfm_eval.reranker_gate2 import (
    load_gate2_jsonl,
    load_parity_jsonl,
)


def validate_dataset(data_root: Path) -> dict[str, object]:
    split_manifest = load_split_manifest(data_root / "splits.json")
    story_to_split: dict[str, str] = {}
    for split_name in ("train", "validation", "test", "challenge"):
        for story_id in getattr(split_manifest, split_name):
            story_to_split[story_id] = split_name

    records_by_split: dict[str, list[object]] = {
        "train": [],
        "validation": [],
        "test": [],
        "challenge": [],
    }
    task_counts = {"relevance": 0, "impact": 0}
    gate2_root = data_root / "gate2"
    for path in sorted(data_root.rglob("*.jsonl")):
        if gate2_root in path.parents:
            continue
        for record in load_jsonl(path):
            split = story_to_split.get(record.story_id)
            if split is None:
                raise DatasetValidationError(
                    f"{path}: story {record.story_id!r} is absent from splits.json"
                )
            records_by_split[split].append(record)
            task_counts[str(record.task)] += 1

    validate_story_splits(records_by_split)
    gate2_counts = {
        "candidateQueries": 0,
        "candidateChunks": 0,
        "parityPairs": 0,
    }
    if gate2_root.is_dir():
        known_gate2_files: set[Path] = set()
        for path in sorted(gate2_root.glob("candidates-*.jsonl")):
            queries = load_gate2_jsonl(path)
            known_gate2_files.add(path)
            gate2_counts["candidateQueries"] += len(queries)
            gate2_counts["candidateChunks"] += sum(
                len(query.candidates) for query in queries
            )
        for path in sorted(gate2_root.glob("parity-pairs-*.jsonl")):
            pairs = load_parity_jsonl(path, expected_pair_count=12)
            known_gate2_files.add(path)
            gate2_counts["parityPairs"] += len(pairs)
        unknown = set(gate2_root.glob("*.jsonl")) - known_gate2_files
        if unknown:
            raise DatasetValidationError(
                "unsupported Gate 2 JSONL files: "
                + ", ".join(str(path) for path in sorted(unknown))
            )
    return {
        "schemaVersion": 1,
        "taskCounts": task_counts,
        "gate2Counts": gate2_counts,
        "splitCounts": {
            split: len(records)
            for split, records in records_by_split.items()
        },
        "storyCounts": {
            split: len(getattr(split_manifest, split))
            for split in records_by_split
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("data_root", type=Path)
    arguments = parser.parse_args()
    result = validate_dataset(arguments.data_root.resolve())
    print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
