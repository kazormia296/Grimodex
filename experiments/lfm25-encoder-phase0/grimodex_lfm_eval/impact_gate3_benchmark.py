"""Benchmark pinned FP32 backbones for Impact Review Gate 3."""

from __future__ import annotations

import argparse
from datetime import UTC, datetime
import gc
import hashlib
import os
from pathlib import Path
import subprocess
import sys
import time
from typing import Any, Sequence

import psutil

from .benchmark import classify_speed_gate, summarize_timing_samples
from .config import configure_hugging_face_environment
from .host_profile import capture_host_profile
from .impact_gate3 import (
    ImpactGate3Candidate,
    ImpactGate3Config,
    ImpactGate3ModelSpec,
    ImpactGate3Runtime,
    ImpactGate3Workload,
    load_impact_gate3_config,
    load_impact_gate3_runtime,
    load_impact_gate3_workload,
)
from .performance_schema import (
    CpuSummary,
    GateDecision,
    MeasurementStage,
    MemorySummary,
    PerformanceReport,
    ThroughputSummary,
    TimingMeasurement,
    Workload,
)


def _current_rss_bytes() -> int:
    return psutil.Process().memory_info().rss


def _cpu_seconds(process: psutil.Process) -> float:
    times = process.cpu_times()
    return times.user + times.system


def _resolve_threads(configured: Sequence[int | str]) -> list[int]:
    physical = psutil.cpu_count(logical=False) or 1
    resolved = [
        physical if value == "physical" else int(value)
        for value in configured
    ]
    if any(value <= 0 for value in resolved):
        raise ValueError("Gate 3 thread counts must be positive")
    return list(dict.fromkeys(resolved))


def _batches(
    workload: ImpactGate3Workload,
    *,
    batch_size: int,
    bucketed: bool,
    token_counts: dict[str, int],
) -> list[list[ImpactGate3Candidate]]:
    ordered = list(workload.candidates)
    if bucketed:
        ordered.sort(
            key=lambda candidate: (
                token_counts[candidate.candidate_id],
                candidate.dense_rank,
                candidate.candidate_id,
            )
        )
    return [
        ordered[offset : offset + batch_size]
        for offset in range(0, len(ordered), batch_size)
    ]


def _cpu_summary(
    *,
    process_cpu_seconds: float,
    measured_wall_seconds: float,
) -> CpuSummary:
    return CpuSummary(
        processCpuSeconds=process_cpu_seconds,
        measuredWallSeconds=measured_wall_seconds,
        effectiveCores=(
            process_cpu_seconds / measured_wall_seconds
            if measured_wall_seconds > 0.0
            else 0.0
        ),
    )


