from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest

import numpy as np

from grimodex_lfm_eval.reranker_phase0b import (
    OnnxRerankerRuntime,
    TokenizersPairAdapter,
    build_session_options,
    load_phase0b_config,
)


CONFIG_PATH = (
    Path(__file__).resolve().parents[1] / "configs" / "phase0b-rerankers.yaml"
)


class _FakeSessionOptions:
    def __init__(self) -> None:
        self.enable_mem_pattern = True
        self.enable_cpu_mem_arena = True
        self.intra_op_num_threads = 0
        self.inter_op_num_threads = 0
        self.execution_mode = None
        self.graph_optimization_level = None


class _FakeOrt:
    SessionOptions = _FakeSessionOptions
    ExecutionMode = SimpleNamespace(ORT_SEQUENTIAL="sequential")
    GraphOptimizationLevel = SimpleNamespace(ORT_ENABLE_ALL="all")


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
            "input_ids": np.ones((rows, 4), dtype=np.int64),
            "attention_mask": np.ones((rows, 4), dtype=np.int64),
            "token_type_ids": np.zeros((rows, 4), dtype=np.int64),
            "special_tokens_mask": np.zeros((rows, 4), dtype=np.int64),
        }


class _FakeSession:
    def __init__(self, logits: np.ndarray | None = None) -> None:
        self._logits = (
            logits
            if logits is not None
            else np.asarray([[1.25], [-2.0]], dtype=np.float32)
        )
        self.last_feeds: dict[str, np.ndarray] | None = None

    def get_inputs(self) -> list[SimpleNamespace]:
        return [
            SimpleNamespace(name="input_ids"),
            SimpleNamespace(name="attention_mask"),
            SimpleNamespace(name="token_type_ids"),
        ]

    def run(
        self,
        output_names: None,
        feeds: dict[str, np.ndarray],
    ) -> list[np.ndarray]:
        self.last_feeds = feeds
        return [self._logits]


class _FakeEncoding:
    ids = [2, 11, 3]
    attention_mask = [1, 1, 1]
    type_ids = [0, 0, 0]
    special_tokens_mask = [1, 0, 1]


class _FakeRawTokenizer:
    def __init__(self) -> None:
        self.padding_options: dict[str, object] | None = None

    def enable_truncation(self, **_options: object) -> None:
        return None

    def enable_padding(self, **options: object) -> None:
        self.padding_options = options

    def encode_batch(
        self,
        pairs: list[tuple[str, str]],
        *,
        add_special_tokens: bool,
    ) -> list[_FakeEncoding]:
        assert add_special_tokens
        return [_FakeEncoding() for _pair in pairs]


class Phase0bConfigTests(unittest.TestCase):
    def test_config_pins_the_three_official_avx2_artifacts(self) -> None:
        config = load_phase0b_config(CONFIG_PATH)

        self.assertEqual(config.schema_version, 1)
        self.assertEqual(config.benchmark.max_pair_tokens, 512)
        self.assertEqual(
            {model.key: model.revision for model in config.models},
            {
                "ja_tiny": "ba95175a4d53058816b971f31929f10c5cad8560",
                "ja_xsmall": "de99fd2f16c7b5df1df1bcc1d9ad2c16d88ce93a",
                "en_minilm_l4": "777b2f369bc1c2f850df8bd367ed1654bda4497b",
            },
        )
        self.assertEqual(
            {model.key: model.artifact_sha256 for model in config.models},
            {
                "ja_tiny": (
                    "649a18583e21ad532e420a4ded4c9c4f"
                    "f7ce882aa84af2bf2180ec4d4f679e38"
                ),
                "ja_xsmall": (
                    "34d4657df53c875f970dbf87e584a21d"
                    "59e6cfcd9368f9828d69a09ed152168f"
                ),
                "en_minilm_l4": (
                    "74118ad9ab2b17990c40f03085a91f1"
                    "31339bb3a6d629e96507a6dbf063dae3d"
                ),
            },
        )
        for model in config.models:
            with self.subTest(model=model.key):
                self.assertIn(model.artifact, model.files)
                self.assertFalse(
                    any(
                        file.endswith((".bin", ".safetensors"))
                        for file in model.files
                    )
                )

    def test_duplicate_model_keys_are_rejected(self) -> None:
        config_text = CONFIG_PATH.read_text(encoding="utf-8")
        duplicate_text = config_text.replace(
            "key: ja_xsmall",
            "key: ja_tiny",
            1,
        )
        with tempfile.TemporaryDirectory() as temporary_directory:
            temporary_path = Path(temporary_directory) / "phase0b.yaml"
            temporary_path.write_text(duplicate_text, encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "duplicate model key"):
                load_phase0b_config(temporary_path)


