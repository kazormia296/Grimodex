"""C0 model smoke runner; corpus training is deliberately deferred past C0.5."""

from __future__ import annotations

import argparse
import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .config import configure_hugging_face_environment, load_config
from .model import LfmBinaryClassifier, load_offline_tokenizer
from .provenance import load_manifest, require_pinned_revision, verify_file_manifest


def _resolve_verified_model(
    config: dict[str, Any],
    config_path: Path,
) -> tuple[Path, Path, str, str]:
    experiment_root = config_path.parent.parent
    model_config = config["model"]
    revision = require_pinned_revision(str(model_config["revision"]))
    snapshot = experiment_root / str(model_config["local_snapshot"])
    manifest_path = experiment_root / str(model_config["manifest"])
    manifest, expected_hash = load_manifest(manifest_path)
    actual_hash = verify_file_manifest(snapshot, manifest)
    if actual_hash != expected_hash:
        raise ValueError("verified model snapshot differs from manifestHash")
    return snapshot, manifest_path, revision, actual_hash


def _smoke_step(
    *,
    classifier: LfmBinaryClassifier,
    encoded: dict[str, Any],
    labels: Any,
    device: str,
) -> float:
    import torch

    classifier.to(device)
    classifier.train()
    device_inputs = {
        key: value.to(device)
        for key, value in encoded.items()
        if key in {"input_ids", "attention_mask"}
    }
    device_labels = labels.to(device)
    optimizer = torch.optim.AdamW(classifier.parameters(), lr=1e-4)
    optimizer.zero_grad(set_to_none=True)
    output = classifier(**device_inputs, labels=device_labels)
    if output.loss is None or not torch.isfinite(output.loss):
        raise RuntimeError(f"non-finite smoke loss on {device}")
    output.loss.backward()
    optimizer.step()
    loss = float(output.loss.detach().cpu())
    optimizer.zero_grad(set_to_none=True)
    return loss


def run_smoke(config_path: Path, output_path: Path | None = None) -> Path:
    import torch

    config = load_config(config_path)
    snapshot, manifest_path, revision, manifest_hash = _resolve_verified_model(
        config,
        config_path,
    )
    configure_hugging_face_environment(
        config_path.parent.parent,
        offline=True,
        configured_values=config.get("offline_environment"),
    )
    tokenizer = load_offline_tokenizer(snapshot, manifest_path=manifest_path)
    classifier = LfmBinaryClassifier.from_local_snapshot(
        snapshot,
        manifest_path=manifest_path,
        dropout=float(config["classifier"]["dropout"]),
    )
    max_tokens = min(256, int(config.get("max_tokens", 256)))
    texts = [
        f"[QUERY]\n記憶の条件 {index}\n\n[CANDIDATE]\n"
        "朱紐に触れると他人の記憶が流れ込む。" * 16
        for index in range(8)
    ]
    encoded = tokenizer(
        texts,
        max_length=max_tokens,
        padding="max_length",
        truncation=True,
        return_tensors="pt",
    )
    labels = torch.tensor([index % 2 for index in range(8)], dtype=torch.float32)
    results = [{"device": "cpu", "loss": _smoke_step(
        classifier=classifier,
        encoded=encoded,
        labels=labels,
        device="cpu",
    )}]
    if torch.cuda.is_available():
        results.append(
            {
                "device": "cuda",
                "loss": _smoke_step(
                    classifier=classifier,
                    encoded=encoded,
                    labels=labels,
                    device="cuda",
                ),
            }
        )
    payload = {
        "schemaVersion": 1,
        "createdAt": datetime.now(UTC).isoformat(),
        "modelRevision": revision,
        "manifestHash": manifest_hash,
        "sampleCount": 8,
        "maxTokens": max_tokens,
        "steps": 1,
        "devices": results,
    }
    experiment_root = config_path.parent.parent
    destination = output_path or (
        experiment_root
        / "artifacts"
        / "smoke"
        / f"{datetime.now(UTC).strftime('%Y%m%dT%H%M%SZ')}.json"
    )
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return destination


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--smoke", action="store_true")
    parser.add_argument("--mode", choices=("smoke",))
    parser.add_argument("--output", type=Path)
    return parser


def main() -> int:
    arguments = _build_parser().parse_args()
    if not arguments.smoke and arguments.mode != "smoke":
        raise SystemExit(
            "PR 1 implements C0 smoke only; run the C0.5 gate before corpus training"
        )
    destination = run_smoke(arguments.config.resolve(), arguments.output)
    print(json.dumps({"smokeReport": str(destination)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
