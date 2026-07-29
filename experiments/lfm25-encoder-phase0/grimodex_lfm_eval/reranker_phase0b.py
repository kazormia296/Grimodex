"""Shared contracts and runtime for the Phase 0b quantized reranker gate."""

from __future__ import annotations

import hashlib
import math
from pathlib import Path, PurePosixPath
import re
from typing import Any, Literal

import numpy as np
from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    field_validator,
    model_validator,
)
import yaml

from .config import configure_hugging_face_environment
from .provenance import (
    load_manifest,
    require_pinned_revision,
    verify_file_manifest,
)


SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")


class _ConfigModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)


class Phase0bBenchmarkConfig(_ConfigModel):
    max_pair_tokens: int = Field(gt=0, le=8192)
    batch_sizes: tuple[int, ...] = Field(min_length=1)
    thread_counts: tuple[int | Literal["physical"], ...] = Field(min_length=1)
    warmup_count: int = Field(ge=0)
    repetitions: int = Field(ge=30)
    cold_repetitions: int = Field(ge=5)
    bootstrap_iterations: int = Field(gt=0)

    @field_validator("batch_sizes")
    @classmethod
    def validate_batch_sizes(cls, values: tuple[int, ...]) -> tuple[int, ...]:
        if any(value <= 0 for value in values):
            raise ValueError("batch sizes must be positive")
        if len(values) != len(set(values)):
            raise ValueError("batch sizes must be unique")
        return values

    @field_validator("thread_counts")
    @classmethod
    def validate_thread_counts(
        cls,
        values: tuple[int | Literal["physical"], ...],
    ) -> tuple[int | Literal["physical"], ...]:
        numeric = [value for value in values if isinstance(value, int)]
        if any(value <= 0 for value in numeric):
            raise ValueError("thread counts must be positive")
        if len(values) != len(set(values)):
            raise ValueError("thread counts must be unique")
        return values


class SessionPolicy(_ConfigModel):
    enable_memory_pattern: bool = False
    enable_cpu_arena: bool = False
    inter_op_threads: int = Field(default=1, gt=0)


class RerankerModelSpec(_ConfigModel):
    key: str = Field(pattern=r"^[a-z0-9_]+$")
    language: Literal["ja", "en"]
    model_id: str = Field(alias="id", min_length=1)
    revision: str
    license: str = Field(min_length=1)
    quantization: str = Field(min_length=1)
    artifact: str = Field(min_length=1)
    artifact_sha256: str
    local_snapshot: str = Field(min_length=1)
    manifest: str = Field(min_length=1)
    files: tuple[str, ...] = Field(min_length=1)

    @field_validator("revision")
    @classmethod
    def validate_revision(cls, value: str) -> str:
        return require_pinned_revision(value)

    @field_validator("artifact_sha256")
    @classmethod
    def validate_artifact_sha256(cls, value: str) -> str:
        normalized = value.strip().lower()
        if not SHA256_PATTERN.fullmatch(normalized):
            raise ValueError("artifact_sha256 must be a lowercase SHA-256 digest")
        return normalized

    @field_validator("artifact", "local_snapshot", "manifest")
    @classmethod
    def validate_relative_path(cls, value: str) -> str:
        path = PurePosixPath(value)
        if path.is_absolute() or ".." in path.parts or str(path) != value:
            raise ValueError("model paths must be normalized relative paths")
        return value

    @field_validator("files")
    @classmethod
    def validate_files(cls, values: tuple[str, ...]) -> tuple[str, ...]:
        if len(values) != len(set(values)):
            raise ValueError("model files must be unique")
        for value in values:
            path = PurePosixPath(value)
            if path.is_absolute() or ".." in path.parts or str(path) != value:
                raise ValueError("model files must be normalized relative paths")
            if value.endswith((".bin", ".safetensors")):
                raise ValueError("Phase 0b must not download unquantized weights")
        return values

    @model_validator(mode="after")
    def validate_artifact_is_selected(self) -> "RerankerModelSpec":
        if self.artifact not in self.files:
            raise ValueError("artifact must be included in files")
        return self


