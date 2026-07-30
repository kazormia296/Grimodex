from __future__ import annotations

from pathlib import Path
import re
import tomllib
import unittest


EXPERIMENT_ROOT = Path(__file__).resolve().parents[1]
MINIMUM_SAFE_TRANSFORMERS = (5, 5, 0)


def _pinned_transformers_version() -> tuple[int, int, int]:
    project = tomllib.loads(
        (EXPERIMENT_ROOT / "pyproject.toml").read_text(encoding="utf-8")
    )["project"]
    dependency = next(
        value
        for value in project["dependencies"]
        if value.startswith("transformers==")
    )
    match = re.fullmatch(r"transformers==(\d+)\.(\d+)\.(\d+)", dependency)
    if match is None:
        raise AssertionError("transformers must use an exact semantic-version pin")
    return tuple(int(part) for part in match.groups())


class SupplyChainTests(unittest.TestCase):
    def test_transformers_excludes_known_remote_code_execution_ranges(self) -> None:
        self.assertGreaterEqual(
            _pinned_transformers_version(),
            MINIMUM_SAFE_TRANSFORMERS,
        )


if __name__ == "__main__":
    unittest.main()
