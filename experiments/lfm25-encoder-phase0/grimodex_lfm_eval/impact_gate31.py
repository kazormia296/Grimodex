"""Full-scene and cap-window contracts for Phase 0b Impact Gate 3.1."""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
from typing import Any, Literal, Mapping, Sequence

import numpy as np
from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    field_validator,
    model_validator,
)
import yaml

from .impact_gate3 import (
    ImpactGate3Config,
    ImpactGate3Runtime,
    canonical_impact_query,
    load_impact_gate3_config,
    load_impact_gate3_runtime,
)


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


class ImpactGate31BenchmarkConfig(_ConfigModel):
    max_pair_tokens: Literal[512]
    query_token_budget: Literal[128]
    scene_window_tokens: Literal[384]
    scene_window_stride: Literal[256]
    full_scene_count: Literal[30]
    cap_stress_window_count: Literal[30]
    batch_sizes: tuple[int, ...] = Field(min_length=1)
    thread_counts: tuple[int | Literal["physical"], ...] = Field(min_length=1)
    warmup_count: int = Field(ge=1)
    repetitions: int = Field(ge=30)
    bootstrap_iterations: int = Field(ge=100)
    target_seconds: Literal[5.0]
    conditional_seconds: Literal[10.0]
    hold_seconds: Literal[20.0]

    @field_validator("batch_sizes")
    @classmethod
    def validate_batch_sizes(cls, values: tuple[int, ...]) -> tuple[int, ...]:
        if any(value <= 0 or value > 30 for value in values):
            raise ValueError("Gate 3.1 batch sizes must be in 1..=30")
        if len(values) != len(set(values)):
            raise ValueError("Gate 3.1 batch sizes must be unique")
        return values

    @field_validator("thread_counts")
    @classmethod
    def validate_thread_counts(
        cls,
        values: tuple[int | Literal["physical"], ...],
    ) -> tuple[int | Literal["physical"], ...]:
        numeric = [value for value in values if isinstance(value, int)]
        if any(value <= 0 for value in numeric):
            raise ValueError("Gate 3.1 thread counts must be positive")
        if len(values) != len(set(values)):
            raise ValueError("Gate 3.1 thread counts must be unique")
        return values

    @model_validator(mode="after")
    def validate_contract(self) -> "ImpactGate31BenchmarkConfig":
        if self.scene_window_stride > self.scene_window_tokens:
            raise ValueError("Gate 3.1 stride cannot exceed its window")
        if not (
            self.target_seconds
            < self.conditional_seconds
            < self.hold_seconds
        ):
            raise ValueError(
                "Gate 3.1 speed thresholds must be strictly increasing"
            )
        return self


class ImpactGate31WorkloadSpec(_ConfigModel):
    source: str = Field(min_length=1)
    source_sha256: str

    @field_validator("source")
    @classmethod
    def validate_source(cls, value: str) -> str:
        path = PurePosixPath(value)
        if path.is_absolute() or ".." in path.parts or str(path) != value:
            raise ValueError("Gate 3.1 source path must be normalized and relative")
        return value

    @field_validator("source_sha256")
    @classmethod
    def validate_hash(cls, value: str) -> str:
        normalized = value.strip().lower()
        if not SHA256_PATTERN.fullmatch(normalized):
            raise ValueError("Gate 3.1 source SHA-256 must be lowercase")
        return normalized


class ImpactGate31Config(_ConfigModel):
    schema_version: Literal[1]
    gate3_config: str = Field(min_length=1)
    benchmark: ImpactGate31BenchmarkConfig
    workload: ImpactGate31WorkloadSpec

    @field_validator("gate3_config")
    @classmethod
    def validate_gate3_config(cls, value: str) -> str:
        path = PurePosixPath(value)
        if path.is_absolute() or ".." in path.parts or str(path) != value:
            raise ValueError(
                "Gate 3.1 Gate 3 config path must be normalized and relative"
            )
        return value


class ImpactGate31Selection(_ConfigModel):
    query_text: str = Field(min_length=1)
    mention_terms: tuple[str, ...] = Field(min_length=1)
    dense_fetch: Literal[60]
    inferred_limit: Literal[30]
    explicit_link_policy: Literal["retain-and-bypass-classifier"]
    explicit_scene_count: int = Field(ge=0)
    dense_chunk_count: int = Field(ge=30)
    dense_scene_count: int = Field(ge=1)
    sparse_scene_count: int = Field(ge=0)
    union_scene_count: int = Field(ge=30)
    selected_inferred_scene_count: Literal[30]