class Phase0bConfig(_ConfigModel):
    schema_version: Literal[1]
    benchmark: Phase0bBenchmarkConfig
    session: SessionPolicy
    offline_environment: dict[str, str] = Field(default_factory=dict)
    models: tuple[RerankerModelSpec, ...] = Field(min_length=1)

    @model_validator(mode="after")
    def validate_unique_models(self) -> "Phase0bConfig":
        keys = [model.key for model in self.models]
        if len(keys) != len(set(keys)):
            raise ValueError("duplicate model key")
        identities = [(model.model_id, model.revision) for model in self.models]
        if len(identities) != len(set(identities)):
            raise ValueError("duplicate model identity")
        return self

    def model(self, key: str) -> RerankerModelSpec:
        for model in self.models:
            if model.key == key:
                return model
        available = ", ".join(model.key for model in self.models)
        raise ValueError(f"unknown model key {key!r}; available: {available}")


def load_phase0b_config(path: Path) -> Phase0bConfig:
    payload = yaml.safe_load(path.resolve().read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("Phase 0b configuration must be a mapping")
    return Phase0bConfig.model_validate(payload)


def resolve_model_paths(
    config_path: Path,
    model: RerankerModelSpec,
) -> tuple[Path, Path, Path]:
    experiment_root = config_path.resolve().parent.parent
    snapshot = (experiment_root / model.local_snapshot).resolve()
    manifest = (experiment_root / model.manifest).resolve()
    artifact = (snapshot / model.artifact).resolve()
    for path in (snapshot, manifest, artifact):
        try:
            path.relative_to(experiment_root)
        except ValueError as error:
            raise ValueError(
                "Phase 0b model paths must remain inside the experiment directory"
            ) from error
    try:
        artifact.relative_to(snapshot)
    except ValueError as error:
        raise ValueError("Phase 0b artifact must remain inside its snapshot") from error
    return snapshot, manifest, artifact


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verify_model_snapshot(
    config_path: Path,
    model: RerankerModelSpec,
) -> tuple[Path, Path, str]:
    snapshot, manifest_path, artifact = resolve_model_paths(config_path, model)
    manifest, expected_manifest_hash = load_manifest(manifest_path)
    actual_manifest_hash = verify_file_manifest(snapshot, manifest)
    if actual_manifest_hash != expected_manifest_hash:
        raise ValueError("snapshot manifest hash changed during verification")
    artifact_hash = sha256_file(artifact)
    if artifact_hash != model.artifact_sha256:
        raise ValueError(
            f"{model.key} artifact SHA-256 mismatch: "
            f"expected {model.artifact_sha256}, got {artifact_hash}"
        )
    return snapshot, artifact, actual_manifest_hash


def build_session_options(
    thread_count: int,
    *,
    ort_module: Any | None = None,
    policy: SessionPolicy | None = None,
) -> Any:
    if thread_count <= 0:
        raise ValueError("thread_count must be positive")
    if ort_module is None:
        import onnxruntime as ort_module

    selected_policy = policy or SessionPolicy()
    options = ort_module.SessionOptions()
    options.enable_mem_pattern = selected_policy.enable_memory_pattern
    options.enable_cpu_mem_arena = selected_policy.enable_cpu_arena
    options.intra_op_num_threads = thread_count
    options.inter_op_num_threads = selected_policy.inter_op_threads
    options.execution_mode = ort_module.ExecutionMode.ORT_SEQUENTIAL
    options.graph_optimization_level = (
        ort_module.GraphOptimizationLevel.ORT_ENABLE_ALL
    )
    return options


class OnnxRerankerRuntime:
    def __init__(
        self,
        *,
        tokenizer: Any,
        session: Any,
        max_pair_tokens: int,
    ) -> None:
        if max_pair_tokens <= 0:
            raise ValueError("max_pair_tokens must be positive")
        self.tokenizer = tokenizer
        self.session = session
        self.max_pair_tokens = max_pair_tokens
        self.input_names = tuple(item.name for item in session.get_inputs())
        self.last_attention_tokens = 0
        self.last_padded_tokens = 0

    def score_pairs(self, query: str, passages: list[str]) -> list[float]:
        if not query:
            raise ValueError("query must not be empty")
        if not passages or any(not passage for passage in passages):
            raise ValueError("passages must contain non-empty text")
        encoded = self.tokenizer(
            [query] * len(passages),
            passages,
            max_length=self.max_pair_tokens,
            padding=True,
            truncation=True,
            return_tensors="np",
        )
        input_ids = np.asarray(encoded["input_ids"], dtype=np.int64)
        feeds: dict[str, np.ndarray] = {}
        for name in self.input_names:
            if name in encoded:
                feeds[name] = np.asarray(encoded[name], dtype=np.int64)
            elif name == "token_type_ids":
                feeds[name] = np.zeros_like(input_ids, dtype=np.int64)
            else:
                raise ValueError(f"tokenizer did not produce required ONNX input {name}")

        attention_mask = np.asarray(encoded["attention_mask"], dtype=np.int64)
        self.last_attention_tokens = int(attention_mask.sum())
        self.last_padded_tokens = int(attention_mask.size)
        outputs = self.session.run(None, feeds)
        if not outputs:
            raise ValueError("ONNX session returned no outputs")
        logits = np.asarray(outputs[0])
        if logits.ndim == 2 and logits.shape[1] == 1:
            logits = logits[:, 0]
        if logits.ndim != 1 or logits.shape[0] != len(passages):
            raise ValueError("reranker must return exactly one logit per passage")
        scores = [float(value) for value in logits]
        if any(not math.isfinite(score) for score in scores):
            raise ValueError("reranker logits must be finite")
        return scores


class TokenizersPairAdapter:
    """Expose a minimal Transformers-like pair tokenizer without importing Torch."""

    def __init__(self, tokenizer: Any) -> None:
        self.tokenizer = tokenizer

    def __call__(
        self,
        queries: list[str],
        passages: list[str],
        *,
        max_length: int,
        padding: bool,
        truncation: bool,
        return_tensors: str,
    ) -> dict[str, np.ndarray]:
        if len(queries) != len(passages):
            raise ValueError("query and passage counts must match")
        if not padding or not truncation or return_tensors != "np":
            raise ValueError("Phase 0b tokenizer requires padded truncated NumPy output")
        self.tokenizer.enable_truncation(
            max_length=max_length,
            strategy="longest_first",
        )
        self.tokenizer.enable_padding()
        encodings = self.tokenizer.encode_batch(
            list(zip(queries, passages, strict=True)),
            add_special_tokens=True,
        )
        return {
            "input_ids": np.asarray(
                [encoding.ids for encoding in encodings],
                dtype=np.int64,
            ),
            "attention_mask": np.asarray(
                [encoding.attention_mask for encoding in encodings],
                dtype=np.int64,
            ),
            "token_type_ids": np.asarray(
                [encoding.type_ids for encoding in encodings],
                dtype=np.int64,
            ),
        }


def load_onnx_reranker(
    config_path: Path,
    config: Phase0bConfig,
    model: RerankerModelSpec,
    *,
    thread_count: int,
) -> tuple[OnnxRerankerRuntime, str]:
    experiment_root = config_path.resolve().parent.parent
    configure_hugging_face_environment(
        experiment_root,
        offline=True,
        configured_values=config.offline_environment,
    )
    snapshot, artifact, manifest_hash = verify_model_snapshot(config_path, model)

    import onnxruntime as ort
    from tokenizers import Tokenizer

    tokenizer = TokenizersPairAdapter(
        Tokenizer.from_file(str(snapshot / "tokenizer.json"))
    )
    options = build_session_options(
        thread_count,
        ort_module=ort,
        policy=config.session,
    )
    session = ort.InferenceSession(
        str(artifact),
        sess_options=options,
        providers=["CPUExecutionProvider"],
    )
    return (
        OnnxRerankerRuntime(
            tokenizer=tokenizer,
            session=session,
            max_pair_tokens=config.benchmark.max_pair_tokens,
        ),
        manifest_hash,
    )
