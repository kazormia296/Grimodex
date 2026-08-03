"""Benchmark one pinned Phase 0b ONNX reranker against the C0.5 speed gates."""

from __future__ import annotations

import argparse
from datetime import UTC, datetime
import gc
import os
from pathlib import Path
import subprocess
import sys
import time
from typing import Any, Sequence

import psutil

from .benchmark import (
    batched_predict,
    classify_speed_gate,
    summarize_timing_samples,
)
from .config import configure_hugging_face_environment
from .host_profile import capture_host_profile
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
from .reranker_phase0b import (
    OnnxRerankerRuntime,
    Phase0bConfig,
    RerankerModelSpec,
    load_onnx_reranker,
    load_phase0b_config,
)


_JA_QUERY = (
    "王女が失踪前に港を訪れた伏線と、身分を隠して国外へ向かった可能性に"
    "関係する場面"
)
_JA_PASSAGE = (
    "夜明け前の港で、旅装の若い女性が銀の髪飾りを外し、古い航海図を"
    "船長へ渡した。見張りは王家の紋章に気づいたが、彼女は別人だと"
    "言い残して北行きの船へ乗った。後には潮で濡れた青いリボンだけが"
    "残され、城から来た騎士たちは互いに異なる証言を記録した。"
)
_EN_QUERY = (
    "scenes implying that the missing princess visited the harbor in disguise "
    "and planned to leave the kingdom"
)
_EN_PASSAGE = (
    "Before dawn at the harbor, a young traveler removed a silver hairpin and "
    "gave an old sea chart to the captain. A watchman noticed the royal crest, "
    "but she denied her identity and boarded a northbound ship. Only a blue "
    "ribbon remained when the castle guards arrived, and every witness offered "
    "a different account of the quiet departure."
)


def _current_rss_bytes() -> int:
    return psutil.Process().memory_info().rss


def _representative_workload(
    language: str,
    candidate_count: int,
) -> tuple[str, list[tuple[str, str, int]]]:
    if candidate_count <= 0:
        raise ValueError("candidate_count must be positive")
    if language == "ja":
        query, paragraph = _JA_QUERY, _JA_PASSAGE
    elif language == "en":
        query, paragraph = _EN_QUERY, _EN_PASSAGE
    else:
        raise ValueError(f"unsupported Phase 0b language: {language}")

    candidates: list[tuple[str, str, int]] = []
    for index in range(candidate_count):
        tier = 1 + (index % 4)
        marker = (
            f"候補{index + 1}。"
            if language == "ja"
            else f"Candidate {index + 1}. "
        )
        candidates.append(
            (
                f"{language}-relevance-{index:02d}",
                marker + (paragraph * (tier * 2)),
                tier,
            )
        )
    return query, candidates