def _measure_impact(
    *,
    runtime: ImpactGate3Runtime,
    workload: ImpactGate3Workload,
    token_counts: dict[str, int],
    batch_size: int,
    bucketed: bool,
    repetitions: int,
    warmup_count: int,
    thread_count: int,
    runtime_baseline_rss: int,
    idle_resident_bytes: int,
    bootstrap_iterations: int,
    stage: MeasurementStage,
) -> list[TimingMeasurement]:
    if len(workload.candidates) != 30:
        raise ValueError("Impact Gate 3 requires exactly 30 candidates")
    candidate_batches = _batches(
        workload,
        batch_size=batch_size,
        bucketed=bucketed,
        token_counts=token_counts,
    )
    process = psutil.Process()
    peak_rss = _current_rss_bytes()
    phase_samples: dict[str, list[float]] = {
        "tokenization": [],
        "forward": [],
        "end_to_end": [],
    }
    phase_cpu_seconds = {phase: 0.0 for phase in phase_samples}
    last_batch_composition: list[list[str]] = []
    last_attention_tokens = 0
    last_padded_tokens = 0

    for run_index in range(warmup_count + repetitions):
        tokenization_seconds = 0.0
        forward_seconds = 0.0
        tokenization_cpu_seconds = 0.0
        forward_cpu_seconds = 0.0
        attention_tokens = 0
        padded_tokens = 0
        scores: list[float] = []
        process_started = _cpu_seconds(process)
        run_started = time.perf_counter()

        for batch in candidate_batches:
            cpu_started = _cpu_seconds(process)
            started = time.perf_counter()
            encoded = runtime.encode_pairs(
                workload.query,
                [candidate.text for candidate in batch],
            )
            tokenization_seconds += time.perf_counter() - started
            tokenization_cpu_seconds += _cpu_seconds(process) - cpu_started
            attention_tokens += runtime.last_attention_tokens
            padded_tokens += runtime.last_padded_tokens
            peak_rss = max(peak_rss, _current_rss_bytes())

            cpu_started = _cpu_seconds(process)
            started = time.perf_counter()
            batch_scores = runtime.forward_encoded(encoded)
            forward_seconds += time.perf_counter() - started
            forward_cpu_seconds += _cpu_seconds(process) - cpu_started
            if len(batch_scores) != len(batch):
                raise RuntimeError("Impact Gate 3 classifier lost a candidate")
            scores.extend(batch_scores)
            peak_rss = max(peak_rss, _current_rss_bytes())

        end_to_end_seconds = time.perf_counter() - run_started
        end_to_end_cpu_seconds = _cpu_seconds(process) - process_started
        if len(scores) != len(workload.candidates):
            raise RuntimeError("Impact Gate 3 benchmark lost a candidate")
        if run_index < warmup_count:
            continue
        phase_samples["tokenization"].append(tokenization_seconds)
        phase_samples["forward"].append(forward_seconds)
        phase_samples["end_to_end"].append(end_to_end_seconds)
        phase_cpu_seconds["tokenization"] += tokenization_cpu_seconds
        phase_cpu_seconds["forward"] += forward_cpu_seconds
        phase_cpu_seconds["end_to_end"] += end_to_end_cpu_seconds
        last_batch_composition = [
            [candidate.candidate_id for candidate in batch]
            for batch in candidate_batches
        ]
        last_attention_tokens = attention_tokens
        last_padded_tokens = padded_tokens

    minimum_samples = 1 if stage == MeasurementStage.PILOT else 30
    timings = {
        phase: summarize_timing_samples(
            samples,
            warmup_count=0,
            minimum_samples=minimum_samples,
            bootstrap_iterations=bootstrap_iterations,
        )
        for phase, samples in phase_samples.items()
    }
    peak_inference_bytes = max(0, peak_rss - runtime_baseline_rss)
    measurements: list[TimingMeasurement] = []
    for phase in ("tokenization", "forward", "end_to_end"):
        timing = timings[phase]
        throughput = ThroughputSummary()
        if phase == "end_to_end":
            throughput = ThroughputSummary(
                tokensPerSecond=(
                    last_attention_tokens / timing.p50_seconds
                    if timing.p50_seconds > 0.0
                    else 0.0
                ),
                candidatesPerSecond=(
                    len(workload.candidates) / timing.p50_seconds
                    if timing.p50_seconds > 0.0
                    else 0.0
                ),
                paddedTokens=last_padded_tokens,
                attentionTokens=last_attention_tokens,
                paddingFraction=(
                    (last_padded_tokens - last_attention_tokens)
                    / last_padded_tokens
                    if last_padded_tokens
                    else 0.0
                ),
            )
        measurements.append(
            TimingMeasurement(
                stage=stage,
                workload=Workload.IMPACT,
                inputTokens=runtime.max_pair_tokens,
                candidateCount=len(workload.candidates),
                batchSize=batch_size,
                threadCount=thread_count,
                bucketed=bucketed,
                contextMode="windowed",
                windowCount=len(workload.candidates),
                warmupCount=warmup_count,
                phase=phase,
                timing=timing,
                memory=MemorySummary(
                    idleResidentBytes=idle_resident_bytes,
                    peakInferenceBytes=peak_inference_bytes,
                ),
                cpu=_cpu_summary(
                    process_cpu_seconds=phase_cpu_seconds[phase],
                    measured_wall_seconds=sum(phase_samples[phase]),
                ),
                throughput=throughput,
                candidateOrder=[
                    candidate.candidate_id
                    for candidate in workload.candidates
                ],
                batchComposition=last_batch_composition,
            )
        )
    return measurements


