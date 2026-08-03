"""Canonical, version-stable model input serialization."""

from __future__ import annotations

import json
from dataclasses import asdict, is_dataclass
from typing import Any

from pydantic import BaseModel


def _json_compatible(value: Any) -> Any:
    if isinstance(value, BaseModel):
        return value.model_dump(mode="json", by_alias=True)
    if is_dataclass(value) and not isinstance(value, type):
        return asdict(value)
    return value


def canonical_json(payload: Any) -> str:
    return json.dumps(
        _json_compatible(payload),
        ensure_ascii=False,
        allow_nan=False,
        separators=(",", ":"),
        sort_keys=True,
    )


def serialize_relevance_input(query: str, candidate_text: str) -> str:
    query = query.strip()
    candidate_text = candidate_text.strip()
    if not query or not candidate_text:
        raise ValueError("query and candidate_text must be non-empty")
    return f"[QUERY]\n{query}\n\n[CANDIDATE]\n{candidate_text}"


def serialize_impact_input(diff_payload: Any, scene_text: str) -> str:
    scene_text = scene_text.strip()
    if not scene_text:
        raise ValueError("scene_text must be non-empty")
    return (
        f"[CODEX_CHANGE]\n{canonical_json(diff_payload)}"
        f"\n\n[SCENE]\n{scene_text}"
    )