def _measure_relevance(
    *,
    runtime: OnnxRerankerRuntime,
    language: str,
    candidate_count: int,
    batch_size: int,
    bucketed: bool,
    repetitions: int,
    warmup_count: int,
    thread_count: int,
    runtime_baseline_rss: int,
    idle_resident_bytes: int,
    bootstrap_iterations: int,
    stage: MeasurementStage,
) -> TimingMeasurement:
    query, candidates = _representative_workload(language, candidate_count)
    process = psutil.Process()
    peak_rss = _current_rss_bytes()
    samples: list[float] = []
    process_cpu_seconds = 0.0
    last_batch_composition: list[list[str]] = []
    last_attention_tokens = 0
    last_padded_tokens = 0

    for run_index in range(warmup_count + repetitions):
        batch_composition: list[list[str]] = []
        attention_tokens = 0
        padded_tokens = 0

        def predict_batch(batch: list[tuple[str, str, int]]) -> list[float]:
            nonlocal attention_tokens, padded_tokens, peak_rss
            batch_composition.append([item[0] for item in batch])
            scores = runtime.score_pairs(
                query,
                [item[1] for item in batch],
            )
            attention_tokens += runtime.last_attention_tokens
            padded_tokens += runtime.last_padded_tokens
            peak_rss = max(peak_rss, _current_rss_bytes())
            return scores

        cpu_times = process.cpu_times()
        cpu_started = cpu_times.user + cpu_times.system
        started = time.perf_counter()
        scores = batched_predict(
            candidates,
            batch_size=batch_size,
            predict_batch=predict_batch,
            bucket_by_length=bucketed,
            length_key=lambda item: item[2],
        )
        wall_seconds = time.perf_counter() - started
        cpu_times = process.cpu_times()
        cpu_seconds = cpu_times.user + cpu_times.system - cpu_started
        if len(scores) != candidate_count:
            raise RuntimeError("Phase 0b reranker lost a candidate")
        if run_index >= warmup_count:
            samples.append(wall_seconds)
            process_cpu_seconds += cpu_seconds
            last_batch_composition = batch_composition
            last_attention_tokens = attention_tokens
            last_padded_tokens = padded_tokens

    measured_wall_seconds = sum(samples)
    timing = summarize_timing_samples(
        samples,
        warmup_count=0,
        minimum_samples=1 if stage == MeasurementStage.PILOT else 30,
        bootstrap_iterations=bootstrap_iterations,
    )
    return TimingMeasurement(
        stage=stage,
        workload=Workload.RELEVANCE,
        inputTokens=runtime.max_pair_tokens,
        candidateCount=candidate_count,
        batchSize=batch_size,
        threadCount=thread_count,
        bucketed=bucketed,
        contextMode="full",
        warmupCount=warmup_count,
        phase="end_to_end",
        timing=timing,
        memory=MemorySummary(
            idleResidentBytes=idle_resident_bytes,
            peakInferenceBytes=max(0, peak_rss - runtime_baseline_rss),
        ),
        cpu=CpuSummary(
            processCpuSeconds=process_cpu_seconds,
            measuredWallSeconds=measured_wall_seconds,
            effectiveCores=(
                process_cpu_seconds / measured_wall_seconds
                if measured_wall_seconds > 0.0
                else 0.0
            ),
        ),
        throughput=ThroughputSummary(
            tokensPerSecond=(
                last_attention_tokens / timing.p50_seconds
                if timing.p50_seconds > 0.0
                else 0.0
            ),
            candidatesPerSecond=(
                candidate_count / timing.p50_seconds
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
        ),
        candidateOrder=[item[0] for item in candidates],
        batchComposition=last_batch_composition,
    )


def _best_decision(
    measurements: Sequence[TimingMeasurement],
    candidate_count: int,
) -> GateDecision:
    eligible = [
        measurement
        for measurement in measurements
        if measurement.workload == Workload.RELEVANCE
        and measurement.candidate_count == candidate_count
    ]
    if not eligible:
        raise ValueError(f"no relevance measurement for {candidate_count} candidates")
    best = min(eligible, key=lambda item: item.timing.p95_seconds)
    return GateDecision(
        workload=Workload.RELEVANCE,
        candidateCount=candidate_count,
        p95Seconds=best.timing.p95_seconds,
        verdict=classify_speed_gate(
            Workload.RELEVANCE,
            candidate_count=candidate_count,
            p95_seconds=best.timing.p95_seconds,
        ),
        reason=(
            f"Phase 0b ONNX max_pair_tokens={best.input_tokens}, "
            f"batch={best.batch_size}, bucketed={best.bucketed}, "
            f"threads={best.thread_count}"
        ),
    )


def _cold_child(
    config_path: Path,
    model_key: str,
    *,
    thread_count: int,
) -> None:
    config = load_phase0b_config(config_path)
    model = config.model(model_key)
    runtime, _ = load_onnx_reranker(
        config_path,
        config,
        model,
        thread_count=thread_count,
    )
    query, candidates = _representative_workload(model.language, 1)
    runtime.score_pairs(query, [candidates[0][1]])


def _measure_cold_start(
    config_path: Path,
    config: Phase0bConfig,
    model: RerankerModelSpec,
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
                "grimodex_lfm_eval.reranker_benchmark",
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
        candidateOrder=[model.revision],
        batchComposition=[[model.revision]],
    )


def _resolve_threads(
    configured: Sequence[int | str],
) -> list[int]:
    physical = psutil.cpu_count(logical=False) or 1
    resolved = [
        physical if value == "physical" else int(value)
        for value in configured
    ]
    if any(value <= 0 for value in resolved):
        raise ValueError("thread counts must be positive")
    return list(dict.fromkeys(resolved))


def run_phase0b_gate(
    config_path: Path,
    model_key: str,
    output_path: Path | None = None,
    *,
    candidate_counts_override: Sequence[int] | None = None,
    batch_sizes_override: Sequence[int] | None = None,
    thread_counts_override: Sequence[int | str] | None = None,
    bucket_modes_override: Sequence[bool] | None = None,
    stage: MeasurementStage = MeasurementStage.FINAL,
    pilot_repetitions: int = 1,
    include_cold_start: bool = True,
) -> Path:
    config = load_phase0b_config(config_path)
    model = config.model(model_key)
    candidate_counts = list(candidate_counts_override or (12, 30))
    if not candidate_counts or any(value not in {12, 30} for value in candidate_counts):
        raise ValueError("candidate counts must contain 12 and/or 30")
    batch_sizes = list(batch_sizes_override or config.benchmark.batch_sizes)
    if not batch_sizes or any(value <= 0 for value in batch_sizes):
        raise ValueError("batch sizes must be positive")
    thread_counts = _resolve_threads(
        thread_counts_override or config.benchmark.thread_counts
    )
    bucket_modes = list(
        bucket_modes_override
        if bucket_modes_override is not None
        else (False, True)
    )
    if not bucket_modes:
        raise ValueError("at least one bucket mode is required")
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
    for thread_count in thread_counts:
        runtime_baseline_rss = _current_rss_bytes()
        runtime, verified_manifest_hash = load_onnx_reranker(
            config_path,
            config,
            model,
            thread_count=thread_count,
        )
        if manifest_hash is None:
            manifest_hash = verified_manifest_hash
        elif manifest_hash != verified_manifest_hash:
            raise RuntimeError("model manifest changed during benchmark")
        idle_resident_bytes = max(0, _current_rss_bytes() - runtime_baseline_rss)
        for batch_size in batch_sizes:
            for bucketed in bucket_modes:
                for candidate_count in candidate_counts:
                    measurements.append(
                        _measure_relevance(
                            runtime=runtime,
                            language=model.language,
                            candidate_count=candidate_count,
                            batch_size=batch_size,
                            bucketed=bucketed,
                            repetitions=repetitions,
                            warmup_count=warmup_count,
                            thread_count=thread_count,
                            runtime_baseline_rss=runtime_baseline_rss,
                            idle_resident_bytes=idle_resident_bytes,
                            bootstrap_iterations=config.benchmark.bootstrap_iterations,
                            stage=stage,
                        )
                    )
        del runtime
        gc.collect()

    decisions: list[GateDecision] = []
    if stage == MeasurementStage.FINAL:
        decisions.extend(
            _best_decision(measurements, candidate_count)
            for candidate_count in candidate_counts
        )
        if include_cold_start:
            best_warm = min(
                (
                    measurement
                    for measurement in measurements
                    if measurement.candidate_count == max(candidate_counts)
                ),
                key=lambda item: item.timing.p95_seconds,
            )
            cold = _measure_cold_start(
                config_path,
                config,
                model,
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
                    reason="process spawn, manifest verification, load, and first pair",
                )
            )

    if manifest_hash is None:
        raise RuntimeError("Phase 0b benchmark produced no model manifest")
    host_profile = capture_host_profile(
        model_revision=model.revision,
        checkpoint_hash=model.artifact_sha256,
        dtype=model.quantization,
    )
    host_profile["phase0b"] = {
        "modelKey": model.key,
        "language": model.language,
        "license": model.license,
        "artifact": model.artifact,
        "artifactSha256": model.artifact_sha256,
        "maxPairTokens": config.benchmark.max_pair_tokens,
        "session": config.session.model_dump(),
    }
    timestamp = datetime.now(UTC)
    report = PerformanceReport(
        runId=f"{timestamp.strftime('%Y%m%dT%H%M%SZ')}-{model.key}",
        createdAt=timestamp,
        modelId=model.model_id,
        modelRevision=model.revision,
        manifestHash=manifest_hash,
        checkpointHash=model.artifact_sha256,
        dtype=model.quantization,
        measurementStage=stage,
        hostProfile=host_profile,
        measurements=measurements,
        decisions=decisions,
    )
    destination = output_path or (
        experiment_root
        / "artifacts"
        / "phase0b"
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
    parser.add_argument("--candidate-counts")
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
    destination = run_phase0b_gate(
        config_path,
        arguments.model,
        arguments.output,
        candidate_counts_override=(
            [int(value) for value in _csv(arguments.candidate_counts)]
            if arguments.candidate_counts
            else None
        ),
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
    print(destination)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
