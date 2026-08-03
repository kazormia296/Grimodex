from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest

import numpy as np

from grimodex_lfm_eval.impact_gate3 import (
    ImpactGate3Runtime,
    canonical_impact_query,
    load_impact_gate3_config,
    load_impact_gate3_workload,
)


EXPERIMENT_ROOT = Path(__file__).resolve().parents[1]
CONFIG_PATH = EXPERIMENT_ROOT / "configs" / "phase0b-impact-gate3.yaml"


class _FakeTokenizer:
    def __init__(self) -> None:
        self.calls: list[dict[str, object]] = []

    def __call__(
        self,
        queries: list[str],
        passages: list[str],
        **options: object,
    ) -> dict[str, np.ndarray]:
        self.calls.append(
            {
                "queries": queries,
                "passages": passages,
                **options,
            }
        )
        rows = len(passages)
        return {
            "input_ids": np.ones((rows, 6), dtype=np.int64),
            "attention_mask": np.ones((rows, 6), dtype=np.int64),
            "token_type_ids": np.zeros((rows, 6), dtype=np.int64),
        }


class _FakeClassifier:
    def __init__(self) -> None:
        self.last_inputs: dict[str, np.ndarray] | None = None

    def __call__(self, **inputs: np.ndarray) -> SimpleNamespace:
        self.last_inputs = inputs
        rows = inputs["input_ids"].shape[0]
        return SimpleNamespace(
            logits=np.arange(rows, dtype=np.float32).reshape(rows, 1)
        )


class ImpactGate3ConfigTests(unittest.TestCase):
    def test_config_pins_models_workload_and_speed_contract(self) -> None:
        config = load_impact_gate3_config(CONFIG_PATH)

        self.assertEqual(config.schema_version, 1)
        self.assertEqual(config.benchmark.max_pair_tokens, 512)
        self.assertEqual(config.benchmark.query_token_budget, 128)
        self.assertEqual(config.benchmark.scene_token_budget, 384)
        self.assertEqual(config.benchmark.candidate_count, 30)
        self.assertEqual(config.benchmark.target_seconds, 5.0)
        self.assertEqual(config.benchmark.conditional_seconds, 10.0)
        self.assertEqual(config.benchmark.hold_seconds, 20.0)
        self.assertEqual(
            config.workload.source_sha256,
            "cd1dbf5fbf18c9d28a5f924f0771bcb169c635279300670eb39c2bc053bd0234",
        )
        self.assertEqual(config.workload.source_query_id, "ja-r01")
        self.assertEqual(
            {model.key: model.revision for model in config.models},
            {
                "ja_xsmall": "de99fd2f16c7b5df1df1bcc1d9ad2c16d88ce93a",
                "modernbert_ja_30m": (
                    "8cb03f54cb9e30e72459e5f1cedc6d89c7d8dcb5"
                ),
            },
        )
        self.assertEqual(
            {model.key: model.weight_sha256 for model in config.models},
            {
                "ja_xsmall": (
                    "93a48c41e3deeb772a024057ed163f80"
                    "3dfe550052b9e2155cbe2b9631602961"
                ),
                "modernbert_ja_30m": (
                    "de292c27183e6b158bafbe91e61afd4"
                    "c107aeed702b94394ac643f2f6aa62065"
                ),
            },
        )

    def test_config_rejects_a_floating_revision(self) -> None:
        config_text = CONFIG_PATH.read_text(encoding="utf-8").replace(
            "de99fd2f16c7b5df1df1bcc1d9ad2c16d88ce93a",
            "main",
            1,
        )
        with tempfile.TemporaryDirectory() as temporary_directory:
            config_path = Path(temporary_directory) / "gate3.yaml"
            config_path.write_text(config_text, encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "40-character"):
                load_impact_gate3_config(config_path)


class ImpactGate3WorkloadTests(unittest.TestCase):
    def test_workload_uses_exactly_thirty_frozen_public_candidates(self) -> None:
        config = load_impact_gate3_config(CONFIG_PATH)
        workload = load_impact_gate3_workload(CONFIG_PATH, config)

        self.assertEqual(len(workload.candidates), 30)
        self.assertEqual(
            [candidate.dense_rank for candidate in workload.candidates],
            list(range(1, 31)),
        )
        self.assertEqual(
            len({candidate.candidate_id for candidate in workload.candidates}),
            30,
        )
        self.assertTrue(workload.query.startswith("[CODEX_CHANGE]\n{"))
        self.assertTrue(
            all(candidate.text.startswith("[SCENE]\n") for candidate in workload.candidates)
        )
        self.assertNotIn("sceneTitle", workload.query)

    def test_workload_rejects_source_hash_drift(self) -> None:
        config = load_impact_gate3_config(CONFIG_PATH)
        changed = config.model_copy(
            update={
                "workload": config.workload.model_copy(
                    update={"source_sha256": "0" * 64}
                )
            }
        )

        with self.assertRaisesRegex(ValueError, "SHA-256"):
            load_impact_gate3_workload(CONFIG_PATH, changed)

    def test_impact_query_is_canonical_compact_json(self) -> None:
        query = canonical_impact_query(
            {
                "entry_name": "朱音",
                "changes": [{"new": "新", "old": "旧"}],
                "change_id": "gate3",
            }
        )

        self.assertEqual(
            query,
            (
                '[CODEX_CHANGE]\n{"change_id":"gate3","changes":'
                '[{"new":"新","old":"旧"}],"entry_name":"朱音"}'
            ),
        )


class ImpactGate3RuntimeTests(unittest.TestCase):
    def test_runtime_preserves_the_diff_and_truncates_only_the_scene(self) -> None:
        tokenizer = _FakeTokenizer()
        classifier = _FakeClassifier()
        runtime = ImpactGate3Runtime(
            tokenizer=tokenizer,
            classifier=classifier,
            max_pair_tokens=512,
        )

        scores = runtime.score_pairs(
            "[CODEX_CHANGE]\n{}",
            ["[SCENE]\n一", "[SCENE]\n二"],
        )

        self.assertEqual(scores, [0.0, 1.0])
        self.assertEqual(tokenizer.calls[0]["max_length"], 512)
        self.assertEqual(tokenizer.calls[0]["padding"], True)
        self.assertEqual(tokenizer.calls[0]["truncation"], "only_second")
        self.assertEqual(tokenizer.calls[0]["return_tensors"], "np")
        self.assertEqual(
            tokenizer.calls[0]["queries"],
            ["[CODEX_CHANGE]\n{}", "[CODEX_CHANGE]\n{}"],
        )
        self.assertEqual(
            set(classifier.last_inputs or {}),
            {"input_ids", "attention_mask", "token_type_ids"},
        )

    def test_runtime_rejects_empty_or_oversized_batches(self) -> None:
        runtime = ImpactGate3Runtime(
            tokenizer=_FakeTokenizer(),
            classifier=_FakeClassifier(),
            max_pair_tokens=512,
        )

        with self.assertRaisesRegex(ValueError, "1..=30"):
            runtime.score_pairs("query", [])
        with self.assertRaisesRegex(ValueError, "1..=30"):
            runtime.score_pairs("query", ["scene"] * 31)


if __name__ == "__main__":
    unittest.main()
