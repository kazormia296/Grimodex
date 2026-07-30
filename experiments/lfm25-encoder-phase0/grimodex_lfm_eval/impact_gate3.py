"""Contracts and local runtime for Phase 0b Impact Review Gate 3."""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import inspect
import json
from pathlib import Path, PurePosixPath
import re
from types import SimpleNamespace
from typing import Any, Literal, Sequence

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
from .reranker_gate2 import load_gate2_jsonl


SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")


def _to_camel(value: str) -> str:
    head, *tail = value.split("_")
    return head + "".join(part.capitalize() for part in tail)


class _ConfigModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=_to_camel,
        extra="forbid",
        frozen=True,
        populate_by_name=True,
    )


class ImpactGate3BenchmarkConfig(_ConfigModel):
    max_pair_tokens: Literal[512]
    query_token_budget: Literal[128]
    scene_token_budget: Literal[384]
    candidate_count: Literal[30]
    batch_sizes: tuple[int, ...] = Field(min_length=1)
    thread_counts: tuple[int | Literal["physical"], ...] = Field(min_length=1)
    warmup_count: int = Field(ge=1)
    repetitions: int = Field(ge=30)
    cold_repetitions: int = Field(ge=5)
    bootstrap_iterations: int = Field(ge=100)
    target_seconds: Literal[5.0]
    conditional_seconds: Literal[10.0]
    hold_seconds: Literal[20.0]

    @field_validator("batch_sizes")
    @classmethod
    def validate_batch_sizes(cls, values: tuple[int, ...]) -> tuple[int, ...]:
        if any(value <= 0 or value > 30 for value in values):
            raise ValueError("Gate 3 batch sizes must be in 1..=30")
        if len(values) != len(set(values)):
            raise ValueError("Gate 3 batch sizes must be unique")
        return values

    @field_validator("thread_counts")
    @classmethod
    def validate_thread_counts(
        cls,
        values: tuple[int | Literal["physical"], ...],
    ) -> tuple[int | Literal["physical"], ...]:
        numeric = [value for value in values if isinstance(value, int)]
        if any(value <= 0 for value in numeric):
            raise ValueError("Gate 3 thread counts must be positive")
        if len(values) != len(set(values)):
            raise ValueError("Gate 3 thread counts must be unique")
        return values

    @model_validator(mode="after")
    def validate_speed_thresholds(self) -> "ImpactGate3BenchmarkConfig":
        if not (
            self.target_seconds
            < self.conditional_seconds
            < self.hold_seconds
        ):
            raise ValueError("Gate 3 speed thresholds must be strictly increasing")
        return self


class ImpactGate3WorkloadSpec(_ConfigModel):
    source_candidates: str = Field(min_length=1)
    source_sha256: str
    source_query_id: str = Field(min_length=1)
    diff_payload: dict[str, Any]

    @field_validator("source_candidates")
    @classmethod
    def validate_source_path(cls, value: str) -> str:
        path = PurePosixPath(value)
        if path.is_absolute() or ".." in path.parts or str(path) != value:
            raise ValueError("Gate 3 source path must be normalized and relative")
        return value

    @field_validator("source_sha256")
    @classmethod
    def validate_source_hash(cls, value: str) -> str:
        normalized = value.strip().lower()
        if not SHA256_PATTERN.fullmatch(normalized):
            raise ValueError("Gate 3 source SHA-256 must be a lowercase digest")
        return normalized

    @field_validator("diff_payload")
    @classmethod
    def validate_diff_payload(cls, value: dict[str, Any]) -> dict[str, Any]:
        required = {
            "change_id",
            "entry_id",
            "entry_name",
            "entry_type",
            "change_summary",
            "changes",
        }
        if set(value) != required:
            raise ValueError(
                "Gate 3 diff payload must use the production ImpactDiffPayload keys"
            )
        if not isinstance(value["changes"], list) or not value["changes"]:
            raise ValueError("Gate 3 diff payload needs at least one change")
        return value


