#!/usr/bin/env python3
"""Capture benchmark host and dependency provenance as JSON."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from grimodex_lfm_eval.host_profile import capture_host_profile
from grimodex_lfm_eval.provenance import require_pinned_revision


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-revision", required=True)
    parser.add_argument("--checkpoint-hash")
    parser.add_argument("--dtype", default="float32")
    parser.add_argument("--output", type=Path, required=True)
    arguments = parser.parse_args()
    profile = capture_host_profile(
        model_revision=require_pinned_revision(arguments.model_revision),
        checkpoint_hash=arguments.checkpoint_hash,
        dtype=arguments.dtype,
    )
    arguments.output.parent.mkdir(parents=True, exist_ok=True)
    arguments.output.write_text(
        json.dumps(profile, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
