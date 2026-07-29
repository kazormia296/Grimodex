#!/usr/bin/env python3
"""Pin and download a Hugging Face snapshot without executing model code."""

from __future__ import annotations

import argparse
import json
import shutil
import sys
import uuid
from pathlib import Path
from typing import Any

from grimodex_lfm_eval.config import (
    configure_hugging_face_environment,
    load_config,
)
from grimodex_lfm_eval.provenance import (
    build_file_manifest,
    list_custom_code_files,
    load_manifest,
    require_pinned_revision,
    verify_file_manifest,
    write_manifest,
)


class FloatingRevisionError(ValueError):
    def __init__(self, requested: str, resolved: str) -> None:
        super().__init__(
            f"floating revision {requested!r} resolved to {resolved}; "
            "write that exact SHA to the config and rerun"
        )
        self.requested = requested
        self.resolved = resolved


def _paths_inside_experiment(
    config: dict[str, Any],
    config_path: Path,
) -> tuple[Path, Path]:
    experiment_root = config_path.parent.parent.resolve()
    snapshot = (experiment_root / str(config["model"]["local_snapshot"])).resolve()
    manifest = (experiment_root / str(config["model"]["manifest"])).resolve()
    try:
        snapshot.relative_to(experiment_root)
        manifest.relative_to(experiment_root)
    except ValueError as error:
        raise ValueError("model paths must remain inside the experiment directory") from error
    return snapshot, manifest


def bootstrap(config_path: Path) -> dict[str, Any]:
    from huggingface_hub import HfApi, snapshot_download

    config = load_config(config_path)
    configure_hugging_face_environment(
        config_path.parent.parent,
        offline=False,
    )
    model_config = config["model"]
    model_id = str(model_config["id"])
    requested_revision = str(model_config["revision"]).strip()
    api = HfApi()
    info = api.model_info(model_id, revision=requested_revision)
    resolved_revision = require_pinned_revision(str(info.sha))
    if requested_revision.lower() != resolved_revision:
        raise FloatingRevisionError(requested_revision, resolved_revision)
    revision = require_pinned_revision(requested_revision)
    snapshot, manifest_path = _paths_inside_experiment(config, config_path)

    if snapshot.exists() or manifest_path.exists():
        if not snapshot.is_dir() or not manifest_path.is_file():
            raise FileExistsError(
                "partial bootstrap state exists; inspect it before retrying"
            )
        manifest, expected_hash = load_manifest(manifest_path)
        actual_hash = verify_file_manifest(snapshot, manifest)
        if actual_hash != expected_hash:
            raise ValueError("existing snapshot does not match its manifestHash")
        return {
            "schemaVersion": 1,
            "status": "verified-existing",
            "modelId": model_id,
            "modelRevision": revision,
            "manifestHash": actual_hash,
            "customCodeFiles": list_custom_code_files(snapshot),
            "snapshot": str(snapshot),
        }

    snapshot.parent.mkdir(parents=True, exist_ok=True)
    staging = snapshot.parent / f".snapshot-staging-{uuid.uuid4().hex}"
    try:
        snapshot_download(
            repo_id=model_id,
            revision=revision,
            local_dir=staging,
        )
        manifest = build_file_manifest(staging)
        custom_code_files = list_custom_code_files(staging)
        staging.rename(snapshot)
        manifest_hash = write_manifest(manifest_path, manifest)
    except BaseException:
        if staging.exists():
            shutil.rmtree(staging)
        raise

    return {
        "schemaVersion": 1,
        "status": "downloaded",
        "modelId": model_id,
        "modelRevision": revision,
        "manifestHash": manifest_hash,
        "fileCount": len(manifest),
        "customCodeFiles": custom_code_files,
        "snapshot": str(snapshot),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    arguments = parser.parse_args()
    try:
        result = bootstrap(arguments.config.resolve())
    except FloatingRevisionError as error:
        print(
            json.dumps(
                {
                    "status": "revision-update-required",
                    "requestedRevision": error.requested,
                    "resolvedRevision": error.resolved,
                },
                indent=2,
            )
        )
        print(str(error), file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