def _best_decision(
    measurements: Sequence[TimingMeasurement],
) -> GateDecision:
    eligible = [
        measurement
        for measurement in measurements
        if measurement.workload == Workload.IMPACT
        and measurement.phase == "end_to_end"
        and measurement.candidate_count == 30
    ]
    if not eligible:
        raise ValueError("Gate 3 produced no end-to-end Impact measurement")
    best = min(eligible, key=lambda item: item.timing.p95_seconds)
    return GateDecision(
        workload=Workload.IMPACT,
        candidateCount=30,
        p95Seconds=best.timing.p95_seconds,
        verdict=classify_speed_gate(
            Workload.IMPACT,
            candidate_count=30,
            p95_seconds=best.timing.p95_seconds,
        ),
        reason=(
            "temporary random linear head over masked-mean backbone output; "
            f"max_pair_tokens={best.input_tokens}, batch={best.batch_size}, "
            f"bucketed={best.bucketed}, threads={best.thread_count}"
        ),
    )


def _cold_child(
    config_path: Path,
    model_key: str,
    *,
    thread_count: int,
) -> None:
    config = load_impact_gate3_config(config_path)
    model = config.model(model_key)
    workload = load_impact_gate3_workload(config_path, config)
    runtime, _, _ = load_impact_gate3_runtime(
        config_path,
        config,
        model,
        thread_count=thread_count,
    )
    runtime.score_pairs(
        workload.query,
        [workload.candidates[0].text],
    )


def _measure_cold_start(
    config_path: Path,
    config: ImpactGate3Config,
    model: ImpactGate3ModelSpec,
    workload: ImpactGate3Workload,
    *,
    thread_count: int,
) -> TimingMeasurement:
    experiment_root = config_path.resolve().parent.parent
    configure_hugging_face_environment(
        experiment_root,
        offline=True,
        configured_values=config.offline_environment,
    )
    environment = os.environ.copy()
    environment.update(
        {
            key: str(value)
            for key, value in config.offline_environment.items()
        }
    )
    samples: list[float] = []
    for _ in range(config.benchmark.cold_repetitions):
        started = time.perf_counter()
        subprocess.run(
            [
                sys.executable,
                "-m",
                "grimodex_lfm_eval.impact_gate3_benchmark",
                "--config",
                str(config_path),
                "--model",
                model.key,
                "--cold-child",
                "--thread-count",
                str(thread_count),
            ],
            check=True,
            cwd=experiment_root,
            env=environment,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
        )
        samples.append(time.perf_counter() - started)
    timing = summarize_timing_samples(
        samples,
        warmup_count=0,
        minimum_samples=5,
        bootstrap_iterations=config.benchmark.bootstrap_iterations,
    )
    return TimingMeasurement(
        stage=MeasurementStage.FINAL,
        workload=Workload.COLD_START,
        inputTokens=config.benchmark.max_pair_tokens,
        candidateCount=1,
        batchSize=1,
        threadCount=thread_count,
        bucketed=False,
        warmupCount=0,
        phase="end_to_end",
        timing=timing,
        memory=MemorySummary(),
        cpu=CpuSummary(),
        throughput=ThroughputSummary(),
        candidateOrder=[workload.candidates[0].candidate_id],
        batchComposition=[[workload.candidates[0].candidate_id]],
    )


def _percentile(values: Sequence[int], probability: float) -> int:
    if not values:
        raise ValueError("cannot summarize an empty token distribution")
    ordered = sorted(values)
    index = min(len(ordered) - 1, round((len(ordered) - 1) * probability))
    return ordered[index]


