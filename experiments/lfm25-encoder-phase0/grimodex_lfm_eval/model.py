"""Masked-mean binary classifier over a verified local LFM2.5 snapshot."""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .provenance import (
    load_manifest,
    require_pinned_revision,
    verify_file_manifest,
)

try:
    import torch
    from torch import Tensor, nn
except ImportError:  # pragma: no cover - exercised by environments without ML extras
    torch = None  # type: ignore[assignment]
    Tensor = Any  # type: ignore[assignment,misc]
    nn = None  # type: ignore[assignment]


@dataclass(frozen=True)
class ClassifierOutput:
    logits: Any
    loss: Any | None = None


def _require_torch() -> Any:
    if torch is None:
        raise RuntimeError(
            "PyTorch is required; sync the cpu, cuda, or rocm environment"
        )
    return torch


def masked_mean_pool(last_hidden_state: Tensor, attention_mask: Tensor) -> Tensor:
    torch_module = _require_torch()
    if last_hidden_state.ndim != 3:
        raise ValueError("last_hidden_state must have shape [batch, sequence, hidden]")
    if attention_mask.ndim != 2:
        raise ValueError("attention_mask must have shape [batch, sequence]")
    if tuple(last_hidden_state.shape[:2]) != tuple(attention_mask.shape):
        raise ValueError("attention_mask shape must match hidden-state batch and sequence")

    weights = attention_mask.to(
        device=last_hidden_state.device,
        dtype=last_hidden_state.dtype,
    ).unsqueeze(-1)
    counts = weights.sum(dim=1)
    if torch_module.any(counts == 0):
        raise ValueError("masked mean pooling cannot pool an all-padding sequence")
    return (last_hidden_state * weights).sum(dim=1) / counts


def _verify_local_snapshot(snapshot: Path, manifest_path: Path) -> str:
    snapshot = snapshot.resolve()
    manifest_path = manifest_path.resolve()
    if not snapshot.is_dir():
        raise FileNotFoundError(f"local model snapshot does not exist: {snapshot}")
    manifest, expected_hash = load_manifest(manifest_path)
    actual_hash = verify_file_manifest(snapshot, manifest)
    if actual_hash != expected_hash:
        raise ValueError("model manifest hash changed during verification")
    return actual_hash


def _require_offline_environment() -> None:
    required = ("HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE")
    missing = [key for key in required if os.environ.get(key) != "1"]
    if missing:
        raise RuntimeError(
            "verified model loading requires offline environment flags: "
            + ", ".join(missing)
        )


def load_offline_tokenizer(snapshot: Path, *, manifest_path: Path) -> Any:
    _require_offline_environment()
    _verify_local_snapshot(snapshot, manifest_path)
    from transformers import AutoTokenizer

    return AutoTokenizer.from_pretrained(
        str(snapshot.resolve()),
        local_files_only=True,
        trust_remote_code=True,
    )


if nn is not None:

    class LfmBinaryClassifier(nn.Module):
        def __init__(
            self,
            backbone: nn.Module,
            *,
            hidden_size: int,
            dropout: float = 0.1,
        ) -> None:
            super().__init__()
            if not 0.0 <= dropout < 1.0:
                raise ValueError("dropout must be in [0, 1)")
            self.backbone = backbone
            self.dropout = nn.Dropout(dropout)
            self.classifier = nn.Linear(hidden_size, 1)

        @classmethod
        def from_local_snapshot(
            cls,
            snapshot: Path,
            *,
            manifest_path: Path,
            dropout: float = 0.1,
        ) -> "LfmBinaryClassifier":
            _require_offline_environment()
            _verify_local_snapshot(snapshot, manifest_path)
            from transformers import AutoModelForMaskedLM

            masked_lm, loading_info = AutoModelForMaskedLM.from_pretrained(
                str(snapshot.resolve()),
                local_files_only=True,
                trust_remote_code=True,
                output_loading_info=True,
            )
            loading_errors = {
                key: loading_info.get(key, [])
                for key in (
                    "missing_keys",
                    "unexpected_keys",
                    "mismatched_keys",
                    "error_msgs",
                )
                if loading_info.get(key)
            }
            if loading_errors:
                raise ValueError(
                    f"pretrained masked-LM checkpoint did not load exactly: "
                    f"{loading_errors}"
                )
            backbone = getattr(masked_lm, "base_model", None)
            if backbone is None or backbone is masked_lm:
                backbone = getattr(masked_lm, "lfm2", None)
            if backbone is None or backbone is masked_lm:
                raise ValueError(
                    "masked-LM checkpoint does not expose its pretrained encoder body"
                )
            hidden_size = getattr(backbone.config, "hidden_size", None)
            if not isinstance(hidden_size, int) or hidden_size <= 0:
                raise ValueError("backbone config does not expose a valid hidden_size")
            return cls(backbone, hidden_size=hidden_size, dropout=dropout)

        def forward(
            self,
            *,
            input_ids: Tensor,
            attention_mask: Tensor,
            labels: Tensor | None = None,
            **backbone_arguments: Any,
        ) -> ClassifierOutput:
            outputs = self.backbone(
                input_ids=input_ids,
                attention_mask=attention_mask,
                return_dict=True,
                **backbone_arguments,
            )
            hidden_state = getattr(outputs, "last_hidden_state", None)
            if hidden_state is None:
                raise ValueError("backbone output does not contain last_hidden_state")
            pooled = masked_mean_pool(hidden_state, attention_mask)
            classifier_dtype = self.classifier.weight.dtype
            logits = self.classifier(
                self.dropout(pooled).to(dtype=classifier_dtype)
            ).squeeze(-1).float()
            loss = None
            if labels is not None:
                loss = nn.functional.binary_cross_entropy_with_logits(
                    logits,
                    labels.float(),
                )
            return ClassifierOutput(logits=logits, loss=loss)

        def save_checkpoint(
            self,
            directory: Path,
            *,
            model_revision: str,
            task: str,
            schema_version: int,
            label_map: dict[str, int],
            manifest_hash: str,
        ) -> None:
            revision = require_pinned_revision(model_revision)
            directory.mkdir(parents=True, exist_ok=False)
            torch.save(self.state_dict(), directory / "model.pt")
            metadata = {
                "schemaVersion": schema_version,
                "modelRevision": revision,
                "manifestHash": manifest_hash,
                "task": task,
                "labelMap": label_map,
            }
            (directory / "metadata.json").write_text(
                json.dumps(metadata, indent=2, sort_keys=True) + "\n",
                encoding="utf-8",
            )

else:

    class LfmBinaryClassifier:  # pragma: no cover - import-only fallback
        def __init__(self, *_arguments: Any, **_keyword_arguments: Any) -> None:
            _require_torch()
