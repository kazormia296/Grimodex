"""Run fixed-candidate Gate 2 quality and real-corpus latency evaluation."""

from __future__ import annotations

import argparse
from dataclasses import asdict
from datetime import UTC, datetime
import json
from pathlib import Path
import sys
import time
from typing import Any, Literal, Sequence

import psutil

from .benchmark import (
    batched_predict,
    classify_speed_gate,
    summarize_timing_samples,
)
from .performance_schema import Workload
from .reranker_gate2 import (
    Gate2Query,
    compare_candidate_depths,
    compare_to_hybrid,
    evaluate_method,
    load_gate2_jsonl,
)
from .reranker_phase0b import (
    OnnxRerankerRuntime,
    load_onnx_reranker,
    load_phase0b_config,
)


def _score_query(
    runtime: OnnxRerankerRuntime,
    query: Gate2Query,
    *,
    batch_size: int,
    candidate_limit: Literal[12, 30],
) -> dict[str, float]:
    candidates = [
        candidate
        for candidate in query.candidates
        if candidate.rrf_rank <= candidate_limit
    ]

    def predict(batch: list[Any]) -> list[float]:
        return runtime.score_pairs(
            query.query,
            [candidate.chunk_text for candidate in batch],
        )

    scores = batched_predict(
        candidates,
        batch_size=batch_size,
        predict_batch=predict,
        bucket_by_length=True,
        length_key=lambda candidate: len(candidate.chunk_text),
    )
    return {
        candidate.candidate_id: score
        for candidate, score in zip(candidates, scores, strict=True)
    }


def _measure_real_corpus_latency(
    runtime: OnnxRerankerRuntime,
    queries: Sequence[Gate2Query],
    *,
    batch_size: int,
    candidate_limit: Literal[12, 30],
    warmup_count: int,
    repetitions: int,
    bootstrap_iterations: int,
) -> dict[str, Any]:
    samples: list[float] = []
    process = psutil.Process()
    idle_rss = process.memory_info().rss
    peak_rss = idle_rss
    attention_tokens: list[int] = []
    padded_tokens: list[int] = []
    for run_index in range(warmup_count + repetitions):
        query = queries[run_index % len(queries)]
        started = time.perf_counter()
        _score_query(
            runtime,
            query,
            batch_size=batch_size,
            candidate_limit=candidate_limit,
        )
        elapsed = time.perf_counter() - started
        peak_rss = max(peak_rss, process.memory_info().rss)
        if run_index >= warmup_count:
            samples.append(elapsed)
            attention_tokens.append(runtime.last_attention_tokens)
            padded_tokens.append(runtime.last_padded_tokens)
    timing = summarize_timing_samples(
        samples,
        warmup_count=0,
        minimum_samples=30,
        bootstrap_iterations=bootstrap_iterations,
    )
    verdict = classify_speed_gate(
        Workload.RELEVANCE,
        candidate_count=candidate_limit,
        p95_seconds=timing.p95_seconds,
    )
    return {
        "candidateCount": candidate_limit,
        "batchSize": batch_size,
        "bucketed": True,
        "warmupCount": warmup_count,
        "sampleCount": repetitions,
        "timing": timing.model_dump(by_alias=True),
        "speedVerdict": verdict.value,
        "idleResidentBytes": idle_rss,
        "peakResidentBytes": peak_rss,
        "attentionTokensPerFinalBatch": attention_tokens,
        "paddedTokensPerFinalBatch": padded_tokens,
    }


def _hard_negative_slice(
    baseline: Any,
    candidate: Any,
) -> dict[str, Any]:
    baseline_by_id = {query.query_id: query for query in baseline.queries}
    candidate_by_id = {query.query_id: query for query in candidate.queries}
    ids = [
        query_id
        for query_id, result in baseline_by_id.items()
        if not result.is_no_match and result.scene_recall_at_1 == 0.0
    ]
    return {
        "queryCount": len(ids),
        "queryIds": ids,
        "baselineMrr": (
            sum(baseline_by_id[query_id].scene_reciprocal_rank for query_id in ids)
            / len(ids)
            if ids
            else 0.0
        ),
        "rerankerMrr": (
            sum(candidate_by_id[query_id].scene_reciprocal_rank for query_id in ids)
            / len(ids)
            if ids
            else 0.0
        ),
        "improvedAt1": sum(
            candidate_by_id[query_id].scene_recall_at_1
            > baseline_by_id[query_id].scene_recall_at_1
            for query_id in ids
        ),
        "worsenedAt1": sum(
            candidate_by_id[query_id].scene_recall_at_1
            < baseline_by_id[query_id].scene_recall_at_1
            for query_id in ids
        ),
    }


def _quality_payload(
    queries: Sequence[Gate2Query],
    scores_by_query: dict[str, dict[str, float]],
    *,
    candidate_limit: Literal[12, 30],
    bootstrap_iterations: int,
) -> dict[str, Any]:
    dense = evaluate_method(
        queries,
        method="dense",
        candidate_limit=candidate_limit,
    )
    rrf = evaluate_method(
        queries,
        method="rrf",
        candidate_limit=candidate_limit,
    )
    reranker = evaluate_method(
        queries,
        method="reranker",
        scores_by_query=scores_by_query,
        candidate_limit=candidate_limit,
    )
    comparison = compare_to_hybrid(
        rrf,
        reranker,
        bootstrap_iterations=bootstrap_iterations,
    )
    product_safety = {
        "goldSceneInclusionDelta": (
            reranker.injection.gold_scene_inclusion
            - rrf.injection.gold_scene_inclusion
        ),
        "junkInjectionRateDelta": (
            reranker.injection.junk_injection_rate
            - rrf.injection.junk_injection_rate
        ),
        "noMatchInjectionRateDelta": (
            reranker.injection.no_match_injection_rate
            - rrf.injection.no_match_injection_rate
        ),
    }
    product_safety["passed"] = (
        product_safety["goldSceneInclusionDelta"] >= -1e-12
        and product_safety["junkInjectionRateDelta"] <= 1e-12
        and product_safety["noMatchInjectionRateDelta"] <= 1e-12
    )
    return {
        "candidateCount": candidate_limit,
        "dense": asdict(dense),
        "hybridRrf": asdict(rrf),
        "reranker": asdict(reranker),
        "comparisonToHybrid": asdict(comparison),
        "productSafety": product_safety,
        "baselineHardNegativeSlice": _hard_negative_slice(rrf, reranker),
    }


