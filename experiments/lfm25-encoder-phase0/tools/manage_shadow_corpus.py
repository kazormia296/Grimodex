#!/usr/bin/env python3
"""Create, validate, and freeze hash-only Semantic Recall shadow labels."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import sys
from typing import Sequence

from pydantic import ValidationError

from grimodex_lfm_eval.shadow_corpus import (
    CorpusValidationError,
    HoldoutLock,
    ShadowLabelRecord,
    build_label_template,
    build_safe_report,
    create_holdout_lock,
    load_label_jsonl,
    load_shadow_log_jsonl,
    pair_shadow_records,
    verify_holdout_lock,
)


EXPERIMENT_ROOT = Path(__file__).resolve().parents[1]
PRIVATE_ROOT = (EXPERIMENT_ROOT / "data" / "private").resolve()
ARTIFACT_ROOT = (EXPERIMENT_ROOT / "artifacts").resolve()


def _is_within(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
    except ValueError:
        return False
    return True


def _assert_private_path(path: Path, *, label: str) -> Path:
    resolved = path.resolve()
    if _is_within(resolved, EXPERIMENT_ROOT) and not _is_within(
        resolved,
        PRIVATE_ROOT,
    ):
        raise CorpusValidationError(
            f"{label} inside the experiment must stay under data/private"
        )
    return resolved


def _assert_safe_report_path(path: Path) -> Path:
    resolved = path.resolve()
    if _is_within(resolved, EXPERIMENT_ROOT) and not (
        _is_within(resolved, ARTIFACT_ROOT)
        or _is_within(resolved, PRIVATE_ROOT)
    ):
        raise CorpusValidationError(
            "generated reports inside the experiment must stay under "
            "artifacts or data/private"
        )
    return resolved


def _atomic_write(path: Path, contents: str, *, refuse_existing: bool) -> None:
    if refuse_existing and path.exists():
        raise CorpusValidationError(f"refusing to overwrite existing file: {path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    staging = path.with_name(f".{path.name}.tmp-{os.getpid()}")
    try:
        staging.write_text(contents, encoding="utf-8")
        if refuse_existing:
            try:
                os.link(staging, path)
            except FileExistsError as error:
                raise CorpusValidationError(
                    f"refusing to overwrite existing file: {path}"
                ) from error
        else:
            staging.replace(path)
    finally:
        staging.unlink(missing_ok=True)


def _labels_jsonl(labels: Sequence[ShadowLabelRecord]) -> str:
    return "".join(
        f"{label.model_dump_json(by_alias=True)}\n" for label in labels
    )


def _load_holdout_lock(path: Path) -> HoldoutLock:
    try:
        return HoldoutLock.model_validate_json(path.read_text(encoding="utf-8"))
    except (OSError, ValidationError, ValueError) as error:
        raise CorpusValidationError(
            f"cannot load holdout lock {path}: {error}"
        ) from error


def _init_labels(args: argparse.Namespace) -> dict[str, object]:
    output = _assert_private_path(Path(args.output), label="label output")
    records = load_shadow_log_jsonl(Path(args.shadow_log))
    labels = build_label_template(records, split=args.split)
    _atomic_write(
        output,
        _labels_jsonl(labels),
        refuse_existing=True,
    )
    return {
        "schemaVersion": 1,
        "operation": "init-labels",
        "draftLabels": len(labels),
        "split": args.split,
        "privacyBoundary": "hash-only; no query, candidate, or manuscript text",
    }


def _paired_cases(args: argparse.Namespace):
    label_path = _assert_private_path(Path(args.labels), label="label input")
    records = load_shadow_log_jsonl(Path(args.shadow_log))
    labels = load_label_jsonl(label_path)
    return pair_shadow_records(records, labels)


def _validate(args: argparse.Namespace) -> dict[str, object]:
    cases = _paired_cases(args)
    holdout_valid = False
    if args.holdout_lock is not None:
        lock_path = _assert_private_path(
            Path(args.holdout_lock),
            label="holdout lock",
        )
        lock = _load_holdout_lock(lock_path)
        verify_holdout_lock(cases, lock)
        holdout_valid = True
    report = build_safe_report(
        cases,
        holdout_lock_valid=holdout_valid,
    )
    if args.report is not None:
        report_path = _assert_safe_report_path(Path(args.report))
        _atomic_write(
            report_path,
            f"{json.dumps(report, ensure_ascii=False, indent=2)}\n",
            refuse_existing=False,
        )
    return report


def _freeze_holdout(args: argparse.Namespace) -> dict[str, object]:
    output = _assert_private_path(
        Path(args.output),
        label="holdout lock output",
    )
    cases = _paired_cases(args)
    lock = create_holdout_lock(cases)
    _atomic_write(
        output,
        f"{lock.model_dump_json(by_alias=True, indent=2)}\n",
        refuse_existing=True,
    )
    return {
        "schemaVersion": 1,
        "operation": "freeze-holdout",
        "caseCount": lock.case_count,
        "workCount": lock.work_count,
        "byLanguage": lock.by_language,
        "privacyBoundary": "hash-only; existing locks are never overwritten",
    }


def _hash_scene_id(_args: argparse.Namespace) -> dict[str, object]:
    scene_id = sys.stdin.readline().rstrip("\r\n")
    if not scene_id:
        raise CorpusValidationError(
            "hash-scene-id expects one non-empty scene ID on stdin"
        )
    digest = hashlib.sha256(
        f"scene\0{scene_id}".encode("utf-8")
    ).hexdigest()
    return {
        "schemaVersion": 1,
        "sceneHash": digest,
    }


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Manage hash-only labels joined to the development Semantic "
            "Reranker shadow log."
        )
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    init = subparsers.add_parser(
        "init-labels",
        help="create an unreviewed top-10-union label template",
    )
    init.add_argument("--shadow-log", required=True)
    init.add_argument("--output", required=True)
    init.add_argument(
        "--split",
        choices=("shadow-private-dev", "frozen-holdout"),
        default="shadow-private-dev",
    )
    init.set_defaults(handler=_init_labels)

    validate = subparsers.add_parser(
        "validate",
        help="validate labels and emit an aggregate-only readiness report",
    )
    validate.add_argument("--shadow-log", required=True)
    validate.add_argument("--labels", required=True)
    validate.add_argument("--holdout-lock")
    validate.add_argument("--report")
    validate.set_defaults(handler=_validate)

    freeze = subparsers.add_parser(
        "freeze-holdout",
        help="write a non-overwriting fingerprint lock for verified holdout cases",
    )
    freeze.add_argument("--shadow-log", required=True)
    freeze.add_argument("--labels", required=True)
    freeze.add_argument("--output", required=True)
    freeze.set_defaults(handler=_freeze_holdout)

    hash_scene = subparsers.add_parser(
        "hash-scene-id",
        help="read one local scene ID from stdin and emit its privacy hash",
    )
    hash_scene.set_defaults(handler=_hash_scene_id)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = _parser()
    args = parser.parse_args(argv)
    try:
        result = args.handler(args)
    except (CorpusValidationError, OSError, ValueError) as error:
        parser.exit(2, f"[artifact] {error}\n")
    sys.stdout.write(f"{json.dumps(result, ensure_ascii=False, indent=2)}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