class SessionPolicyTests(unittest.TestCase):
    def test_session_disables_shape_sensitive_allocators(self) -> None:
        options = build_session_options(6, ort_module=_FakeOrt)

        self.assertFalse(options.enable_mem_pattern)
        self.assertFalse(options.enable_cpu_mem_arena)
        self.assertEqual(options.intra_op_num_threads, 6)
        self.assertEqual(options.inter_op_num_threads, 1)
        self.assertEqual(options.execution_mode, "sequential")
        self.assertEqual(options.graph_optimization_level, "all")

    def test_non_positive_thread_count_is_rejected(self) -> None:
        with self.assertRaisesRegex(ValueError, "thread_count"):
            build_session_options(0, ort_module=_FakeOrt)


class OnnxRerankerRuntimeTests(unittest.TestCase):
    def test_direct_tokenizer_uses_the_model_defined_padding_identity(self) -> None:
        raw_tokenizer = _FakeRawTokenizer()
        tokenizer = TokenizersPairAdapter(
            raw_tokenizer,
            pad_id=3,
            pad_token="<pad>",
        )

        encoded = tokenizer(
            ["query"],
            ["passage"],
            max_length=512,
            padding=True,
            truncation=True,
            return_tensors="np",
            return_special_tokens_mask=True,
        )

        self.assertEqual(
            raw_tokenizer.padding_options,
            {"pad_id": 3, "pad_token": "<pad>"},
        )
        self.assertEqual(encoded["special_tokens_mask"].tolist(), [[1, 0, 1]])

    def test_pair_scores_preserve_order_and_filter_tokenizer_outputs(self) -> None:
        tokenizer = _FakeTokenizer()
        session = _FakeSession()
        runtime = OnnxRerankerRuntime(
            tokenizer=tokenizer,
            session=session,
            max_pair_tokens=512,
        )

        scores = runtime.score_pairs(
            "失踪した王女",
            ["港で目撃された。", "王女は城にいる。"],
        )

        self.assertEqual(scores, [1.25, -2.0])
        self.assertEqual(
            set(session.last_feeds or {}),
            {"input_ids", "attention_mask", "token_type_ids"},
        )
        self.assertEqual(tokenizer.calls[0]["max_length"], 512)
        self.assertEqual(tokenizer.calls[0]["padding"], True)
        self.assertEqual(tokenizer.calls[0]["truncation"], True)
        self.assertEqual(tokenizer.calls[0]["return_tensors"], "np")
        self.assertEqual(
            tokenizer.calls[0]["queries"],
            ["失踪した王女", "失踪した王女"],
        )

    def test_empty_passage_list_is_rejected(self) -> None:
        runtime = OnnxRerankerRuntime(
            tokenizer=_FakeTokenizer(),
            session=_FakeSession(),
            max_pair_tokens=512,
        )

        with self.assertRaisesRegex(ValueError, "passage"):
            runtime.score_pairs("query", [])

    def test_multi_logit_output_is_rejected(self) -> None:
        runtime = OnnxRerankerRuntime(
            tokenizer=_FakeTokenizer(),
            session=_FakeSession(np.ones((2, 2), dtype=np.float32)),
            max_pair_tokens=512,
        )

        with self.assertRaisesRegex(ValueError, "one logit"):
            runtime.score_pairs("query", ["one", "two"])


if __name__ == "__main__":
    unittest.main()