def run_gate2(
    *,
    config_path: Path,
    candidate_path: Path,
    model_key: str,
    thread_count: int,
    batch_size: int,
) -> dict[str, Any]:
    config = load_phase0b_config(config_path)
    model = config.model(model_key)
    all_queries = load_gate2_jsonl(candidate_path)
    queries = [query for query in all_queries if query.language == model.language]
    if not queries:
        raise ValueError(
            f"{candidate_path} contains no {model.language} Gate 2 queries"
        )
    runtime, manifest_hash = load_onnx_reranker(
        config_path,
        config,
        model,
        thread_count=thread_count,
    )
    scores_30 = {
        query.query_id: _score_query(
            runtime,
            query,
            batch_size=batch_size,
            candidate_limit=30,
        )
        for query in queries
    }
    quality_30 = _quality_payload(
        queries,
        scores_30,
        candidate_limit=30,
        bootstrap_iterations=config.benchmark.bootstrap_iterations,
    )
    latencies = [
        _measure_real_corpus_latency(
            runtime,
            queries,
            batch_size=batch_size,
            candidate_limit=30,
            warmup_count=config.benchmark.warmup_count,
            repetitions=config.benchmark.repetitions,
            bootstrap_iterations=config.benchmark.bootstrap_iterations,
        )
    ]
    quality: dict[str, Any] = {"top30": quality_30}
    depth_payload: dict[str, Any] | None = None
    if model.key == "ja_xsmall":
        scores_12 = {
            query_id: {
                candidate_id: score
                for candidate_id, score in scores.items()
                if next(
                    candidate
                    for candidate in next(
                        query for query in queries if query.query_id == query_id
                    ).candidates
                    if candidate.candidate_id == candidate_id
                ).rrf_rank
                <= 12
            }
            for query_id, scores in scores_30.items()
        }
        quality["top12"] = _quality_payload(
            queries,
            scores_12,
            candidate_limit=12,
            bootstrap_iterations=config.benchmark.bootstrap_iterations,
        )
        depth = compare_candidate_depths(
            queries,
            scores_by_query=scores_30,
        )
        depth_payload = asdict(depth)
        latencies.insert(
            0,
            _measure_real_corpus_latency(
                runtime,
                queries,
                batch_size=batch_size,
                candidate_limit=12,
                warmup_count=config.benchmark.warmup_count,
                repetitions=config.benchmark.repetitions,
                bootstrap_iterations=config.benchmark.bootstrap_iterations,
            ),
        )

    promoted_depths = [
        name
        for name, payload in quality.items()
        if payload["comparisonToHybrid"]["promote"]
        and payload["productSafety"]["passed"]
    ]
    acceptable_latency_depths = [
        f"top{measurement['candidateCount']}"
        for measurement in latencies
        if measurement["speedVerdict"] in {"target", "conditional"}
    ]
    if not promoted_depths:
        overall = "Reject"
    elif any(depth in acceptable_latency_depths for depth in promoted_depths):
        overall = "Promote"
    else:
        overall = "Hold"
    return {
        "schemaVersion": 1,
        "createdAt": datetime.now(UTC).isoformat(),
        "modelKey": model.key,
        "modelId": model.model_id,
        "modelRevision": model.revision,
        "artifact": model.artifact,
        "artifactSha256": model.artifact_sha256,
        "manifestHash": manifest_hash,
        "candidateFile": str(candidate_path),
        "queryCount": len(queries),
        "positiveQueryCount": sum(
            bool(query.expected_scene_titles) for query in queries
        ),
        "noMatchQueryCount": sum(
            not query.expected_scene_titles for query in queries
        ),
        "runtime": {
            "threadCount": thread_count,
            "batchSize": batch_size,
            "bucketed": True,
            "maxPairTokens": config.benchmark.max_pair_tokens,
        },
        "quality": quality,
        "candidateDepthComparison": depth_payload,
        "realCorpusLatency": latencies,
        "decision": {
            "promotedDepths": promoted_depths,
            "acceptableLatencyDepths": acceptable_latency_depths,
            "overall": overall,
            "impactReview": "not-evaluated",
        },
        "scoresByQuery": scores_30,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--candidates", type=Path, required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--threads", type=int, required=True)
    parser.add_argument("--batch-size", type=int, default=4)
    parser.add_argument("--output", type=Path, required=True)
    arguments = parser.parse_args()
    try:
        report = run_gate2(
            config_path=arguments.config.resolve(),
            candidate_path=arguments.candidates.resolve(),
            model_key=arguments.model,
            thread_count=arguments.threads,
            batch_size=arguments.batch_size,
        )
    except (OSError, ValueError) as error:
        print(str(error), file=sys.stderr)
        return 2
    arguments.output.parent.mkdir(parents=True, exist_ok=True)
    arguments.output.write_text(
        json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(report["decision"], ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