def run_impact_gate3(
    config_path: Path,
    model_key: str,
    output_path: Path | None = None,
    *,
    batch_sizes_override: Sequence[int] | None = None,
    thread_counts_override: Sequence[int | str] | None = None,
    bucket_modes_override: Sequence[bool] | None = None,
    stage: MeasurementStage = MeasurementStage.FINAL,
    pilot_repetitions: int = 1,
    include_cold_start: bool = True,
) -> Path:
    config = load_impact_gate3_config(config_path)
    model = config.model(model_key)
    workload = load_impact_gate3_workload(config_path, config)
    batch_sizes = list(batch_sizes_override or config.benchmark.batch_sizes)
    if not batch_sizes or any(value <= 0 or value > 30 for value in batch_sizes):
        raise ValueError("Gate 3 batch sizes must be in 1..=30")
    thread_counts = _resolve_threads(
        thread_counts_override or config.benchmark.thread_counts
    )
    bucket_modes = list(
        bucket_modes_override
        if bucket_modes_override is not None
        else (False, True)
    )
    if not bucket_modes:
        raise ValueError("Gate 3 needs at least one bucket mode")
    if pilot_repetitions <= 0:
        raise ValueError("pilot_repetitions must be positive")

    repetitions = (
        pilot_repetitions
        if stage == MeasurementStage.PILOT
        else config.benchmark.repetitions
    )
    warmup_count = (
        1
        if stage == MeasurementStage.PILOT
        else config.benchmark.warmup_count
    )
    experiment_root = config_path.resolve().parent.parent
    configure_hugging_face_environment(
        experiment_root,
        offline=True,
        configured_values=config.offline_environment,
    )

    measurements: list[TimingMeasurement] = []
    manifest_hash: str | None = None
    loading_summary: dict[str, tuple[str, ...]] | None = None
    workload_profile: dict[str, Any] | None = None
    for thread_count in thread_counts:
        runtime_baseline_rss = _current_rss_bytes()
        runtime, verified_manifest_hash, verified_loading_summary = (
            load_impact_gate3_runtime(
                config_path,
                config,
                model,
                thread_count=thread_count,
            )
        )
        if manifest_hash is None:
            manifest_hash = verified_manifest_hash
            loading_summary = verified_loading_summary
        elif manifest_hash != verified_manifest_hash:
            raise RuntimeError("Gate 3 model manifest changed during benchmark")
        elif loading_summary != verified_loading_summary:
            raise RuntimeError("Gate 3 backbone loading summary changed")

        idle_resident_bytes = max(
            0,
            _current_rss_bytes() - runtime_baseline_rss,
        )
        query_tokens = runtime.token_count(workload.query)
        if query_tokens > config.benchmark.query_token_budget:
            raise ValueError(
                "Gate 3 query exceeds the configured 128-token budget"
            )
        token_counts = {
            candidate.candidate_id: runtime.token_count(candidate.text)
            for candidate in workload.candidates
        }
        if workload_profile is None:
            scene_tokens = list(token_counts.values())
            workload_profile = {
                "sourceSha256": workload.source_sha256,
                "sourceQueryId": workload.source_query_id,
                "querySha256": hashlib.sha256(
                    workload.query.encode("utf-8")
                ).hexdigest(),
                "queryTokens": query_tokens,
                "queryTokenBudget": config.benchmark.query_token_budget,
                "sceneTokenBudget": config.benchmark.scene_token_budget,
                "sceneTokens": {
                    "minimum": min(scene_tokens),
                    "p50": _percentile(scene_tokens, 0.50),
                    "p95": _percentile(scene_tokens, 0.95),
                    "maximum": max(scene_tokens),
                    "truncatedCount": sum(
                        value > config.benchmark.scene_token_budget
                        for value in scene_tokens
                    ),
                },
                "candidateCount": len(workload.candidates),
            }

        for batch_size in batch_sizes:
            for bucketed in bucket_modes:
                measurements.extend(
                    _measure_impact(
                        runtime=runtime,
                        workload=workload,
                        token_counts=token_counts,
                        batch_size=batch_size,
                        bucketed=bucketed,
                        repetitions=repetitions,
                        warmup_count=warmup_count,
                        thread_count=thread_count,
                        runtime_baseline_rss=runtime_baseline_rss,
                        idle_resident_bytes=idle_resident_bytes,
                        bootstrap_iterations=(
                            config.benchmark.bootstrap_iterations
                        ),
                        stage=stage,
                    )
                )
        del runtime
        gc.collect()

    if manifest_hash is None or loading_summary is None:
        raise RuntimeError("Gate 3 benchmark produced no model manifest")
    if workload_profile is None:
        raise RuntimeError("Gate 3 benchmark produced no workload profile")

    decisions: list[GateDecision] = []
    if stage == MeasurementStage.FINAL:
        impact_decision = _best_decision(measurements)
        decisions.append(impact_decision)
        if include_cold_start:
            best_warm = min(
                (
                    measurement
                    for measurement in measurements
                    if measurement.workload == Workload.IMPACT
                    and measurement.phase == "end_to_end"
                ),
                key=lambda item: item.timing.p95_seconds,
            )
            cold = _measure_cold_start(
                config_path,
                config,
                model,
                workload,
                thread_count=best_warm.thread_count,
            )
            measurements.append(cold)
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
                    reason=(
                        "process spawn, manifest verification, FP32 backbone "
                        "load, temporary head creation, and first pair"
                    ),
                )
            )

    host_profile = capture_host_profile(
        model_revision=model.revision,
        checkpoint_hash=model.weight_sha256,
        dtype=model.dtype,
    )
    host_profile["impactGate3"] = {
        "modelKey": model.key,
        "license": model.license,
        "weight": model.weight,
        "weightSha256": model.weight_sha256,
        "maxPairTokens": config.benchmark.max_pair_tokens,
        "headPolicy": "seed-42-linear(masked-mean(backbone-last-hidden-state))",
        "qualityClaim": "none; temporary head is for pre-training speed only",
        "loadingSummary": loading_summary,
        "workload": workload_profile,
        "thresholdSeconds": {
            "target": config.benchmark.target_seconds,
            "conditional": config.benchmark.conditional_seconds,
            "hold": config.benchmark.hold_seconds,
        },
    }
    timestamp = datetime.now(UTC)
    report = PerformanceReport(
        runId=f"{timestamp.strftime('%Y%m%dT%H%M%SZ')}-gate3-{model.key}",
        createdAt=timestamp,
        modelId=model.model_id,
        modelRevision=model.revision,
        manifestHash=manifest_hash,
        checkpointHash=model.weight_sha256,
        dtype=model.dtype,
        measurementStage=stage,
        hostProfile=host_profile,
        measurements=measurements,
        decisions=decisions,
    )
    destination = output_path or (
        experiment_root
        / "artifacts"
        / "phase0b"
        / "gate3"
        / f"{report.run_id}.json"
    )
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(
        report.model_dump_json(by_alias=True, indent=2) + "\n",
        encoding="utf-8",
    )
    return destination


