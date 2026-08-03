"""Benchmark distinct full scenes and saturated windows for Impact Gate 3.1."""

from __future__ import annotations

import argparse
from datetime import UTC, datetime
import gc
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import time
from typing import Any, Sequence

import psutil

from .benchmark import summarize_timing_samples
from .host_profile import capture_host_profile
from .impact_gate3 import canonical_impact_query
from .impact_gate31 import (
    ImpactGate31Config,
    ImpactGate31Runtime,
    ImpactGate31Window,
    ImpactGate31Workload,
    aggregate_scene_scores,
    load_impact_gate31_config,
    load_impact_gate31_runtime,
    load_impact_gate31_workload,
    prepare_impact_gate31_workload,
    sha256_file,
)


def _resolve_threads(configured: Sequence[int | str]) -> list[int]:
    physical = psutil.cpu_count(logical=False) or 1
    resolved = [
        physical if value == "physical" else int(value)
        for value in configured
    ]
    if any(value <= 0 for value in resolved):
        raise ValueError("Gate 3.1 thread counts must be positive")
    return list(dict.fromkeys(resolved))


def _batches(
    windows: Sequence[ImpactGate31Window],
    *,
    batch_size: int,
    bucketed: bool,
) -> list[list[ImpactGate31Window]]:
    ordered = list(windows)
    if bucketed:
        ordered.sort(
            key=lambda window: (
                len(window.token_ids),
                window.scene_id,
                window.index,
            )
        )
    return [
        ordered[offset : offset + batch_size]
        for offset in range(0, len(ordered), batch_size)
    ]


def _phase_summary(
    samples: Sequence[float],
    *,
    warmup_count: int,
    repetitions: int,
    bootstrap_iterations: int,
) -> dict[str, Any]:
    summary = summarize_timing_samples(
        list(samples),
        warmup_count=0,
        minimum_samples=1 if repetitions < 30 else 30,
        bootstrap_iterations=bootstrap_iterations,
    )
    return {
        **summary.model_dump(by_alias=True),
        "warmupCount": warmup_count,
        "sampleCount": repetitions,
    }