class ImpactGate31Provenance(_ConfigModel):
    workspace_fixture: str = Field(min_length=1)
    candidate_fusion: str = Field(min_length=1)
    plain_text_extractor: Literal[
        "src/lib/prosemirror.ts#prosemirrorToText"
    ]
    native_index_status: dict[str, Any]
    source_workspace_scene_count: int = Field(ge=30)
    source_hashes: dict[str, str]

    @field_validator("source_hashes")
    @classmethod
    def validate_source_hashes(cls, values: dict[str, str]) -> dict[str, str]:
        if not values:
            raise ValueError("Gate 3.1 provenance requires source hashes")
        for value in values.values():
            if not SHA256_PATTERN.fullmatch(value):
                raise ValueError("Gate 3.1 provenance contains an invalid SHA-256")
        return values


class ImpactGate31Scene(_ConfigModel):
    scene_id: str = Field(min_length=1)
    scene_title: str = Field(min_length=1)
    inferred_rank: int = Field(ge=1, le=30)
    dense_rank: int | None = Field(default=None, ge=1)
    sparse_rank: int | None = Field(default=None, ge=1)
    rrf_score: float = Field(gt=0)
    matched_by: tuple[Literal["dense", "sparse"], ...] = Field(min_length=1)
    source_content_sha256: str
    plain_text_sha256: str
    plain_text: str = Field(min_length=1)

    @field_validator("source_content_sha256", "plain_text_sha256")
    @classmethod
    def validate_sha256(cls, value: str) -> str:
        if not SHA256_PATTERN.fullmatch(value):
            raise ValueError("Gate 3.1 scene SHA-256 must be lowercase")
        return value

    @model_validator(mode="after")
    def validate_plain_text_hash(self) -> "ImpactGate31Scene":
        actual = hashlib.sha256(self.plain_text.encode("utf-8")).hexdigest()
        if actual != self.plain_text_sha256:
            raise ValueError(
                f"Gate 3.1 plain-text SHA-256 mismatch for {self.scene_id}"
            )
        return self


class ImpactGate31Workload(_ConfigModel):
    schema_version: Literal[1]
    language: Literal["ja"]
    project_title: str = Field(min_length=1)
    diff_payload: dict[str, Any]
    selection: ImpactGate31Selection
    provenance: ImpactGate31Provenance
    scenes: tuple[ImpactGate31Scene, ...] = Field(min_length=30, max_length=30)

    @model_validator(mode="after")
    def validate_workload(self) -> "ImpactGate31Workload":
        scene_ids = [scene.scene_id for scene in self.scenes]
        if len(scene_ids) != len(set(scene_ids)):
            raise ValueError("Gate 3.1 scene IDs must be distinct")
        ranks = sorted(scene.inferred_rank for scene in self.scenes)
        if ranks != list(range(1, 31)):
            raise ValueError("Gate 3.1 inferred ranks must be exactly 1..30")
        required_diff_keys = {
            "change_id",
            "entry_id",
            "entry_name",
            "entry_type",
            "change_summary",
            "changes",
        }
        if set(self.diff_payload) != required_diff_keys:
            raise ValueError("Gate 3.1 diff payload keys drifted")
        return self


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _experiment_path(config_path: Path, relative: str) -> Path:
    experiment_root = config_path.resolve().parent.parent
    resolved = (experiment_root / relative).resolve()
    try:
        resolved.relative_to(experiment_root)
    except ValueError as error:
        raise ValueError("Gate 3.1 paths must remain inside the experiment") from error
    return resolved


