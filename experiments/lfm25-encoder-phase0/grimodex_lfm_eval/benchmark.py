"""Deterministic benchmark helpers and the C0.5 early-gate runner."""

from __future__ import annotations

import argparse
import json
import math
import os
import random
import subprocess
import sys
import time
from collections.abc import Callable, Sequence
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, TypeVar

from .config import configure_hugging_face_environment, load_config
from .performance_schema import (
    GateDecision,
    GateVerdict,
    CpuSummary,
    MeasurementStage,
    MemorySummary,
    PerformanceReport,
    TimingMeasurement,
    TimingSummary,
    ThroughputSummary,
    Workload,
)
from .provenance import load_manifest, require_pinned_revision, verify_file_manifest


InputT = TypeVar("InputT")
OutputT = TypeVar("OutputT")


class TimingCheckpoint:
    """Atomic per-sample persistence for interruptible workload benchmarks."""

    def __init__(
        self,
        path: Path,
        *,
        model_revision: str,
        manifest_hash: str,
    ) -> None:
        self.path = path.resolve()
        self.identity = {
            "modelRevision": model_revision,
            "manifestHash": manifest_hash,
        }
        if self.path.exists():
            payload = json.loads(self.path.read_text(encoding="utf-8"))
            if payload.get("schemaVersion") != 1:
                raise ValueError("unsupported timing checkpoint schema")
            if payload.get("identity") != self.identity:
                raise ValueError("timing checkpoint model identity changed")
            entries = payload.get("entries")
            if not isinstance(entries, dict):
                raise ValueError("timing checkpoint entries must be a mapping")
            self.payload = payload
        else:
            self.payload = {
                "schemaVersion": 1,
                "identity": self.identity,
                "entries": {},
            }

    def records(self, key: str) -> list[dict[str, float | int]]:
        value = self.payload["entries"].get(key, [])
        if not isinstance(value, list):
            raise ValueError("timing checkpoint entry must be a list")
        records: list[dict[str, float | int]] = []
        for item in value:
            if not isinstance(item, dict):
                raise ValueError("timing checkpoint sample must be a mapping")
            wall_seconds = item.get("wallSeconds")
            cpu_seconds = item.get("cpuSeconds")
            peak_bytes = item.get("peakInferenceBytes")
            if (
                not isinstance(wall_seconds, (int, float))
                or not math.isfinite(wall_seconds)
                or wall_seconds < 0.0
                or not isinstance(cpu_seconds, (int, float))
                or not math.isfinite(cpu_seconds)
                or cpu_seconds < 0.0
                or not isinstance(peak_bytes, int)
                or peak_bytes < 0
            ):
                raise ValueError("timing checkpoint sample is invalid")
            records.append(
                {
                    "wallSeconds": float(wall_seconds),
                    "cpuSeconds": float(cpu_seconds),
                    "peakInferenceBytes": peak_bytes,
                }
            )
        return records

    def append(self, key: str, record: dict[str, float | int]) -> None:
        records = self.records(key)
        records.append(record)
        self.payload["entries"][key] = records
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_name(f".{self.path.name}.tmp")
        temporary.write_text(
            json.dumps(self.payload, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        temporary.replace(self.path)


def _workload_checkpoint_key(
    *,
    workload: Workload,
    candidate_count: int,
    max_tokens: int,
    batch_size: int,
    bucketed: bool,
    thread_count: int,
    context_mode: str,
) -> str:
    return json.dumps(
        {
            "workload": workload,
            "candidateCount": candidate_count,
            "maxTokens": max_tokens,
            "batchSize": batch_size,
            "bucketed": bucketed,
            "threadCount": thread_count,
            "contextMode": context_mode,
        },
        separators=(",", ":"),
        sort_keys=True,
    )


def _quantile(values: Sequence[float], probability: float) -> float:
    if not values:
        raise ValueError("cannot calculate a quantile of an empty sequence")
    if not 0.0 <= probability <= 1.0:
        raise ValueError("probability must be between zero and one")
    ordered = sorted(values)
    position = (len(ordered) - 1) * probability
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return ordered[lower]
    weight = position - lower
    return ordered[lower] * (1.0 - weight) + ordered[upper] * weight


def summarize_timing_samples(
    samples: Sequence[float],
    *,
    warmup_count: int,
    minimum_samples: int,
    bootstrap_iterations: int = 1_000,
    random_seed: int = 42,
) -> TimingSummary:
    if warmup_count < 0 or warmup_count > len(samples):
        raise ValueError("warmup_count is outside the sample range")
    measured = list(samples[warmup_count:])
    if len(measured) < minimum_samples:
        raise ValueError(
            f"need at least {minimum_samples} measured samples after warmup"
        )
    if any(not math.isfinite(value) or value < 0.0 for value in measured):
        raise ValueError("timing samples must be finite and non-negative")
    if bootstrap_iterations <= 0:
        raise ValueError("bootstrap_iterations must be positive")

    random_generator = random.Random(random_seed)
    bootstrap_p95: list[float] = []
    for _ in range(bootstrap_iterations):
        resampled = [
            measured[random_generator.randrange(len(measured))]
            for _ in measured
        ]
        bootstrap_p95.append(_quantile(resampled, 0.95))

    return TimingSummary(
        sampleCount=len(measured),
        samplesSeconds=measured,
        minimumSeconds=min(measured),
        p50Seconds=_quantile(measured, 0.50),
        p95Seconds=_quantile(measured, 0.95),
        maximumSeconds=max(measured),
        bootstrap95Ci=(
            _quantile(bootstrap_p95, 0.025),
            _quantile(bootstrap_p95, 0.975),
        ),
    )


def batched_predict(
    inputs: Sequence[InputT],
    *,
    batch_size: int,
    predict_batch: Callable[[list[InputT]], Sequence[OutputT]],
    bucket_by_length: bool = False,
    length_key: Callable[[InputT], int] | None = None,
) -> list[OutputT]:
    if batch_size <= 0:
        raise ValueError("batch_size must be positive")
    indexed_inputs = list(enumerate(inputs))
    if bucket_by_length:
        if length_key is None:
            raise ValueError("length_key is required when bucket_by_length is enabled")
        indexed_inputs.sort(key=lambda item: (length_key(item[1]), item[0]))

    output_by_index: dict[int, OutputT] = {}
    for offset in range(0, len(indexed_inputs), batch_size):
        indexed_batch = indexed_inputs[offset : offset + batch_size]
        batch = [item for _, item in indexed_batch]
        predictions = list(predict_batch(batch))
        if len(predictions) != len(batch):
            raise ValueError("predict_batch must return one result per input")
        for (original_index, _), prediction in zip(
            indexed_batch,
            predictions,
            strict=True,
        ):
            output_by_index[original_index] = prediction
    return [output_by_index[index] for index in range(len(inputs))]


def classify_speed_gate(
    workload: Workload,
    *,
    candidate_count: int,
    p95_seconds: float,
) -> GateVerdict:
    if p95_seconds < 0.0:
        raise ValueError("p95_seconds must be non-negative")
    if workload == Workload.RELEVANCE:
        if candidate_count == 12:
            target, conditional, hold = 1.0, 2.0, 4.0
        elif candidate_count == 30:
            target, conditional, hold = 2.0, 4.0, 8.0
        else:
            raise ValueError("relevance gate is defined for 12 or 30 candidates")
    elif workload == Workload.IMPACT:
        if candidate_count != 30:
            raise ValueError("impact gate is defined for 30 candidates")
        target, conditional, hold = 5.0, 10.0, 20.0
    elif workload == Workload.COLD_START:
        target, conditional, hold = 5.0, 15.0, math.inf
    else:
        raise ValueError(f"no speed budget is defined for {workload}")

    if p95_seconds <= target:
        return GateVerdict.TARGET
    if p95_seconds <= conditional:
        return GateVerdict.CONDITIONAL
    if p95_seconds <= hold:
        return GateVerdict.HOLD
    return GateVerdict.REJECT


def _resolve_snapshot(config: dict[str, Any], config_path: Path) -> tuple[Path, str, str]:
    model = config["model"]
    revision = require_pinned_revision(str(model["revision"]))
    experiment_root = config_path.parent.parent
    snapshot = experiment_root / str(model["local_snapshot"])
    manifest_path = experiment_root / str(model["manifest"])
    manifest, manifest_hash = load_manifest(manifest_path)
    verified_hash = verify_file_manifest(snapshot, manifest)
    if verified_hash != manifest_hash:
        raise ValueError("verified snapshot hash differs from manifestHash")
    return snapshot, revision, manifest_hash


def _representative_text(target_tokens: int) -> str:
    sentence = (
        "朱音が古い社の朱紐に触れると、見知らぬ誰かの記憶が静かに流れ込んだ。"
    )
    return sentence * max(8, target_tokens // 8)


def _current_rss_bytes() -> int:
    import psutil

    return psutil.Process().memory_info().rss


def _create_runtime(snapshot: Path, manifest_path: Path, dropout: float = 0.1) -> Any:
    from .model import LfmBinaryClassifier, load_offline_tokenizer

    tokenizer = load_offline_tokenizer(snapshot, manifest_path=manifest_path)
    classifier = LfmBinaryClassifier.from_local_snapshot(
        snapshot,
        manifest_path=manifest_path,
        dropout=dropout,
    )
    return tokenizer, classifier


def _measure_single_length(
    *,
    tokenizer: Any,
    classifier: Any,
    target_tokens: int,
    repetitions: int,
    warmup_count: int,
    thread_count: int,
    runtime_baseline_rss: int,
    idle_resident_bytes: int,
    bootstrap_iterations: int,
    stage: MeasurementStage,
) -> list[TimingMeasurement]:
    import torch

    torch.set_num_threads(thread_count)
    classifier.eval()
    text = _representative_text(target_tokens)
    phase_samples: dict[str, list[float]] = {
        "tokenization": [],
        "forward": [],
        "post_process": [],
        "end_to_end": [],
    }
    process = __import__("psutil").Process()
    peak_rss = _current_rss_bytes()
    measured_cpu_start: float | None = None
    measured_wall_start: float | None = None
    total_runs = warmup_count + repetitions
    with torch.inference_mode():
        for run_index in range(total_runs):
            if run_index == warmup_count:
                cpu_times = process.cpu_times()
                measured_cpu_start = cpu_times.user + cpu_times.system
                measured_wall_start = time.perf_counter()
            total_start = time.perf_counter()
            tokenization_start = time.perf_counter()
            encoded = tokenizer(
                text,
                max_length=target_tokens,
                padding="max_length",
                truncation=True,
                return_tensors="pt",
            )
            tokenization_end = time.perf_counter()
            forward_start = tokenization_end
            logits = classifier(
                input_ids=encoded["input_ids"],
                attention_mask=encoded["attention_mask"],
            ).logits
            forward_end = time.perf_counter()
            probabilities = torch.sigmoid(logits).tolist()
            if len(probabilities) != 1:
                raise RuntimeError("single-pair benchmark returned an invalid batch")
            post_process_end = time.perf_counter()
            peak_rss = max(peak_rss, _current_rss_bytes())
            phase_samples["tokenization"].append(tokenization_end - tokenization_start)
            phase_samples["forward"].append(forward_end - forward_start)
            phase_samples["post_process"].append(post_process_end - forward_end)
            phase_samples["end_to_end"].append(post_process_end - total_start)

    cpu_times = process.cpu_times()
    process_cpu_seconds = cpu_times.user + cpu_times.system - (measured_cpu_start or 0.0)
    measured_wall_seconds = time.perf_counter() - (measured_wall_start or time.perf_counter())
    effective_cores = (
        process_cpu_seconds / measured_wall_seconds
        if measured_wall_seconds > 0.0
        else 0.0
    )
    minimum_samples = (
        1
        if stage == MeasurementStage.PILOT
        else (30 if target_tokens <= 2048 else 10)
    )
    measurements: list[TimingMeasurement] = []
    for phase, samples in phase_samples.items():
        timing = summarize_timing_samples(
            samples,
            warmup_count=warmup_count,
            minimum_samples=minimum_samples,
            bootstrap_iterations=bootstrap_iterations,
        )
        measurements.append(
            TimingMeasurement(
                stage=stage,
                workload=Workload.SINGLE_PAIR,
                inputTokens=target_tokens,
                candidateCount=1,
                batchSize=1,
                threadCount=thread_count,
                bucketed=False,
                warmupCount=warmup_count,
                phase=phase,
                timing=timing,
                memory=MemorySummary(
                    idleResidentBytes=idle_resident_bytes,
                    peakInferenceBytes=max(0, peak_rss - runtime_baseline_rss),
                ),
                cpu=CpuSummary(
                    processCpuSeconds=process_cpu_seconds,
                    measuredWallSeconds=measured_wall_seconds,
                    effectiveCores=effective_cores,
                ),
                throughput=ThroughputSummary(
                    tokensPerSecond=(
                        target_tokens / timing.p50_seconds
                        if timing.p50_seconds > 0.0
                        else 0.0
                    ),
                    candidatesPerSecond=(
                        1.0 / timing.p50_seconds
                        if timing.p50_seconds > 0.0
                        else 0.0
                    ),
                    paddedTokens=target_tokens,
                    attentionTokens=target_tokens,
                    paddingFraction=0.0,
                ),
                candidateOrder=[f"single-{target_tokens}"],
                batchComposition=[[f"single-{target_tokens}"]],
            )
        )
    return measurements


def _measure_workload(
    *,
    tokenizer: Any,
    classifier: Any,
    workload: Workload,
    candidate_count: int,
    max_tokens: int,
    batch_size: int,
    bucketed: bool,
    repetitions: int,
    warmup_count: int,
    thread_count: int,
    runtime_baseline_rss: int,
    idle_resident_bytes: int,
    bootstrap_iterations: int,
    stage: MeasurementStage,
    context_mode: str = "full",
    checkpoint: TimingCheckpoint | None = None,
) -> TimingMeasurement:
    import torch

    torch.set_num_threads(thread_count)
    classifier.eval()
    if context_mode not in {"full", "windowed"}:
        raise ValueError(f"unsupported context mode: {context_mode}")
    if context_mode == "windowed" and workload != Workload.IMPACT:
        raise ValueError("windowed mode is only defined for impact")
    candidate_ids = [f"{workload.value}-{index:02d}" for index in range(candidate_count)]
    token_step = max(64, max_tokens // 8)
    lengths = [
        min(max_tokens, token_step * (1 + (index % 8)))
        for index in range(candidate_count)
    ]
    texts: list[tuple[str, str, int, str]] = []
    for candidate_id, length in zip(candidate_ids, lengths, strict=True):
        window_total = 2 if context_mode == "windowed" else 1
        for window_index in range(window_total):
            window_id = (
                f"{candidate_id}#window-{window_index}"
                if window_total > 1
                else candidate_id
            )
            texts.append(
                (
                    window_id,
                    _representative_text(length),
                    length,
                    candidate_id,
                )
            )
    peak_rss = _current_rss_bytes()
    batch_composition: list[list[str]] = []
    attention_tokens = 0
    padded_tokens = 0
    process = __import__("psutil").Process()
    checkpoint_key = _workload_checkpoint_key(
        workload=workload,
        candidate_count=candidate_count,
        max_tokens=max_tokens,
        batch_size=batch_size,
        bucketed=bucketed,
        thread_count=thread_count,
        context_mode=context_mode,
    )
    sample_records = checkpoint.records(checkpoint_key) if checkpoint else []
    if len(sample_records) > repetitions:
        raise ValueError(
            "timing checkpoint contains more samples than requested"
        )
    remaining_repetitions = repetitions - len(sample_records)

    def predict_batch(batch: list[tuple[str, str, int, str]]) -> list[float]:
        nonlocal attention_tokens, batch_composition, padded_tokens, peak_rss
        batch_composition.append([item[0] for item in batch])
        encoded = tokenizer(
            [item[1] for item in batch],
            max_length=max(item[2] for item in batch),
            padding=True,
            truncation=True,
            return_tensors="pt",
        )
        attention_tokens += int(encoded["attention_mask"].sum())
        padded_tokens += int(encoded["attention_mask"].numel())
        with torch.inference_mode():
            logits = classifier(
                input_ids=encoded["input_ids"],
                attention_mask=encoded["attention_mask"],
            ).logits
            probabilities = torch.sigmoid(logits).tolist()
        peak_rss = max(peak_rss, _current_rss_bytes())
        return [float(probability) for probability in probabilities]

    for run_index in range(warmup_count + remaining_repetitions):
        batch_composition = []
        attention_tokens = 0
        padded_tokens = 0
        cpu_times = process.cpu_times()
        sample_cpu_start = cpu_times.user + cpu_times.system
        started = time.perf_counter()
        predictions = batched_predict(
            texts,
            batch_size=batch_size,
            predict_batch=predict_batch,
            bucket_by_length=bucketed,
            length_key=lambda item: item[2],
        )
        if context_mode == "windowed":
            aggregated: dict[str, float] = {}
            for item, probability in zip(texts, predictions, strict=True):
                candidate_id = item[3]
                aggregated[candidate_id] = max(
                    aggregated.get(candidate_id, 0.0),
                    probability,
                )
            if len(aggregated) != candidate_count:
                raise RuntimeError("window aggregation lost a candidate")
        elif len(predictions) != candidate_count:
            raise RuntimeError("workload benchmark lost a candidate")
        wall_seconds = time.perf_counter() - started
        cpu_times = process.cpu_times()
        cpu_seconds = cpu_times.user + cpu_times.system - sample_cpu_start
        if run_index >= warmup_count:
            record: dict[str, float | int] = {
                "wallSeconds": wall_seconds,
                "cpuSeconds": cpu_seconds,
                "peakInferenceBytes": max(
                    0,
                    peak_rss - runtime_baseline_rss,
                ),
            }
            sample_records.append(record)
            if checkpoint is not None:
                checkpoint.append(checkpoint_key, record)

    samples = [float(record["wallSeconds"]) for record in sample_records]
    process_cpu_seconds = sum(
        float(record["cpuSeconds"]) for record in sample_records
    )
    measured_wall_seconds = sum(samples)
    effective_cores = (
        process_cpu_seconds / measured_wall_seconds
        if measured_wall_seconds > 0.0
        else 0.0
    )
    timing = summarize_timing_samples(
        samples,
        warmup_count=0,
        minimum_samples=1 if stage == MeasurementStage.PILOT else 30,
        bootstrap_iterations=bootstrap_iterations,
    )
    return TimingMeasurement(
        stage=stage,
        workload=workload,
        inputTokens=max_tokens,
        candidateCount=candidate_count,
        batchSize=batch_size,
        threadCount=thread_count,
        bucketed=bucketed,
        contextMode=context_mode,
        windowCount=len(texts) if context_mode == "windowed" else None,
        warmupCount=warmup_count,
        phase="end_to_end",
        timing=timing,
        memory=MemorySummary(
            idleResidentBytes=idle_resident_bytes,
            peakInferenceBytes=max(
                (
                    int(record["peakInferenceBytes"])
                    for record in sample_records
                ),
                default=max(0, peak_rss - runtime_baseline_rss),
            ),
        ),
        cpu=CpuSummary(
            processCpuSeconds=process_cpu_seconds,
            measuredWallSeconds=measured_wall_seconds,
            effectiveCores=effective_cores,
        ),
        throughput=ThroughputSummary(
            tokensPerSecond=(
                attention_tokens / timing.p50_seconds
                if timing.p50_seconds > 0.0
                else 0.0
            ),
            candidatesPerSecond=(
                candidate_count / timing.p50_seconds
                if timing.p50_seconds > 0.0
                else 0.0
            ),
            paddedTokens=padded_tokens,
            attentionTokens=attention_tokens,
            paddingFraction=(
                (padded_tokens - attention_tokens) / padded_tokens
                if padded_tokens
                else 0.0
            ),
        ),
        candidateOrder=candidate_ids,
        batchComposition=batch_composition,
    )


def _cold_child(config_path: Path) -> None:
    config = load_config(config_path)
    configure_hugging_face_environment(
        config_path.parent.parent,
        offline=True,
        configured_values=config.get("offline_environment"),
    )
    snapshot, _revision, _manifest_hash = _resolve_snapshot(config, config_path)
    manifest_path = config_path.parent.parent / str(config["model"]["manifest"])
    tokenizer, classifier = _create_runtime(snapshot, manifest_path)
    import torch

    classifier.eval()
    encoded = tokenizer("朱音の記憶", return_tensors="pt")
    with torch.inference_mode():
        classifier(**encoded)
    print('{"status":"ok"}')


def _contention_child(
    config_path: Path,
    *,
    duration_seconds: float,
    thread_count: int,
    batch_size: int,
) -> None:
    import torch

    if duration_seconds <= 0.0:
        raise ValueError("duration_seconds must be positive")
    if thread_count <= 0:
        raise ValueError("thread_count must be positive")
    if batch_size <= 0:
        raise ValueError("batch_size must be positive")
    config = load_config(config_path)
    configure_hugging_face_environment(
        config_path.parent.parent,
        offline=True,
        configured_values=config.get("offline_environment"),
    )
    snapshot, _revision, _manifest_hash = _resolve_snapshot(config, config_path)
    manifest_path = config_path.parent.parent / str(config["model"]["manifest"])
    tokenizer, classifier = _create_runtime(snapshot, manifest_path)
    torch.set_num_threads(thread_count)
    classifier.eval()
    texts = [_representative_text(1024) for _ in range(30)]

    def predict_batch(batch: list[str]) -> list[float]:
        encoded = tokenizer(
            batch,
            max_length=1024,
            padding=True,
            truncation=True,
            return_tensors="pt",
        )
        with torch.inference_mode():
            logits = classifier(
                input_ids=encoded["input_ids"],
                attention_mask=encoded["attention_mask"],
            ).logits
        return [float(value) for value in torch.sigmoid(logits).tolist()]

    batched_predict(
        texts,
        batch_size=batch_size,
        predict_batch=predict_batch,
        bucket_by_length=False,
    )
    print("READY", flush=True)
    started = time.perf_counter()
    iterations = 0
    while time.perf_counter() - started < duration_seconds:
        batched_predict(
            texts,
            batch_size=batch_size,
            predict_batch=predict_batch,
            bucket_by_length=False,
        )
        iterations += 1
    print(
        json.dumps(
            {
                "status": "complete",
                "iterations": iterations,
                "durationSeconds": time.perf_counter() - started,
            }
        ),
        flush=True,
    )


def _measure_cold_start(
    *,
    config_path: Path,
    revision: str,
    repetitions: int,
) -> TimingMeasurement:
    if repetitions < 5:
        raise ValueError("cold start requires at least five independent processes")
    samples: list[float] = []
    for _ in range(repetitions):
        started = time.perf_counter()
        subprocess.run(
            [
                sys.executable,
                "-m",
                "grimodex_lfm_eval.benchmark",
                "--config",
                str(config_path),
                "--cold-child",
            ],
            check=True,
            capture_output=True,
            text=True,
            env={
                **os.environ,
                "HF_HUB_OFFLINE": "1",
                "TRANSFORMERS_OFFLINE": "1",
            },
        )
        samples.append(time.perf_counter() - started)
    return TimingMeasurement(
        workload=Workload.COLD_START,
        inputTokens=256,
        candidateCount=1,
        batchSize=1,
        threadCount=1,
        bucketed=False,
        warmupCount=0,
        phase="end_to_end",
        timing=summarize_timing_samples(
            samples,
            warmup_count=0,
            minimum_samples=5,
        ),
        candidateOrder=[revision],
        batchComposition=[[revision]],
    )


def _decision_for_best(
    measurements: Sequence[TimingMeasurement],
    workload: Workload,
    candidate_count: int,
) -> GateDecision:
    candidates = [
        measurement
        for measurement in measurements
        if measurement.workload == workload
        and measurement.candidate_count == candidate_count
        and measurement.phase == "end_to_end"
    ]
    if not candidates:
        raise ValueError(f"missing {workload} {candidate_count}-candidate measurement")
    best = min(candidates, key=lambda measurement: measurement.timing.p95_seconds)
    verdict = classify_speed_gate(
        workload,
        candidate_count=candidate_count,
        p95_seconds=best.timing.p95_seconds,
    )
    return GateDecision(
        workload=workload,
        candidateCount=candidate_count,
        p95Seconds=best.timing.p95_seconds,
        verdict=verdict,
        reason=(
            f"best batch={best.batch_size}, bucketed={best.bucketed}, "
            f"threads={best.thread_count}, context={best.context_mode or 'n/a'}"
        ),
    )


def run_early_gate(
    config_path: Path,
    output_path: Path | None = None,
    *,
    lengths_override: Sequence[int] | None = None,
    candidate_counts_override: Sequence[int] | None = None,
    batch_sizes_override: Sequence[int] | None = None,
    thread_counts_override: Sequence[str] | None = None,
    bucket_modes_override: Sequence[bool] | None = None,
    impact_context_modes_override: Sequence[str] | None = None,
    workloads_override: Sequence[Workload] | None = None,
    checkpoint_path: Path | None = None,
    stage: MeasurementStage = MeasurementStage.FINAL,
    pilot_repetitions: int = 1,
    include_cold_start: bool = True,
) -> Path:
    config = load_config(config_path)
    snapshot, revision, manifest_hash = _resolve_snapshot(config, config_path)
    experiment_root = config_path.parent.parent
    manifest_path = experiment_root / str(config["model"]["manifest"])
    benchmark = config["benchmark"]
    lengths = list(
        [int(value) for value in benchmark["lengths"]]
        if lengths_override is None
        else lengths_override
    )
    batch_sizes = list(
        [int(value) for value in benchmark["batch_sizes"]]
        if batch_sizes_override is None
        else batch_sizes_override
    )
    candidate_counts = list(
        (12, 30)
        if candidate_counts_override is None
        else candidate_counts_override
    )
    bucket_modes = list(
        (False, True)
        if bucket_modes_override is None
        else bucket_modes_override
    )
    impact_context_modes = list(
        ("full", "windowed")
        if impact_context_modes_override is None
        else impact_context_modes_override
    )
    workloads = set(
        (Workload.RELEVANCE, Workload.IMPACT)
        if workloads_override is None
        else workloads_override
    )
    if not batch_sizes:
        raise ValueError("at least one batch size is required")
    if not candidate_counts:
        raise ValueError("at least one candidate count is required")
    if not bucket_modes:
        raise ValueError("at least one bucket mode is required")
    if not workloads or not workloads <= {Workload.RELEVANCE, Workload.IMPACT}:
        raise ValueError("workloads must contain relevance and/or impact")
    invalid_context_modes = set(impact_context_modes) - {"full", "windowed"}
    if not impact_context_modes or invalid_context_modes:
        raise ValueError(
            "impact context modes must contain full and/or windowed"
        )
    import psutil

    physical_core_count = psutil.cpu_count(logical=False) or 1
    thread_counts = sorted(
        {
            physical_core_count if value == "physical" else int(value)
            for value in (
                thread_counts_override
                or [str(item) for item in benchmark["thread_counts"]]
            )
        }
    )
    if not thread_counts:
        raise ValueError("at least one thread count is required")
    warmup_count = (
        1 if stage == MeasurementStage.PILOT else int(benchmark["warmup_count"])
    )
    if pilot_repetitions <= 0:
        raise ValueError("pilot_repetitions must be positive")
    short_repetitions = (
        pilot_repetitions
        if stage == MeasurementStage.PILOT
        else int(benchmark["short_repetitions"])
    )
    long_repetitions = (
        pilot_repetitions
        if stage == MeasurementStage.PILOT
        else int(benchmark["long_repetitions"])
    )
    bootstrap_iterations = int(benchmark["bootstrap_iterations"])

    configure_hugging_face_environment(
        experiment_root,
        offline=True,
        configured_values=config.get("offline_environment"),
    )
    runtime_baseline_rss = _current_rss_bytes()
    tokenizer, classifier = _create_runtime(snapshot, manifest_path)
    checkpoint = (
        TimingCheckpoint(
            checkpoint_path,
            model_revision=revision,
            manifest_hash=manifest_hash,
        )
        if checkpoint_path is not None
        else None
    )
    idle_resident_bytes = max(0, _current_rss_bytes() - runtime_baseline_rss)
    measurements: list[TimingMeasurement] = []
    for thread_count in thread_counts:
        for length in lengths:
            measurements.extend(
                _measure_single_length(
                    tokenizer=tokenizer,
                    classifier=classifier,
                    target_tokens=length,
                    repetitions=(
                        short_repetitions if length <= 2048 else long_repetitions
                    ),
                    warmup_count=warmup_count,
                    thread_count=thread_count,
                    runtime_baseline_rss=runtime_baseline_rss,
                    idle_resident_bytes=idle_resident_bytes,
                    bootstrap_iterations=bootstrap_iterations,
                    stage=stage,
                )
            )
        for batch_size in batch_sizes:
            for bucketed in bucket_modes:
                if Workload.RELEVANCE in workloads:
                    for candidate_count in candidate_counts:
                        measurements.append(
                            _measure_workload(
                                tokenizer=tokenizer,
                                classifier=classifier,
                                workload=Workload.RELEVANCE,
                                candidate_count=candidate_count,
                                max_tokens=1024,
                                batch_size=batch_size,
                                bucketed=bucketed,
                                repetitions=short_repetitions,
                                warmup_count=warmup_count,
                                thread_count=thread_count,
                                runtime_baseline_rss=runtime_baseline_rss,
                                idle_resident_bytes=idle_resident_bytes,
                                bootstrap_iterations=bootstrap_iterations,
                                stage=stage,
                                checkpoint=checkpoint,
                            )
                        )
                if Workload.IMPACT in workloads:
                    for context_mode in impact_context_modes:
                        measurements.append(
                            _measure_workload(
                                tokenizer=tokenizer,
                                classifier=classifier,
                                workload=Workload.IMPACT,
                                candidate_count=30,
                                max_tokens=2048,
                                batch_size=batch_size,
                                bucketed=bucketed,
                                repetitions=short_repetitions,
                                warmup_count=warmup_count,
                                thread_count=thread_count,
                                context_mode=context_mode,
                                runtime_baseline_rss=runtime_baseline_rss,
                                idle_resident_bytes=idle_resident_bytes,
                                bootstrap_iterations=bootstrap_iterations,
                                stage=stage,
                                checkpoint=checkpoint,
                            )
                        )

    if include_cold_start and stage == MeasurementStage.FINAL:
        measurements.append(
            _measure_cold_start(
                config_path=config_path,
                revision=revision,
                repetitions=int(benchmark["cold_repetitions"]),
            )
        )
    decisions: list[GateDecision] = []
    if stage == MeasurementStage.FINAL:
        if Workload.RELEVANCE in workloads:
            decisions.extend(
                [
                    _decision_for_best(measurements, Workload.RELEVANCE, 12),
                    _decision_for_best(measurements, Workload.RELEVANCE, 30),
                ]
            )
        if Workload.IMPACT in workloads:
            decisions.append(
                _decision_for_best(measurements, Workload.IMPACT, 30)
            )
        if include_cold_start:
            cold = next(
                measurement
                for measurement in measurements
                if measurement.workload == Workload.COLD_START
            )
            decisions.append(
                GateDecision(
                    workload=Workload.COLD_START,
                    candidateCount=1,
                    p95Seconds=cold.timing.p95_seconds,
                    verdict=classify_speed_gate(
                        Workload.COLD_START,
                        candidate_count=1,
                        p95_seconds=cold.timing.p95_seconds,
                    ),
                    reason="independent process spawn, load, and first result",
                ),
            )

    from .host_profile import capture_host_profile

    report = PerformanceReport(
        runId=datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ"),
        createdAt=datetime.now(UTC),
        modelId=str(config["model"]["id"]),
        modelRevision=revision,
        manifestHash=manifest_hash,
        checkpointHash=None,
        dtype=str(config["model"].get("dtype", "float32")),
        measurementStage=stage,
        hostProfile=capture_host_profile(
            model_revision=revision,
            checkpoint_hash=None,
            dtype=str(config["model"].get("dtype", "float32")),
        ),
        measurements=measurements,
        decisions=decisions,
    )
    destination = output_path or (
        experiment_root
        / "artifacts"
        / "early-gate"
        / f"{report.run_id}.json"
    )
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(
        report.model_dump_json(by_alias=True, indent=2) + "\n",
        encoding="utf-8",
    )
    return destination


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument(
        "--mode",
        choices=("pilot", "early-gate"),
        default="early-gate",
    )
    parser.add_argument("--output", type=Path)
    parser.add_argument("--lengths")
    parser.add_argument("--candidate-counts")
    parser.add_argument("--batch-sizes")
    parser.add_argument("--thread-counts")
    parser.add_argument(
        "--bucket-modes",
        help="comma-separated naive,bucketed selection",
    )
    parser.add_argument(
        "--impact-context-modes",
        help="comma-separated full,windowed selection",
    )
    parser.add_argument(
        "--workloads",
        help="comma-separated relevance,impact selection",
    )
    parser.add_argument("--skip-length-sweep", action="store_true")
    parser.add_argument("--pilot-repetitions", type=int, default=1)
    parser.add_argument(
        "--checkpoint",
        type=Path,
        help="atomically retain each completed workload sample",
    )
    parser.add_argument("--skip-cold", action="store_true")
    parser.add_argument("--cold-child", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument(
        "--contention-child",
        action="store_true",
        help=argparse.SUPPRESS,
    )
    parser.add_argument(
        "--duration-seconds",
        type=float,
        default=30.0,
        help=argparse.SUPPRESS,
    )
    parser.add_argument(
        "--thread-count",
        type=int,
        default=4,
        help=argparse.SUPPRESS,
    )
    parser.add_argument(
        "--batch-size",
        type=int,
        default=4,
        help=argparse.SUPPRESS,
    )
    return parser


def main() -> int:
    arguments = _build_parser().parse_args()
    config_path = arguments.config.resolve()
    if arguments.cold_child:
        _cold_child(config_path)
        return 0
    if arguments.contention_child:
        _contention_child(
            config_path,
            duration_seconds=arguments.duration_seconds,
            thread_count=arguments.thread_count,
            batch_size=arguments.batch_size,
        )
        return 0

    def parse_integer_csv(value: str | None) -> list[int] | None:
        if value is None:
            return None
        return [int(item) for item in value.split(",") if item]

    def parse_bucket_modes(value: str | None) -> list[bool] | None:
        if value is None:
            return None
        names = [item for item in value.split(",") if item]
        invalid = set(names) - {"naive", "bucketed"}
        if not names or invalid:
            raise ValueError("--bucket-modes accepts naive and/or bucketed")
        return [name == "bucketed" for name in names]

    def parse_context_modes(value: str | None) -> list[str] | None:
        if value is None:
            return None
        names = [item for item in value.split(",") if item]
        invalid = set(names) - {"full", "windowed"}
        if not names or invalid:
            raise ValueError(
                "--impact-context-modes accepts full and/or windowed"
            )
        return names

    def parse_workloads(value: str | None) -> list[Workload] | None:
        if value is None:
            return None
        names = [item for item in value.split(",") if item]
        invalid = set(names) - {Workload.RELEVANCE, Workload.IMPACT}
        if not names or invalid:
            raise ValueError("--workloads accepts relevance and/or impact")
        return [Workload(name) for name in names]

    output = run_early_gate(
        config_path,
        arguments.output,
        lengths_override=(
            [] if arguments.skip_length_sweep else parse_integer_csv(arguments.lengths)
        ),
        candidate_counts_override=parse_integer_csv(arguments.candidate_counts),
        batch_sizes_override=parse_integer_csv(arguments.batch_sizes),
        thread_counts_override=(
            [item for item in arguments.thread_counts.split(",") if item]
            if arguments.thread_counts
            else None
        ),
        bucket_modes_override=parse_bucket_modes(arguments.bucket_modes),
        impact_context_modes_override=parse_context_modes(
            arguments.impact_context_modes
        ),
        workloads_override=parse_workloads(arguments.workloads),
        checkpoint_path=arguments.checkpoint,
        stage=(
            MeasurementStage.PILOT
            if arguments.mode == "pilot"
            else MeasurementStage.FINAL
        ),
        pilot_repetitions=arguments.pilot_repetitions,
        include_cold_start=not arguments.skip_cold,
    )
    print(json.dumps({"report": str(output)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