class ImpactGate3ModelSpec(_ConfigModel):
    key: str = Field(pattern=r"^[a-z0-9_]+$")
    model_id: str = Field(alias="id", min_length=1)
    revision: str
    license: str = Field(min_length=1)
    dtype: Literal["float32"]
    weight: Literal["model.safetensors"]
    weight_sha256: str
    local_snapshot: str = Field(min_length=1)
    manifest: str = Field(min_length=1)
    files: tuple[str, ...] = Field(min_length=1)

    @field_validator("revision")
    @classmethod
    def validate_revision(cls, value: str) -> str:
        return require_pinned_revision(value)

    @field_validator("weight_sha256")
    @classmethod
    def validate_weight_hash(cls, value: str) -> str:
        normalized = value.strip().lower()
        if not SHA256_PATTERN.fullmatch(normalized):
            raise ValueError("Gate 3 weight SHA-256 must be a lowercase digest")
        return normalized

    @field_validator("local_snapshot", "manifest")
    @classmethod
    def validate_relative_path(cls, value: str) -> str:
        path = PurePosixPath(value)
        if path.is_absolute() or ".." in path.parts or str(path) != value:
            raise ValueError("Gate 3 model paths must be normalized and relative")
        return value

    @field_validator("files")
    @classmethod
    def validate_files(cls, values: tuple[str, ...]) -> tuple[str, ...]:
        if len(values) != len(set(values)):
            raise ValueError("Gate 3 model files must be unique")
        for value in values:
            path = PurePosixPath(value)
            if path.is_absolute() or ".." in path.parts or str(path) != value:
                raise ValueError("Gate 3 model files must be normalized and relative")
            if value.endswith(".py"):
                raise ValueError("Gate 3 snapshots must not contain remote model code")
        return values

    @model_validator(mode="after")
    def validate_weight_is_selected(self) -> "ImpactGate3ModelSpec":
        if self.weight not in self.files:
            raise ValueError("Gate 3 model weight must be included in files")
        return self


class ImpactGate3Config(_ConfigModel):
    schema_version: Literal[1]
    benchmark: ImpactGate3BenchmarkConfig
    offline_environment: dict[str, str] = Field(default_factory=dict)
    workload: ImpactGate3WorkloadSpec
    models: tuple[ImpactGate3ModelSpec, ...] = Field(min_length=2)

    @model_validator(mode="after")
    def validate_unique_models(self) -> "ImpactGate3Config":
        keys = [model.key for model in self.models]
        if len(keys) != len(set(keys)):
            raise ValueError("duplicate Gate 3 model key")
        identities = [(model.model_id, model.revision) for model in self.models]
        if len(identities) != len(set(identities)):
            raise ValueError("duplicate Gate 3 model identity")
        return self

    def model(self, key: str) -> ImpactGate3ModelSpec:
        for model in self.models:
            if model.key == key:
                return model
        available = ", ".join(model.key for model in self.models)
        raise ValueError(f"unknown Gate 3 model {key!r}; available: {available}")


@dataclass(frozen=True)
class ImpactGate3Candidate:
    candidate_id: str
    dense_rank: int
    text: str


@dataclass(frozen=True)
class ImpactGate3Workload:
    source_sha256: str
    source_query_id: str
    query: str
    candidates: tuple[ImpactGate3Candidate, ...]


