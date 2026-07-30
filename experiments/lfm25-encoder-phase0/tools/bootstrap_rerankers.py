#!/usr/bin/env python3
"""Download only pinned Phase 0b tokenizer files and quantized ONNX artifacts."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import shutil
import sys
import uuid

from grimodex_lfm_eval.config import configure_hugging_face_environment
from grimodex_lfm_eval.provenance import (
    build_file_manifest,
    load_manifest,
    verify_file_manifest,
    write_manifest,
)
from grimodex_lfm_eval.reranker_phase0b import (
    Phase0bConfig,
    RerankerModelSpec,
    load_phase0b_config,
    resolve_model_paths,
    sha256_file,
)


def _verify_existing(
    config_path: Path,
    model: RerankerModelSpec,
) -> dict[str, object]:
    snapshot, manifest_path, artifact = resolve_model_paths(config_path, model)
    manifest, expected_manifest_hash = load_manifest(manifest_path)
    actual_manifest_hash = verify_file_manifest(snapshot, manifest)
    if actual_manifest_hash != expected_manifest_hash:
        raise ValueError("existing snapshot manifest hash is inconsistent")
    artifact_hash = sha256_file(artifact)
    if artifact_hash != model.artifact_sha256:
        raise ValueError(
            f"{model.key} artifact SHA-256 mismatch: "
            f"expected {model.artifact_sha256}, got {artifact_hash}"
        )
    return {
        "key": model.key,
        "status": "verified-existing",
        "modelId": model.model_id,
        "modelRevision": model.revision,
        "artifact": model.artifact,
        "artifactSha256": artifact_hash,
        "manifestHash": actual_manifest_hash,
        "fileCount": len(manifest),
        "snapshot": str(snapshot),
    }


def _download_model(
    config_path: Path,
    model: RerankerModelSpec,
) -> dict[str, object]:
    from huggingface_hub import HfApi, hf_hub_download

    snapshot, manifest_path, _ = resolve_model_paths(config_path, model)
    if snapshot.exists() or manifest_path.exists():
        if not snapshot.is_dir() or not manifest_path.is_file():
            raise FileExistsError(
                f"partial Phase 0b bootstrap state exists for {model.key}"
            )
        return _verify_existing(config_path, model)

    info = HfApi().model_info(model.model_id, revision=model.revision)
    if str(info.sha).lower() != model.revision:
        raise ValueError(
            f"{model.key} resolved revision changed: "
            f"expected {model.revision}, got {info.sha}"
        )

    snapshot.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    staging = snapshot.parent / f".snapshot-staging-{uuid.uuid4().hex}"
    try:
        for filename in model.files:
            cached = Path(
                hf_hub_download(
                    repo_id=model.model_id,
                    filename=filename,
                    revision=model.revision,
                )
            )
            destination = staging / filename
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(cached, destination)

        manifest = build_file_manifest(staging)
        artifact_hash = manifest.get(model.artifact)
        if artifact_hash != model.artifact_sha256:
            raise ValueError(
                f"{model.key} downloaded artifact SHA-256 mismatch: "
                f"expected {model.artifact_sha256}, got {artifact_hash}"
            )
        staging.rename(snapshot)
        manifest_hash = write_manifest(manifest_path, manifest)
    except BaseException:
        if staging.exists():
            shutil.rmtree(staging)
        raise

    return {
        "key": model.key,
        "status": "downloaded",
        "modelId": model.model_id,
        "modelRevision": model.revision,
        "artifact": model.artifact,
        "artifactSha256": model.artifact_sha256,
        "manifestHash": manifest_hash,
        "fileCount": len(manifest),
        "snapshot": str(snapshot),
    }


def bootstrap(
    config_path: Path,
    *,
    model_keys: tuple[str, ...] = (),
) -> dict[str, object]:
    config: Phase0bConfig = load_phase0b_config(config_path)
    experiment_root = config_path.resolve().parent.parent
    configure_hugging_face_environment(experiment_root, offline=False)
    os.environ.pop("HF_HUB_OFFLINE", None)
    os.environ.pop("TRANSFORMERS_OFFLINE", None)
    selected = (
        tuple(config.model(key) for key in model_keys)
        if model_keys
        else config.models
    )
    return {
        "schemaVersion": 1,
        "models": [
            _download_model(config_path, model)
            for model in selected
        ],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument(
        "--model",
        action="append",
        default=[],
        help="model key to bootstrap; repeat to select multiple (default: all)",
    )
    arguments = parser.parse_args()
    try:
        result = bootstrap(
            arguments.config.resolve(),
            model_keys=tuple(arguments.model),
        )
    except (FileExistsError, ValueError) as error:
        print(str(error), file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