def load_impact_gate31_config(path: Path) -> ImpactGate31Config:
    payload = yaml.safe_load(path.resolve().read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("Gate 3.1 configuration must be a mapping")
    return ImpactGate31Config.model_validate(payload)


def load_impact_gate31_workload(
    config_path: Path,
    config: ImpactGate31Config,
) -> ImpactGate31Workload:
    source = _experiment_path(config_path, config.workload.source)
    actual_hash = sha256_file(source)
    if actual_hash != config.workload.source_sha256:
        raise ValueError(
            "Gate 3.1 workload SHA-256 mismatch: "
            f"expected {config.workload.source_sha256}, got {actual_hash}"
        )
    workload = ImpactGate31Workload.model_validate_json(
        source.read_text(encoding="utf-8")
    )
    if len(workload.scenes) != config.benchmark.full_scene_count:
        raise ValueError("Gate 3.1 workload scene count drifted")
    if workload.selection.inferred_limit != config.benchmark.full_scene_count:
        raise ValueError("Gate 3.1 inferred limit and scene count must match")
    return workload


def resolve_gate3_config(
    config_path: Path,
    config: ImpactGate31Config,
) -> tuple[Path, ImpactGate3Config]:
    gate3_path = _experiment_path(config_path, config.gate3_config)
    return gate3_path, load_impact_gate3_config(gate3_path)


def window_token_ids(
    token_ids: Sequence[int],
    *,
    window_size: int,
    stride: int,
) -> tuple[tuple[int, ...], ...]:
    if window_size <= 0 or stride <= 0 or stride > window_size:
        raise ValueError("Gate 3.1 requires 0 < stride <= window size")
    if not token_ids:
        raise ValueError("Gate 3.1 cannot window an empty scene")
    windows = []
    for start in range(0, len(token_ids), stride):
        window = tuple(int(token) for token in token_ids[start : start + window_size])
        if not window:
            break
        windows.append(window)
        if start + window_size >= len(token_ids):
            break
    return tuple(windows)


def _percentile(values: Sequence[int], percentile: float) -> float:
    return float(np.percentile(np.asarray(values, dtype=np.float64), percentile))


def summarize_window_plan(
    plans: Mapping[str, Sequence[Sequence[int]]],
    *,
    stride: int = 256,
) -> dict[str, Any]:
    if not plans or any(not windows for windows in plans.values()):
        raise ValueError("Gate 3.1 window plan requires non-empty scenes")
    windows_per_scene = [len(windows) for windows in plans.values()]
    scene_tokens = 0
    window_scene_tokens = 0
    for windows in plans.values():
        lengths = [len(window) for window in windows]
        window_scene_tokens += sum(lengths)
        scene_tokens += (
            lengths[0]
            if len(lengths) == 1
            else stride * (len(lengths) - 1) + lengths[-1]
        )
    return {
        "sceneCount": len(plans),
        "windowCount": sum(windows_per_scene),
        "windowsPerScene": {
            "p50": _percentile(windows_per_scene, 50),
            "p95": _percentile(windows_per_scene, 95),
            "max": max(windows_per_scene),
        },
        "sceneTokens": scene_tokens,
        "windowSceneTokens": window_scene_tokens,
        # Every full scene is tokenized before sliding windows are created.
        "truncatedSceneCount": 0,
    }


def aggregate_scene_scores(
    scene_ids: Sequence[str],
    window_scores: Sequence[float],
) -> dict[str, float]:
    if not scene_ids or len(scene_ids) != len(window_scores):
        raise ValueError("Gate 3.1 scene IDs and scores must align")
    scores: dict[str, float] = {}
    for scene_id, score in zip(scene_ids, window_scores, strict=True):
        value = float(score)
        previous = scores.get(scene_id)
        if previous is None or value > previous:
            scores[scene_id] = value
    return scores


@dataclass(frozen=True)
class ImpactGate31Window:
    scene_id: str
    index: int
    token_ids: tuple[int, ...]


@dataclass(frozen=True)
class PreparedImpactGate31Workload:
    query: str
    query_token_ids: tuple[int, ...]
    windows: tuple[ImpactGate31Window, ...]
    cap_stress_windows: tuple[ImpactGate31Window, ...]
    distribution: dict[str, Any]


class ImpactGate31Runtime:
    """Gate 3 classifier adapter that consumes pre-windowed token IDs."""

    def __init__(self, gate3_runtime: ImpactGate3Runtime) -> None:
        self.tokenizer = gate3_runtime.tokenizer
        self.classifier = gate3_runtime.classifier
        self.max_pair_tokens = gate3_runtime.max_pair_tokens
        self.last_attention_tokens = 0
        self.last_padded_tokens = 0
        self.pair_parity_verified = False
        processor = self.tokenizer.backend_tokenizer.post_processor
        raw_state = processor.__getstate__()
        if isinstance(raw_state, bytes):
            raw_state = raw_state.decode("utf-8")
        processor_state = json.loads(raw_state)
        if processor_state.get("type") != "TemplateProcessing":
            raise ValueError(
                "Gate 3.1 requires a tokenizer TemplateProcessing pair contract"
            )
        special_tokens = processor_state.get("special_tokens", {})
        pair_template: list[tuple[str, tuple[int, ...], int]] = []
        for component in processor_state.get("pair", []):
            sequence = component.get("Sequence")
            if sequence is not None:
                sequence_id = sequence.get("id")
                if sequence_id not in {"A", "B"}:
                    raise ValueError("Gate 3.1 found an unknown pair sequence")
                pair_template.append(
                    (
                        sequence_id,
                        (),
                        int(sequence.get("type_id", 0)),
                    )
                )
                continue
            special = component.get("SpecialToken")
            if special is None:
                raise ValueError("Gate 3.1 found an unknown pair template item")
            definition = special_tokens.get(special.get("id"))
            if not definition or not definition.get("ids"):
                raise ValueError("Gate 3.1 pair special token is undefined")
            pair_template.append(
                (
                    "special",
                    tuple(int(token) for token in definition["ids"]),
                    int(special.get("type_id", 0)),
                )
            )
        if not pair_template:
            raise ValueError("Gate 3.1 tokenizer omitted its pair template")
        self._pair_template = tuple(pair_template)

    def tokenize_without_special_tokens(self, text: str) -> tuple[int, ...]:
        encoded = self.tokenizer(
            text.strip(),
            add_special_tokens=False,
            truncation=False,
            return_attention_mask=False,
        )
        raw_ids = np.asarray(encoded["input_ids"])
        if raw_ids.ndim == 2 and raw_ids.shape[0] == 1:
            raw_ids = raw_ids[0]
        if raw_ids.ndim != 1 or raw_ids.size == 0:
            raise ValueError("Gate 3.1 tokenizer returned invalid token IDs")
        return tuple(int(token) for token in raw_ids)

    def encode_token_windows(
        self,
        query_token_ids: Sequence[int],
        windows: Sequence[Sequence[int]],
    ) -> dict[str, np.ndarray]:
        if not query_token_ids or not windows:
            raise ValueError("Gate 3.1 pair encoding requires query and windows")
        rows: list[tuple[list[int], list[int]]] = []
        for window in windows:
            if not window:
                raise ValueError("Gate 3.1 cannot encode an empty window")
            input_ids: list[int] = []
            token_type_ids: list[int] = []
            for kind, special_ids, type_id in self._pair_template:
                component_ids = (
                    query_token_ids
                    if kind == "A"
                    else window
                    if kind == "B"
                    else special_ids
                )
                input_ids.extend(int(token) for token in component_ids)
                token_type_ids.extend([type_id] * len(component_ids))
            if len(input_ids) > self.max_pair_tokens:
                raise ValueError("Gate 3.1 pair exceeded the 512-token cap")
            rows.append((input_ids, token_type_ids))
        pad_token_id = self.tokenizer.pad_token_id
        if pad_token_id is None:
            raise ValueError("Gate 3.1 tokenizer requires a pad token")
        width = max(len(input_ids) for input_ids, _ in rows)
        input_array = np.full(
            (len(rows), width),
            int(pad_token_id),
            dtype=np.int64,
        )
        attention_array = np.zeros((len(rows), width), dtype=np.int64)
        token_type_array = np.zeros((len(rows), width), dtype=np.int64)
        left_padding = getattr(self.tokenizer, "padding_side", "right") == "left"
        for row_index, (input_ids, token_type_ids) in enumerate(rows):
            start = width - len(input_ids) if left_padding else 0
            end = start + len(input_ids)
            input_array[row_index, start:end] = input_ids
            attention_array[row_index, start:end] = 1
            token_type_array[row_index, start:end] = token_type_ids
        arrays = {
            "input_ids": input_array,
            "attention_mask": attention_array,
            "token_type_ids": token_type_array,
        }
        self.last_attention_tokens = int(arrays["attention_mask"].sum())
        self.last_padded_tokens = int(arrays["attention_mask"].size)
        return arrays

    def verify_text_pair_parity(self, query: str, scene: str) -> None:
        query_ids = self.tokenize_without_special_tokens(query)
        scene_ids = self.tokenize_without_special_tokens(scene)
        if len(query_ids) + len(scene_ids) > self.max_pair_tokens:
            raise ValueError("Gate 3.1 parity pair must fit without truncation")
        manual = self.encode_token_windows(query_ids, [scene_ids])
        official = self.tokenizer(
            query.strip(),
            scene.strip(),
            add_special_tokens=True,
            padding=False,
            truncation=False,
            return_attention_mask=True,
        )
        official_ids = np.asarray(official["input_ids"], dtype=np.int64)
        if official_ids.ndim == 2 and official_ids.shape[0] == 1:
            official_ids = official_ids[0]
        manual_ids = manual["input_ids"][0, : official_ids.size]
        if not np.array_equal(manual_ids, official_ids):
            raise ValueError(
                "Gate 3.1 pre-windowed pair differs from official tokenizer"
            )
        self.pair_parity_verified = True

    def forward_encoded(self, encoded: dict[str, np.ndarray]) -> list[float]:
        output = self.classifier(**encoded)
        logits = getattr(output, "logits", None)
        if logits is None:
            raise ValueError("Gate 3.1 classifier output omitted logits")
        if hasattr(logits, "detach"):
            logits = logits.detach().cpu().numpy()
        scores = np.asarray(logits, dtype=np.float32)
        if scores.ndim == 1:
            scores = scores.reshape(-1, 1)
        if scores.ndim != 2 or scores.shape[1] != 1:
            raise ValueError("Gate 3.1 classifier must return one logit")
        return [float(value) for value in scores[:, 0]]


def prepare_impact_gate31_workload(
    runtime: ImpactGate31Runtime,
    config: ImpactGate31Config,
    workload: ImpactGate31Workload,
) -> PreparedImpactGate31Workload:
    query = canonical_impact_query(workload.diff_payload)
    query_ids = runtime.tokenize_without_special_tokens(query)
    if len(query_ids) > config.benchmark.query_token_budget:
        raise ValueError(
            "Gate 3.1 diff exceeds its token budget: "
            f"{len(query_ids)} > {config.benchmark.query_token_budget}"
        )
    plans: dict[str, tuple[tuple[int, ...], ...]] = {}
    flattened: list[ImpactGate31Window] = []
    for scene in workload.scenes:
        scene_ids = runtime.tokenize_without_special_tokens(scene.plain_text)
        windows = window_token_ids(
            scene_ids,
            window_size=config.benchmark.scene_window_tokens,
            stride=config.benchmark.scene_window_stride,
        )
        plans[scene.scene_id] = windows
        flattened.extend(
            ImpactGate31Window(
                scene_id=scene.scene_id,
                index=index,
                token_ids=window,
            )
            for index, window in enumerate(windows)
        )
    full_windows = [
        window
        for window in flattened
        if len(window.token_ids) == config.benchmark.scene_window_tokens
    ]
    if len(full_windows) < config.benchmark.cap_stress_window_count:
        raise ValueError("Gate 3.1 workload lacks 30 fully occupied windows")
    cap_stress = tuple(
        ImpactGate31Window(
            scene_id=f"cap-{index:02d}",
            index=0,
            token_ids=window.token_ids,
        )
        for index, window in enumerate(
            full_windows[: config.benchmark.cap_stress_window_count]
        )
    )
    return PreparedImpactGate31Workload(
        query=query,
        query_token_ids=query_ids,
        windows=tuple(flattened),
        cap_stress_windows=cap_stress,
        distribution={
            **summarize_window_plan(
                plans,
                stride=config.benchmark.scene_window_stride,
            ),
            "queryTokens": len(query_ids),
        },
    )


def load_impact_gate31_runtime(
    config_path: Path,
    config: ImpactGate31Config,
    *,
    model_key: str,
    thread_count: int,
) -> tuple[
    ImpactGate31Runtime,
    ImpactGate3Config,
    str,
    dict[str, tuple[str, ...]],
]:
    gate3_path, gate3_config = resolve_gate3_config(config_path, config)
    gate3_model = gate3_config.model(model_key)
    gate3_runtime, manifest_hash, load_summary = load_impact_gate3_runtime(
        gate3_path,
        gate3_config,
        gate3_model,
        thread_count=thread_count,
    )
    return (
        ImpactGate31Runtime(gate3_runtime),
        gate3_config,
        manifest_hash,
        load_summary,
    )
