#!/usr/bin/env python3
"""Validate public Phase 0 JSONL records and story-level split isolation."""

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
    for path in sorted(data_root.rglob("*.jsonl")):
        for record in load_jsonl(path):
            split = story_to_split.get(record.story_id)
            if split is None:
                raise DatasetValidationError(
                    f"{path}: story {record.story_id!r} is absent from splits.json"
                )
            records_by_split[split].append(record)
            task_counts[str(record.task)] += 1

    validate_story_splits(records_by_split)
    return {
        "schemaVersion": 1,
        "taskCounts": task_counts,
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