def _measure_workload(
    *,
    runtime: ImpactGate31Runtime,
    config: ImpactGate31Config,
    workload: ImpactGate31Workload,
    workload_kind: str,
    batch_size: int,
    bucketed: bool,
    thread_count: int,
    repetitions: int,
    warmup_count: int,
    runtime_baseline_rss: int,
) -> dict[str, Any]:
    if workload_kind not in {"full-scenes", "cap-stress"}:
        raise ValueError(f"unknown Gate 3.1 workload: {workload_kind}")
    prepared_template = prepare_impact_gate31_workload(
        runtime,
        config,
        workload,
    )
    if not runtime.pair_parity_verified:
        for scene in workload.scenes:
            scene_ids = runtime.tokenize_without_special_tokens(scene.plain_text)
            if (
                len(prepared_template.query_token_ids)
                + len(scene_ids)
                + runtime.tokenizer.num_special_tokens_to_add(pair=True)
                <= runtime.max_pair_tokens
            ):
                runtime.verify_text_pair_parity(
                    prepared_template.query,
                    scene.plain_text,
                )
                break
        if not runtime.pair_parity_verified:
            raise ValueError(
                "Gate 3.1 workload lacks an untruncated tokenizer parity pair"
            )
    phase_names = (
        ("scene_tokenization_windowing", "pair_encoding", "forward", "end_to_end")
        if workload_kind == "full-scenes"
        else ("pair_encoding", "forward", "end_to_end")
    )
    phase_samples = {phase: [] for phase in phase_names}
    peak_rss = psutil.Process().memory_info().rss
    last_attention_tokens = 0
    last_padded_tokens = 0
    last_distribution = prepared_template.distribution
    last_window_count = 0
    last_scene_score_count = 0

    for run_index in range(warmup_count + repetitions):
        phase_seconds = {phase: 0.0 for phase in phase_names}
        run_started = time.perf_counter()
        if workload_kind == "full-scenes":
            started = time.perf_counter()
            prepared = prepare_impact_gate31_workload(
                runtime,
                config,
                workload,
            )
            phase_seconds["scene_tokenization_windowing"] = (
                time.perf_counter() - started
            )
            windows = prepared.windows
            distribution = prepared.distribution
        else:
            prepared = prepared_template
            windows = prepared.cap_stress_windows
            distribution = {
                "sceneCount": config.benchmark.cap_stress_window_count,
                "windowCount": config.benchmark.cap_stress_window_count,
                "windowsPerScene": {"p50": 1.0, "p95": 1.0, "max": 1},
                "sceneTokens": (
                    config.benchmark.cap_stress_window_count
                    * config.benchmark.scene_window_tokens
                ),
                "windowSceneTokens": (
                    config.benchmark.cap_stress_window_count
                    * config.benchmark.scene_window_tokens
                ),
                "truncatedSceneCount": 0,
                "queryTokens": len(prepared.query_token_ids),
            }
        batches = _batches(
            windows,
            batch_size=batch_size,
            bucketed=bucketed,
        )
        attention_tokens = 0
        padded_tokens = 0
        scored_scene_ids: list[str] = []
        scores: list[float] = []
        for batch in batches:
            started = time.perf_counter()
            encoded = runtime.encode_token_windows(
                prepared.query_token_ids,
                [window.token_ids for window in batch],
            )
            phase_seconds["pair_encoding"] += time.perf_counter() - started
            attention_tokens += runtime.last_attention_tokens
            padded_tokens += runtime.last_padded_tokens
            peak_rss = max(peak_rss, psutil.Process().memory_info().rss)

            started = time.perf_counter()
            batch_scores = runtime.forward_encoded(encoded)
            phase_seconds["forward"] += time.perf_counter() - started
            if len(batch_scores) != len(batch):
                raise RuntimeError("Gate 3.1 classifier lost a window")
            scores.extend(batch_scores)
            scored_scene_ids.extend(window.scene_id for window in batch)
            peak_rss = max(peak_rss, psutil.Process().memory_info().rss)
        if len(scores) != len(windows):
            raise RuntimeError("Gate 3.1 benchmark lost a window")
        scene_scores = aggregate_scene_scores(scored_scene_ids, scores)
        expected_scene_scores = (
            config.benchmark.full_scene_count
            if workload_kind == "full-scenes"
            else config.benchmark.cap_stress_window_count
        )
        if len(scene_scores) != expected_scene_scores:
            raise RuntimeError("Gate 3.1 scene max aggregation lost a scene")
        phase_seconds["end_to_end"] = time.perf_counter() - run_started
        if run_index < warmup_count:
            continue
        for phase in phase_names:
            phase_samples[phase].append(phase_seconds[phase])
        last_attention_tokens = attention_tokens
        last_padded_tokens = padded_tokens
        last_distribution = distribution
        last_window_count = len(windows)
        last_scene_score_count = len(scene_scores)

    summaries = {
        phase: _phase_summary(
            samples,
            warmup_count=warmup_count,
            repetitions=repetitions,
            bootstrap_iterations=config.benchmark.bootstrap_iterations,
        )
        for phase, samples in phase_samples.items()
    }
    p50 = summaries["end_to_end"]["p50Seconds"]
    return {
        "workload": workload_kind,
        "batchSize": batch_size,
        "threadCount": thread_count,
        "bucketed": bucketed,
        "distribution": {
            **last_distribution,
            "attentionTokens": last_attention_tokens,
            "paddedTokens": last_padded_tokens,
            "paddingFraction": (
                (last_padded_tokens - last_attention_tokens)
                / last_padded_tokens
                if last_padded_tokens
                else 0.0
            ),
            "sceneScoreCount": last_scene_score_count,
        },
        "phases": summaries,
        "throughput": {
            "windowsPerSecondP50": (
                last_window_count / p50 if p50 > 0.0 else 0.0
            ),
            "attentionTokensPerSecondP50": (
                last_attention_tokens / p50 if p50 > 0.0 else 0.0
            ),
        },
        "memory": {
            "peakInferenceBytes": max(0, peak_rss - runtime_baseline_rss),
        },
    }


