from __future__ import annotations

from pathlib import Path
import re
import tomllib
import unittest


EXPERIMENT_ROOT = Path(__file__).resolve().parents[1]
MINIMUM_SAFE_TRANSFORMERS = (5, 5, 0)
MINIMUM_SAFE_SETUPTOOLS = (83, 0, 0)
MINIMUM_SAFE_PYTEST = (9, 0, 3)
MINIMUM_SAFE_TORCH = (2, 13, 0)


def _project_config() -> dict[str, object]:
    return tomllib.loads(
        (EXPERIMENT_ROOT / "pyproject.toml").read_text(encoding="utf-8")
    )


def _pinned_version(
    dependencies: list[str], package_name: str
) -> tuple[int, int, int]:
    dependency = next(
        value
        for value in dependencies
        if value.startswith(f"{package_name}==")
    )
    match = re.fullmatch(
        rf"{re.escape(package_name)}==(\d+)\.(\d+)\.(\d+)", dependency
    )
    if match is None:
        raise AssertionError(
            f"{package_name} must use an exact semantic-version pin"
        )
    return tuple(int(part) for part in match.groups())


class SupplyChainTests(unittest.TestCase):
    def test_transformers_excludes_known_remote_code_execution_ranges(self) -> None:
        project = _project_config()["project"]
        self.assertGreaterEqual(
            _pinned_version(project["dependencies"], "transformers"),
            MINIMUM_SAFE_TRANSFORMERS,
        )

    def test_setuptools_excludes_manifest_normalization_bypass(self) -> None:
        build_system = _project_config()["build-system"]
        self.assertGreaterEqual(
            _pinned_version(build_system["requires"], "setuptools"),
            MINIMUM_SAFE_SETUPTOOLS,
        )

    def test_pytest_excludes_insecure_tmpdir_handling(self) -> None:
        dependency_groups = _project_config()["dependency-groups"]
        self.assertGreaterEqual(
            _pinned_version(dependency_groups["dev"], "pytest"),
            MINIMUM_SAFE_PYTEST,
        )

    def test_torch_excludes_jit_script_memory_corruption(self) -> None:
        optional_dependencies = _project_config()["project"][
            "optional-dependencies"
        ]
        for extra in ("cpu", "cu130", "rocm72"):
            with self.subTest(extra=extra):
                self.assertGreaterEqual(
                    _pinned_version(optional_dependencies[extra], "torch"),
                    MINIMUM_SAFE_TORCH,
                )


if __name__ == "__main__":
    unittest.main()