def _csv(value: str) -> list[str]:
    return [item.strip() for item in value.split(",") if item.strip()]


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument(
        "--mode",
        choices=("pilot", "early-gate"),
        default="early-gate",
    )
    parser.add_argument("--output", type=Path)
    parser.add_argument("--batch-sizes")
    parser.add_argument("--thread-counts")
    parser.add_argument(
        "--bucket-modes",
        help="comma-separated naive,bucketed selection",
    )
    parser.add_argument("--pilot-repetitions", type=int, default=1)
    parser.add_argument("--skip-cold", action="store_true")
    parser.add_argument("--cold-child", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument(
        "--thread-count",
        type=int,
        default=4,
        help=argparse.SUPPRESS,
    )
    return parser


def main() -> int:
    arguments = _build_parser().parse_args()
    config_path = arguments.config.resolve()
    if arguments.cold_child:
        _cold_child(
            config_path,
            arguments.model,
            thread_count=arguments.thread_count,
        )
        return 0
    stage = (
        MeasurementStage.PILOT
        if arguments.mode == "pilot"
        else MeasurementStage.FINAL
    )
    bucket_modes: list[bool] | None = None
    if arguments.bucket_modes:
        mapping = {"naive": False, "bucketed": True}
        requested = _csv(arguments.bucket_modes)
        if any(item not in mapping for item in requested):
            raise ValueError("bucket modes must be naive and/or bucketed")
        bucket_modes = [mapping[item] for item in requested]
    try:
        destination = run_impact_gate3(
            config_path,
            arguments.model,
            arguments.output,
            batch_sizes_override=(
                [int(value) for value in _csv(arguments.batch_sizes)]
                if arguments.batch_sizes
                else None
            ),
            thread_counts_override=(
                _csv(arguments.thread_counts)
                if arguments.thread_counts
                else None
            ),
            bucket_modes_override=bucket_modes,
            stage=stage,
            pilot_repetitions=arguments.pilot_repetitions,
            include_cold_start=not arguments.skip_cold,
        )
    except (OSError, RuntimeError, ValueError) as error:
        print(str(error), file=sys.stderr)
        return 2
    print(destination)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