def _speed_band(seconds: float, config: ImpactGate31Config) -> str:
    if seconds <= config.benchmark.target_seconds:
        return "Target"
    if seconds <= config.benchmark.conditional_seconds:
        return "Conditional"
    if seconds <= config.benchmark.hold_seconds:
        return "Hold"
    return "Reject"


def _git_head(experiment_root: Path) -> str:
    try:
        return subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=experiment_root,
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return "unavailable"


def run_impact_gate31(
    config_path: Path,
    model_key: str,
    output_path: Path | None = None,
    *,
    batch_sizes_override: Sequence[int] | None = None,
    thread_counts_override: Sequence[int | str] | None = None,
    bucket_modes_override: Sequence[bool] | None = None,
    pilot: bool = False,
    pilot_repetitions: int = 1,
) -> Path:
    config = load_impact_gate31_config(config_path)
    workload = load_impact_gate31_workload(config_path, config)
    batch_sizes = list(batch_sizes_override or config.benchmark.batch_sizes)
    if not batch_sizes or any(value <= 0 or value > 30 for value in batch_sizes):
        raise ValueError("Gate 3.1 batch sizes must be in 1..=30")
    thread_counts = _resolve_threads(
        thread_counts_override or config.benchmark.thread_counts
    )
    bucket_modes = list(
        bucket_modes_override
        if bucket_modes_override is not None
        else (False, True)
    )
    if not bucket_modes:
        raise ValueError("Gate 3.1 requires at least one bucket mode")
    if pilot_repetitions <= 0:
        raise ValueError("Gate 3.1 pilot repetitions must be positive")
    repetitions = pilot_repetitions if pilot else config.benchmark.repetitions
    warmup_count = 1 if pilot else config.benchmark.warmup_count
    experiment_root = config_path.resolve().parent.parent

    configurations: list[dict[str, Any]] = []
    manifest_hash: str | None = None
    loading_summary: dict[str, tuple[str, ...]] | None = None
    gate3_config = None
    for thread_count in thread_counts:
        runtime_baseline_rss = psutil.Process().memory_info().rss
        runtime, loaded_gate3_config, current_manifest, current_loading = (
            load_impact_gate31_runtime(
                config_path,
                config,
                model_key=model_key,
                thread_count=thread_count,
            )
        )
        gate3_config = loaded_gate3_config
        if manifest_hash is None:
            manifest_hash = current_manifest
            loading_summary = current_loading
        elif manifest_hash != current_manifest:
            raise RuntimeError("Gate 3.1 model manifest changed during benchmark")
        elif loading_summary != current_loading:
            raise RuntimeError("Gate 3.1 backbone loading summary changed")
        idle_resident_bytes = max(
            0,
            psutil.Process().memory_info().rss - runtime_baseline_rss,
        )
        for batch_size in batch_sizes:
            for bucketed in bucket_modes:
                for workload_kind in ("full-scenes", "cap-stress"):
                    measurement = _measure_workload(
                        runtime=runtime,
                        config=config,
                        workload=workload,
                        workload_kind=workload_kind,
                        batch_size=batch_size,
                        bucketed=bucketed,
                        thread_count=thread_count,
                        repetitions=repetitions,
                        warmup_count=warmup_count,
                        runtime_baseline_rss=runtime_baseline_rss,
                    )
                    measurement["memory"]["idleResidentBytes"] = (
                        idle_resident_bytes
                    )
                    configurations.append(measurement)
        del runtime
        gc.collect()

    if (
        manifest_hash is None
        or loading_summary is None
        or gate3_config is None
    ):
        raise RuntimeError("Gate 3.1 produced no model identity")
    model = gate3_config.model(model_key)
    decisions = []
    for workload_kind in ("full-scenes", "cap-stress"):
        eligible = [
            item
            for item in configurations
            if item["workload"] == workload_kind
        ]
        best = min(
            eligible,
            key=lambda item: item["phases"]["end_to_end"]["p95Seconds"],
        )
        p95 = best["phases"]["end_to_end"]["p95Seconds"]
        decisions.append(
            {
                "workload": workload_kind,
                "p95Seconds": p95,
                "verdict": _speed_band(p95, config),
                "selectedConfiguration": {
                    "batchSize": best["batchSize"],
                    "threadCount": best["threadCount"],
                    "bucketed": best["bucketed"],
                },
            }
        )
    formal_gate4_eligible = (
        not pilot
        and all(decision["verdict"] == "Target" for decision in decisions)
    )
    timestamp = datetime.now(UTC)
    report = {
        "schemaVersion": 1,
        "runId": (
            f"{timestamp.strftime('%Y%m%dT%H%M%SZ')}-gate31-{model.key}"
        ),
        "createdAt": timestamp.isoformat().replace("+00:00", "Z"),
        "measurementStage": "pilot" if pilot else "final",
        "model": {
            "key": model.key,
            "id": model.model_id,
            "revision": model.revision,
            "weightSha256": model.weight_sha256,
            "manifestSha256": manifest_hash,
            "dtype": model.dtype,
            "loadingSummary": loading_summary,
            "headPolicy": (
                "seed-42-linear(masked-mean(backbone-last-hidden-state))"
            ),
            "tokenizerPairParity": True,
            "qualityClaim": "none; temporary head is for speed only",
        },
        "provenance": {
            "runnerCommit": _git_head(experiment_root),
            "runnerSha256": sha256_file(Path(__file__).resolve()),
            "configSha256": sha256_file(config_path),
            "workloadSha256": config.workload.source_sha256,
            "querySha256": hashlib.sha256(
                canonical_impact_query(workload.diff_payload).encode("utf-8")
            ).hexdigest(),
        },
        "hostProfile": capture_host_profile(
            model_revision=model.revision,
            checkpoint_hash=model.weight_sha256,
            dtype=model.dtype,
        ),
        "contract": {
            "fullSceneCount": config.benchmark.full_scene_count,
            "sceneWindowTokens": config.benchmark.scene_window_tokens,
            "sceneWindowStride": config.benchmark.scene_window_stride,
            "sceneAggregation": "max(window-score)",
            "capStressWindowCount": config.benchmark.cap_stress_window_count,
            "explicitLinkPolicy": (
                workload.selection.explicit_link_policy
            ),
            "thresholdSeconds": {
                "target": config.benchmark.target_seconds,
                "conditional": config.benchmark.conditional_seconds,
                "hold": config.benchmark.hold_seconds,
            },
        },
        "configurations": configurations,
        "decisions": decisions,
        "formalGate4Eligible": formal_gate4_eligible,
    }
    destination = output_path or (
        experiment_root
        / "artifacts"
        / "phase0b"
        / "gate31"
        / f"{report['runId']}.json"
    )
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n",
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
    parser.add_argument("--bucket-modes")
    parser.add_argument("--pilot-repetitions", type=int, default=1)
    return parser


def main() -> int:
    arguments = _build_parser().parse_args()
    bucket_modes: list[bool] | None = None
    if arguments.bucket_modes:
        mapping = {"naive": False, "bucketed": True}
        requested = _csv(arguments.bucket_modes)
        if any(item not in mapping for item in requested):
            raise ValueError("bucket modes must be naive and/or bucketed")
        bucket_modes = [mapping[item] for item in requested]
    try:
        destination = run_impact_gate31(
            arguments.config.resolve(),
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
            pilot=arguments.mode == "pilot",
            pilot_repetitions=arguments.pilot_repetitions,
        )
    except (OSError, RuntimeError, ValueError) as error:
        print(str(error), file=sys.stderr)
        return 2
    print(destination)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
