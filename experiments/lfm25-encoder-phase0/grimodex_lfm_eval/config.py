"""Small YAML configuration loader with explicit, local inheritance."""

from __future__ import annotations

import os
from collections.abc import Mapping
from pathlib import Path
from typing import Any

import yaml


def _deep_merge(base: dict[str, Any], override: Mapping[str, Any]) -> dict[str, Any]:
    merged = dict(base)
    for key, value in override.items():
        if (
            key in merged
            and isinstance(merged[key], dict)
            and isinstance(value, Mapping)
        ):
            merged[key] = _deep_merge(merged[key], value)
        else:
            merged[key] = value
    return merged


def load_config(path: Path, *, _visited: frozenset[Path] = frozenset()) -> dict[str, Any]:
    resolved = path.resolve()
    if resolved in _visited:
        raise ValueError(f"configuration inheritance cycle at {resolved}")
    payload = yaml.safe_load(resolved.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError(f"configuration must be a mapping: {resolved}")
    parent_reference = payload.pop("extends", None)
    if parent_reference is None:
        return payload
    if not isinstance(parent_reference, str) or not parent_reference:
        raise ValueError("extends must be a non-empty relative path")
    parent_path = (resolved.parent / parent_reference).resolve()
    try:
        parent_path.relative_to(resolved.parent)
    except ValueError as error:
        raise ValueError("extends must remain inside the configs directory") from error
    parent = load_config(parent_path, _visited=_visited | {resolved})
    return _deep_merge(parent, payload)


def configure_hugging_face_environment(
    experiment_root: Path,
    *,
    offline: bool,
    configured_values: Mapping[str, Any] | None = None,
) -> None:
    local_cache = experiment_root.resolve() / "local" / "huggingface"
    os.environ.setdefault("HF_HOME", str(local_cache))
    os.environ.setdefault("HF_HUB_CACHE", str(local_cache / "hub"))
    os.environ.setdefault("HF_MODULES_CACHE", str(local_cache / "modules"))
    os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
    if offline:
        os.environ["HF_HUB_OFFLINE"] = "1"
        os.environ["TRANSFORMERS_OFFLINE"] = "1"
    for key, value in (configured_values or {}).items():
        os.environ[str(key)] = str(value)