def load_impact_gate3_config(path: Path) -> ImpactGate3Config:
    payload = yaml.safe_load(path.resolve().read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("Gate 3 configuration must be a mapping")
    return ImpactGate3Config.model_validate(payload)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _experiment_path(config_path: Path, relative: str) -> Path:
    experiment_root = config_path.resolve().parent.parent
    path = (experiment_root / relative).resolve()
    try:
        path.relative_to(experiment_root)
    except ValueError as error:
        raise ValueError("Gate 3 paths must remain inside the experiment") from error
    return path


def resolve_impact_model_paths(
    config_path: Path,
    model: ImpactGate3ModelSpec,
) -> tuple[Path, Path, Path]:
    snapshot = _experiment_path(config_path, model.local_snapshot)
    manifest = _experiment_path(config_path, model.manifest)
    weight = (snapshot / model.weight).resolve()
    try:
        weight.relative_to(snapshot)
    except ValueError as error:
        raise ValueError("Gate 3 weight must remain inside its snapshot") from error
    return snapshot, manifest, weight


def canonical_impact_query(diff_payload: dict[str, Any]) -> str:
    canonical = json.dumps(
        diff_payload,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    )
    return f"[CODEX_CHANGE]\n{canonical}"


def load_impact_gate3_workload(
    config_path: Path,
    config: ImpactGate3Config,
) -> ImpactGate3Workload:
    source = _experiment_path(
        config_path,
        config.workload.source_candidates,
    )
    actual_hash = sha256_file(source)
    if actual_hash != config.workload.source_sha256:
        raise ValueError(
            "Gate 3 workload SHA-256 mismatch: "
            f"expected {config.workload.source_sha256}, got {actual_hash}"
        )
    queries = load_gate2_jsonl(source)
    selected = next(
        (
            query
            for query in queries
            if query.query_id == config.workload.source_query_id
        ),
        None,
    )
    if selected is None:
        raise ValueError(
            f"Gate 3 source query not found: {config.workload.source_query_id}"
        )
    if selected.language != "ja" or len(selected.candidates) != 30:
        raise ValueError("Gate 3 workload must contain 30 Japanese candidates")
    candidates = tuple(
        ImpactGate3Candidate(
            candidate_id=candidate.candidate_id,
            dense_rank=candidate.dense_rank,
            text=f"[SCENE]\n{candidate.chunk_text}",
        )
        for candidate in sorted(
            selected.candidates,
            key=lambda item: (item.dense_rank, item.candidate_id),
        )
    )
    return ImpactGate3Workload(
        source_sha256=actual_hash,
        source_query_id=selected.query_id,
        query=canonical_impact_query(config.workload.diff_payload),
        candidates=candidates,
    )


class ImpactGate3Runtime:
    """Tokenizer plus a one-logit temporary classifier for speed measurement."""

    def __init__(
        self,
        *,
        tokenizer: Any,
        classifier: Any,
        max_pair_tokens: int,
        query_token_budget: int | None = None,
        scene_token_budget: int | None = None,
    ) -> None:
        if max_pair_tokens != 512:
            raise ValueError("Impact Gate 3 requires a 512-token pair limit")
        if query_token_budget is not None and query_token_budget <= 0:
            raise ValueError("Gate 3 query token budget must be positive")
        if scene_token_budget is not None and scene_token_budget <= 0:
            raise ValueError("Gate 3 scene token budget must be positive")
        self.tokenizer = tokenizer
        self.classifier = classifier
        self.max_pair_tokens = max_pair_tokens
        self.query_token_budget = query_token_budget
        self.scene_token_budget = scene_token_budget
        self.last_attention_tokens = 0
        self.last_padded_tokens = 0
        self.last_query_tokens = 0
        self.last_effective_pair_tokens = max_pair_tokens

    def token_count(self, text: str) -> int:
        normalized = text.strip()
        if not normalized:
            return 0
        encoded = self.tokenizer(
            normalized,
            add_special_tokens=False,
            truncation=False,
            return_attention_mask=False,
        )
        input_ids = encoded.get("input_ids")
        if input_ids is None:
            raise ValueError("Gate 3 tokenizer omitted input_ids")
        array = np.asarray(input_ids)
        if array.ndim == 2 and array.shape[0] == 1:
            array = array[0]
        if array.ndim != 1:
            raise ValueError("Gate 3 tokenizer returned invalid single-text IDs")
        return int(array.size)

    def _effective_pair_limit(self, query: str) -> int:
        if self.query_token_budget is None or self.scene_token_budget is None:
            self.last_query_tokens = 0
            return self.max_pair_tokens
        query_tokens = self.token_count(query)
        if query_tokens > self.query_token_budget:
            raise ValueError(
                "Gate 3 diff exceeds its token budget: "
                f"{query_tokens} > {self.query_token_budget}"
            )
        special_tokens = int(
            self.tokenizer.num_special_tokens_to_add(pair=True)
        )
        self.last_query_tokens = query_tokens
        return min(
            self.max_pair_tokens,
            query_tokens + self.scene_token_budget + special_tokens,
        )

    def encode_pairs(
        self,
        query: str,
        passages: Sequence[str],
    ) -> dict[str, np.ndarray]:
        normalized_query = query.strip()
        normalized_passages = [passage.strip() for passage in passages]
        if not normalized_query:
            raise ValueError("Gate 3 query must not be empty")
        if (
            not normalized_passages
            or len(normalized_passages) > 30
            or any(not passage for passage in normalized_passages)
        ):
            raise ValueError("Gate 3 passages must contain 1..=30 non-empty items")
        effective_pair_tokens = self._effective_pair_limit(normalized_query)
        encoded = self.tokenizer(
            [normalized_query] * len(normalized_passages),
            normalized_passages,
            max_length=effective_pair_tokens,
            padding=True,
            truncation="only_second",
            return_tensors="np",
        )
        arrays = {
            key: np.asarray(value, dtype=np.int64)
            for key, value in encoded.items()
            if key in {"input_ids", "attention_mask", "token_type_ids"}
        }
        if "input_ids" not in arrays or "attention_mask" not in arrays:
            raise ValueError("Gate 3 tokenizer omitted required model inputs")
        if arrays["input_ids"].shape != arrays["attention_mask"].shape:
            raise ValueError("Gate 3 tokenizer returned inconsistent input shapes")
        if arrays["input_ids"].shape[0] != len(normalized_passages):
            raise ValueError("Gate 3 tokenizer lost a candidate")
        if arrays["input_ids"].shape[1] > self.max_pair_tokens:
            raise ValueError("Gate 3 tokenizer exceeded the 512-token pair limit")
        self.last_attention_tokens = int(arrays["attention_mask"].sum())
        self.last_padded_tokens = int(arrays["attention_mask"].size)
        self.last_effective_pair_tokens = effective_pair_tokens
        return arrays

    def forward_encoded(self, encoded: dict[str, np.ndarray]) -> list[float]:
        output = self.classifier(**encoded)
        logits = getattr(output, "logits", None)
        if logits is None:
            raise ValueError("Gate 3 classifier output omitted logits")
        if hasattr(logits, "detach"):
            logits = logits.detach().cpu().numpy()
        scores = np.asarray(logits, dtype=np.float32)
        if scores.ndim == 1:
            scores = scores.reshape(-1, 1)
        if scores.ndim != 2 or scores.shape[1] != 1:
            raise ValueError("Gate 3 classifier must return exactly one logit")
        return [float(value) for value in scores[:, 0]]

    def score_pairs(
        self,
        query: str,
        passages: Sequence[str],
    ) -> list[float]:
        encoded = self.encode_pairs(query, passages)
        scores = self.forward_encoded(encoded)
        if len(scores) != len(passages):
            raise ValueError("Gate 3 classifier lost a candidate")
        return scores


class _TorchBinaryClassifierAdapter:
    def __init__(self, model: Any) -> None:
        self.model = model
        parameters = inspect.signature(model.backbone.forward).parameters
        self.accepts_arbitrary_inputs = any(
            parameter.kind == inspect.Parameter.VAR_KEYWORD
            for parameter in parameters.values()
        )
        self.accepted_inputs = set(parameters)

    def __call__(self, **inputs: np.ndarray) -> SimpleNamespace:
        import torch

        selected = (
            inputs
            if self.accepts_arbitrary_inputs
            else {
                key: value
                for key, value in inputs.items()
                if key in self.accepted_inputs
            }
        )
        tensors = {
            key: torch.from_numpy(np.asarray(value, dtype=np.int64))
            for key, value in selected.items()
        }
        with torch.inference_mode():
            output = self.model(**tensors)
        return SimpleNamespace(logits=output.logits)


def _temporary_binary_classifier(backbone: Any) -> Any:
    import torch
    from torch import nn

    hidden_size = getattr(backbone.config, "hidden_size", None)
    if not isinstance(hidden_size, int) or hidden_size <= 0:
        raise ValueError("Gate 3 backbone does not expose a valid hidden_size")

    class TemporaryBinaryClassifier(nn.Module):
        def __init__(self) -> None:
            super().__init__()
            self.backbone = backbone
            with torch.random.fork_rng(devices=[]):
                torch.manual_seed(42)
                self.classifier = nn.Linear(hidden_size, 1)

        def forward(self, **inputs: Any) -> SimpleNamespace:
            attention_mask = inputs.get("attention_mask")
            if attention_mask is None:
                raise ValueError("Gate 3 classifier requires attention_mask")
            output = self.backbone(return_dict=True, **inputs)
            hidden = getattr(output, "last_hidden_state", None)
            if hidden is None:
                raise ValueError("Gate 3 backbone omitted last_hidden_state")
            weights = attention_mask.to(dtype=hidden.dtype).unsqueeze(-1)
            counts = weights.sum(dim=1)
            if torch.any(counts == 0):
                raise ValueError("Gate 3 classifier cannot pool all-padding input")
            pooled = (hidden * weights).sum(dim=1) / counts
            return SimpleNamespace(logits=self.classifier(pooled).float())

    return TemporaryBinaryClassifier()


def load_impact_gate3_runtime(
    config_path: Path,
    config: ImpactGate3Config,
    model: ImpactGate3ModelSpec,
    *,
    thread_count: int,
) -> tuple[ImpactGate3Runtime, str, dict[str, tuple[str, ...]]]:
    if thread_count <= 0:
        raise ValueError("Gate 3 thread count must be positive")
    experiment_root = config_path.resolve().parent.parent
    configure_hugging_face_environment(
        experiment_root,
        offline=True,
        configured_values=config.offline_environment,
    )
    snapshot, manifest_path, weight = resolve_impact_model_paths(
        config_path,
        model,
    )
    manifest, expected_manifest_hash = load_manifest(manifest_path)
    actual_manifest_hash = verify_file_manifest(snapshot, manifest)
    if actual_manifest_hash != expected_manifest_hash:
        raise ValueError("Gate 3 model manifest changed during verification")
    if sha256_file(weight) != model.weight_sha256:
        raise ValueError(f"Gate 3 weight SHA-256 mismatch for {model.key}")

    import torch
    from transformers import AutoModel, AutoTokenizer

    torch.set_num_threads(thread_count)
    try:
        torch.set_num_interop_threads(1)
    except RuntimeError:
        # PyTorch permits setting this only before parallel work starts. The
        # benchmark process fixes it on its first model load.
        pass
    tokenizer = AutoTokenizer.from_pretrained(
        str(snapshot),
        local_files_only=True,
        trust_remote_code=False,
    )
    backbone, loading_info = AutoModel.from_pretrained(
        str(snapshot),
        local_files_only=True,
        trust_remote_code=False,
        output_loading_info=True,
    )
    errors = tuple(str(item) for item in loading_info.get("error_msgs", ()))
    mismatched = tuple(
        str(item) for item in loading_info.get("mismatched_keys", ())
    )
    if errors or mismatched:
        raise ValueError(
            f"Gate 3 backbone did not load exactly: errors={errors}, "
            f"mismatched={mismatched}"
        )
    classifier = _temporary_binary_classifier(backbone).float().eval()
    runtime = ImpactGate3Runtime(
        tokenizer=tokenizer,
        classifier=_TorchBinaryClassifierAdapter(classifier),
        max_pair_tokens=config.benchmark.max_pair_tokens,
        query_token_budget=config.benchmark.query_token_budget,
        scene_token_budget=config.benchmark.scene_token_budget,
    )
    load_summary = {
        "missingKeys": tuple(
            str(item) for item in loading_info.get("missing_keys", ())
        ),
        "unexpectedKeys": tuple(
            str(item) for item in loading_info.get("unexpected_keys", ())
        ),
    }
    return runtime, actual_manifest_hash, load_summary
