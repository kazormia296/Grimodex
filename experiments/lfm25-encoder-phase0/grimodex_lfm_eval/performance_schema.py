"""Versioned benchmark artifact contracts."""

from __future__ import annotations

import math
from datetime import datetime
from enum import StrEnum
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class Workload(StrEnum):
    SINGLE_PAIR = "single_pair"
    RELEVANCE = "relevance"
    IMPACT = "impact"
    COLD_START = "cold_start"


class GateVerdict(StrEnum):
    TARGET = "target"
    CONDITIONAL = "conditional"
    HOLD = "hold"
    REJECT = "reject"


class MeasurementStage(StrEnum):
    PILOT = "pilot"
    FINAL = "final"


class PerformanceModel(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        use_enum_values=True,
    )


class TimingSummary(PerformanceModel):
    sample_count: int = Field(alias="sampleCount", gt=0)
    samples_seconds: list[float] = Field(
        alias="samplesSeconds",
        default_factory=list,
    )
    minimum_seconds: float = Field(alias="minimumSeconds", default=0.0, ge=0.0)
    p50_seconds: float = Field(alias="p50Seconds", ge=0.0)
    p95_seconds: float = Field(alias="p95Seconds", ge=0.0)
    maximum_seconds: float = Field(alias="maximumSeconds", ge=0.0)
    bootstrap_95_ci: tuple[float, float] = Field(alias="bootstrap95Ci")

    @model_validator(mode="after")
    def validate_order(self) -> "TimingSummary":
        if self.samples_seconds:
            if len(self.samples_seconds) != self.sample_count:
                raise ValueError("samplesSeconds length must equal sampleCount")
            if any(
                not math.isfinite(value) or value < 0.0
                for value in self.samples_seconds
            ):
                raise ValueError(
                    "samplesSeconds must contain finite non-negative values"
                )
        if not (
            self.minimum_seconds
            <= self.p50_seconds
            <= self.p95_seconds
            <= self.maximum_seconds
        ):
            raise ValueError(
                "timings must satisfy min <= p50 <= p95 <= max"
            )
        low, high = self.bootstrap_95_ci
        if low < 0.0 or high < low:
            raise ValueError("bootstrap95Ci must be an ordered non-negative interval")
        return self


class MemorySummary(PerformanceModel):
    idle_resident_bytes: int | None = Field(
        alias="idleResidentBytes",
        default=None,
        ge=0,
    )
    peak_inference_bytes: int | None = Field(
        alias="peakInferenceBytes",
        default=None,
        ge=0,
    )


class CpuSummary(PerformanceModel):
    process_cpu_seconds: float | None = Field(
        alias="processCpuSeconds",
        default=None,
        ge=0.0,
    )
    measured_wall_seconds: float | None = Field(
        alias="measuredWallSeconds",
        default=None,
        ge=0.0,
    )
    effective_cores: float | None = Field(
        alias="effectiveCores",
        default=None,
        ge=0.0,
    )


class ThroughputSummary(PerformanceModel):
    tokens_per_second: float | None = Field(
        alias="tokensPerSecond",
        default=None,
        ge=0.0,
    )
    candidates_per_second: float | None = Field(
        alias="candidatesPerSecond",
        default=None,
        ge=0.0,
    )
    padded_tokens: int | None = Field(alias="paddedTokens", default=None, ge=0)
    attention_tokens: int | None = Field(
        alias="attentionTokens",
        default=None,
        ge=0,
    )
    padding_fraction: float | None = Field(
        alias="paddingFraction",
        default=None,
        ge=0.0,
        le=1.0,
    )


class TimingMeasurement(PerformanceModel):
    stage: MeasurementStage = MeasurementStage.FINAL
    workload: Workload
    input_tokens: int = Field(alias="inputTokens", ge=0)
    candidate_count: int = Field(alias="candidateCount", gt=0)
    batch_size: int = Field(alias="batchSize", gt=0)
    thread_count: int = Field(alias="threadCount", gt=0)
    bucketed: bool
    context_mode: Literal["full", "windowed"] | None = Field(
        alias="contextMode",
        default=None,
    )
    window_count: int | None = Field(alias="windowCount", default=None, gt=0)
    warmup_count: int = Field(alias="warmupCount", ge=0)
    phase: Literal["tokenization", "forward", "post_process", "end_to_end"] = (
        "end_to_end"
    )
    timing: TimingSummary
    memory: MemorySummary = Field(default_factory=MemorySummary)
    cpu: CpuSummary = Field(default_factory=CpuSummary)
    throughput: ThroughputSummary = Field(default_factory=ThroughputSummary)
    candidate_order: list[str] = Field(alias="candidateOrder", default_factory=list)
    batch_composition: list[list[str]] = Field(
        alias="batchComposition",
        default_factory=list,
    )

    @model_validator(mode="after")
    def validate_sample_floor(self) -> "TimingMeasurement":
        if self.context_mode == "windowed" and self.window_count is None:
            raise ValueError("windowed measurements require windowCount")
        if self.context_mode != "windowed" and self.window_count is not None:
            raise ValueError("windowCount is only valid for windowed measurements")
        if self.stage == MeasurementStage.PILOT:
            minimum_samples = 1
        elif self.workload == Workload.COLD_START:
            minimum_samples = 5
        elif self.input_tokens <= 2048:
            minimum_samples = 30
        else:
            minimum_samples = 10
        if self.timing.sample_count < minimum_samples:
            raise ValueError(
                f"{self.workload} at {self.input_tokens} tokens needs at least "
                f"{minimum_samples} measured samples"
            )
        return self


class GateDecision(PerformanceModel):
    workload: Workload
    candidate_count: int = Field(alias="candidateCount", gt=0)
    p95_seconds: float = Field(alias="p95Seconds", ge=0.0)
    verdict: GateVerdict
    reason: str = Field(min_length=1)


class PerformanceReport(PerformanceModel):
    schema_version: Literal[1] = Field(alias="schemaVersion", default=1)
    run_id: str = Field(alias="runId", min_length=1)
    created_at: datetime = Field(alias="createdAt")
    model_id: str = Field(alias="modelId", min_length=1)
    model_revision: str = Field(alias="modelRevision", min_length=1)
    manifest_hash: str = Field(alias="manifestHash", min_length=1)
    checkpoint_hash: str | None = Field(alias="checkpointHash", default=None)
    dtype: str = Field(min_length=1)
    measurement_stage: MeasurementStage = Field(
        alias="measurementStage",
        default=MeasurementStage.FINAL,
    )
    host_profile: dict[str, Any] = Field(alias="hostProfile")
    measurements: list[TimingMeasurement]
    decisions: list[GateDecision]
