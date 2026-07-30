#!/usr/bin/env python3
"""Build the deterministic public synthetic corpus for Impact Gate 4."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

from grimodex_lfm_eval.impact_gate4 import build_impact_probe_records


def _encoded_corpus() -> str:
    return "".join(
        json.dumps(
            record.model_dump(mode="json", by_alias=True),
            ensure_ascii=False,
            separators=(",", ":"),
            sort_keys=True,
        )
        + "\n"
        for record in build_impact_probe_records()
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("data/public/gate4/impact-probe-ja.jsonl"),
    )
    parser.add_argument(
        "--replace",
        action="store_true",
        help="Replace an existing generated corpus after an intentional contract update.",
    )
    arguments = parser.parse_args()
    destination = arguments.output.resolve()
    encoded = _encoded_corpus()
    if destination.exists():
        current = destination.read_text(encoding="utf-8")
        if current != encoded and not arguments.replace:
            raise SystemExit(
                f"refusing to overwrite drifted Gate 4 corpus: {destination}"
            )
        if current != encoded:
            destination.write_text(encoded, encoding="utf-8")
    else:
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(encoded, encoding="utf-8")
    print(
        json.dumps(
            {
                "output": str(destination),
                "recordCount": encoded.count("\n"),
                "sha256": hashlib.sha256(encoded.encode("utf-8")).hexdigest(),
            },
            ensure_ascii=False,
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
