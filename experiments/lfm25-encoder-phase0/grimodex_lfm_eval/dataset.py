"""Dataset loading and leakage checks that operate before model code."""

from __future__ import annotations

import hashlib
import json
from collections.abc import Iterable, Mapping, Sequence
from pathlib import Path
from typing import Any

from pydantic import BaseModel

from .schemas import DatasetRecord, ImpactRecord, RelevancePair, SplitManifest


class DatasetValidationError(ValueError):
    """Raised when a dataset violates a Phase 0 invariant."""


RecordLike = Mapping[str, Any] | BaseModel


def _read_field(record: RecordLike, field_name: str, alias: str | None = None) -> Any:
    if isinstance(record, BaseModel):
        return getattr(record, field_name)
    if field_name in record:
        return record[field_name]
    if alias is not None and alias in record:
        return record[alias]
    raise DatasetValidationError(f"record is missing {alias or field_name}")


def validate_unique_ids(records: Iterable[RecordLike]) -> None:
    seen: set[str] = set()
    for record in records:
        record_id = str(_read_field(record, "id"))
        if record_id in seen:
            raise DatasetValidationError(f"duplicate stable id: {record_id}")
        seen.add(record_id)


def validate_story_splits(
    records_by_split: Mapping[str, Sequence[RecordLike]],
) -> None:
    expected_splits = {"train", "validation", "test", "challenge"}
    unknown = set(records_by_split) - expected_splits
    if unknown:
        raise DatasetValidationError(f"unknown splits: {sorted(unknown)}")

    story_owner: dict[str, str] = {}
    all_records: list[RecordLike] = []
    for split_name, records in records_by_split.items():
        all_records.extend(records)
        for record in records:
            story_id = str(_read_field(record, "story_id", "storyId"))
            previous = story_owner.setdefault(story_id, split_name)
            if previous != split_name:
                raise DatasetValidationError(
                    f"story leakage: {story_id} appears in {previous} and {split_name}"
                )
    validate_unique_ids(all_records)


def deterministic_negative_sample(
    candidates: Sequence[Mapping[str, Any]],
    *,
    count: int,
    seed_material: str,
) -> list[Mapping[str, Any]]:
    if count < 0:
        raise ValueError("count must be non-negative")
    if count > len(candidates):
        raise ValueError("count cannot exceed the candidate count")

    candidate_ids = [str(_read_field(candidate, "id")) for candidate in candidates]
    if len(candidate_ids) != len(set(candidate_ids)):
        raise DatasetValidationError("negative candidates must have unique ids")

    def stable_key(candidate: Mapping[str, Any]) -> tuple[str, str]:
        candidate_id = str(_read_field(candidate, "id"))
        digest = hashlib.sha256(
            f"{seed_material}\0{candidate_id}".encode("utf-8")
        ).hexdigest()
        return digest, candidate_id

    return list(sorted(candidates, key=stable_key)[:count])


def parse_dataset_record(payload: Mapping[str, Any]) -> DatasetRecord:
    task = payload.get("task")
    if task == "relevance":
        return RelevancePair.model_validate(payload)
    if task == "impact":
        return ImpactRecord.model_validate(payload)
    raise DatasetValidationError(f"unsupported task: {task!r}")


def load_jsonl(path: Path) -> list[DatasetRecord]:
    records: list[DatasetRecord] = []
    with path.open("r", encoding="utf-8") as source:
        for line_number, line in enumerate(source, start=1):
            stripped = line.strip()
            if not stripped:
                continue
            try:
                payload = json.loads(stripped)
                if not isinstance(payload, dict):
                    raise TypeError("record must be a JSON object")
                records.append(parse_dataset_record(payload))
            except (json.JSONDecodeError, TypeError, ValueError) as error:
                raise DatasetValidationError(
                    f"{path}:{line_number}: {error}"
                ) from error
    validate_unique_ids(records)
    return records


def load_split_manifest(path: Path) -> SplitManifest:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise DatasetValidationError(f"cannot read split manifest {path}: {error}") from error
    return SplitManifest.model_validate(payload)
