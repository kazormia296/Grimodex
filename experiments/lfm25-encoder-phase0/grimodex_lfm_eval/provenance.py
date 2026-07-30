"""Supply-chain manifests and privacy-safe run provenance."""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Iterable, Mapping
from pathlib import Path
from typing import Any


PINNED_REVISION_PATTERN = re.compile(r"^[0-9a-fA-F]{40}$")


class ManifestVerificationError(ValueError):
    """Raised when a local model snapshot differs from its pinned manifest."""


FileManifest = dict[str, str]


def require_pinned_revision(revision: str) -> str:
    stripped = revision.strip()
    if not PINNED_REVISION_PATTERN.fullmatch(stripped):
        raise ValueError(
            "model revision must be an exact 40-character Hugging Face commit SHA"
        )
    return stripped.lower()


def _hash_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def build_file_manifest(
    root: Path,
    *,
    excluded_relative_paths: Iterable[str] = (),
) -> FileManifest:
    root = root.resolve()
    if not root.is_dir():
        raise FileNotFoundError(f"snapshot directory does not exist: {root}")
    excluded = set(excluded_relative_paths)
    manifest: FileManifest = {}
    for path in sorted(root.rglob("*")):
        if path.is_symlink():
            raise ManifestVerificationError(
                f"model snapshot contains a symbolic link: {path.relative_to(root)}"
            )
        if not path.is_file():
            continue
        relative_path = path.relative_to(root).as_posix()
        if relative_path in excluded:
            continue
        manifest[relative_path] = _hash_file(path)
    if not manifest:
        raise ManifestVerificationError("model snapshot contains no files")
    return manifest


def manifest_digest(manifest: Mapping[str, str]) -> str:
    canonical = json.dumps(
        dict(sorted(manifest.items())),
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return hashlib.sha256(canonical).hexdigest()


def verify_file_manifest(root: Path, expected: Mapping[str, str]) -> str:
    actual = build_file_manifest(root)
    expected_dict = dict(expected)
    if actual != expected_dict:
        missing = sorted(set(expected_dict) - set(actual))
        unexpected = sorted(set(actual) - set(expected_dict))
        changed = sorted(
            path
            for path in set(actual) & set(expected_dict)
            if actual[path] != expected_dict[path]
        )
        raise ManifestVerificationError(
            "model snapshot manifest mismatch: "
            f"missing={missing}, unexpected={unexpected}, changed={changed}"
        )
    return manifest_digest(actual)


def write_manifest(path: Path, manifest: Mapping[str, str]) -> str:
    digest = manifest_digest(manifest)
    payload = {
        "schemaVersion": 1,
        "algorithm": "sha256",
        "manifestHash": digest,
        "files": dict(sorted(manifest.items())),
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return digest


def load_manifest(path: Path) -> tuple[FileManifest, str]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if payload.get("schemaVersion") != 1 or payload.get("algorithm") != "sha256":
        raise ManifestVerificationError("unsupported manifest format")
    files = payload.get("files")
    if not isinstance(files, dict) or not all(
        isinstance(key, str) and isinstance(value, str)
        for key, value in files.items()
    ):
        raise ManifestVerificationError("manifest files must map paths to hashes")
    digest = manifest_digest(files)
    if digest != payload.get("manifestHash"):
        raise ManifestVerificationError("manifestHash does not match manifest files")
    return dict(files), digest


def list_custom_code_files(root: Path) -> list[str]:
    return sorted(
        path.relative_to(root).as_posix()
        for path in root.rglob("*.py")
        if path.is_file()
    )


def redact_for_report(record: Mapping[str, Any]) -> dict[str, Any]:
    if record.get("source") != "private":
        return dict(record)
    safe_fields = (
        "task",
        "language",
        "source",
        "generatorVersion",
        "reviewStatus",
        "license",
        "label",
        "relevanceGrade",
        "difficulty",
    )
    return {
        field: record[field]
        for field in safe_fields
        if field in record
    }
