#!/usr/bin/env python3
"""Compare local Ollama latency with and without the selected reranker load."""

from __future__ import annotations

import argparse
from datetime import UTC, datetime
import json
import os
from pathlib import Path
import statistics
import subprocess
import sys
import tempfile
import time
from typing import Any
from urllib import parse, request


def _local_endpoint(value: str) -> str:
    parsed = parse.urlparse(value)
    if (
        parsed.scheme != "http"
        or parsed.hostname not in {"127.0.0.1", "localhost", "::1"}
        or parsed.username is not None
        or parsed.password is not None
    ):
        raise argparse.ArgumentTypeError(
            "endpoint must be an unauthenticated local HTTP URL"
        )
    return value.rstrip("/")


def _generate(endpoint: str, model: str, timeout_seconds: float) -> dict[str, float]:
    body = json.dumps(
        {
            "model": model,
            "prompt": "Reply with exactly OK.",
            "stream": False,
            "think": False,
            "keep_alive": "5m",
            "options": {
                "temperature": 0,
                "num_predict": 1,
            },
        }
    ).encode("utf-8")
    http_request = request.Request(
        f"{endpoint}/api/generate",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    started = time.perf_counter()
    with request.urlopen(http_request, timeout=timeout_seconds) as response:
        payload = json.loads(response.read().decode("utf-8"))
    wall_seconds = time.perf_counter() - started
    if payload.get("done") is not True:
        raise RuntimeError("local LLM response did not complete")
    return {
        "wallSeconds": wall_seconds,
        "serverTotalSeconds": float(payload.get("total_duration", 0)) / 1e9,
        "promptEvalSeconds": float(payload.get("prompt_eval_duration", 0)) / 1e9,
        "evalSeconds": float(payload.get("eval_duration", 0)) / 1e9,
    }


def _summary(samples: list[dict[str, float]]) -> dict[str, int | float]:
    walls = [sample["wallSeconds"] for sample in samples]
    return {
        "sampleCount": len(walls),
        "wallMedianSeconds": statistics.median(walls),
        "wallMaximumSeconds": max(walls),
    }


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--endpoint", type=_local_endpoint, required=True)
    parser.add_argument("--local-model", required=True)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--candidates", type=Path, required=True)
    parser.add_argument("--chunk-qrels", type=Path, required=True)
    parser.add_argument("--reranker-model", required=True)
    parser.add_argument("--threads", type=int, required=True)
    parser.add_argument("--batch-size", type=int, default=4)
    parser.add_argument("--samples", type=int, default=3)
    parser.add_argument("--settle-seconds", type=float, default=2.0)
    parser.add_argument("--timeout-seconds", type=float, default=120.0)
    parser.add_argument("--output", type=Path, required=True)
    return parser


def main() -> int:
    arguments = _parser().parse_args()
    if arguments.samples <= 0:
        raise ValueError("samples must be positive")
    if arguments.threads <= 0 or arguments.batch_size <= 0:
        raise ValueError("threads and batch size must be positive")

    _generate(
        arguments.endpoint,
        arguments.local_model,
        arguments.timeout_seconds,
    )
    baseline = [
        _generate(
            arguments.endpoint,
            arguments.local_model,
            arguments.timeout_seconds,
        )
        for _ in range(arguments.samples)
    ]

    with tempfile.TemporaryDirectory(prefix="grimodex-reranker-contention-") as temp:
        reranker_output = Path(temp) / "gate2.json"
        command = [
            sys.executable,
            "-m",
            "grimodex_lfm_eval.reranker_gate2_runner",
            "--config",
            str(arguments.config),
            "--candidates",
            str(arguments.candidates),
            "--chunk-qrels",
            str(arguments.chunk_qrels),
            "--model",
            arguments.reranker_model,
            "--threads",
            str(arguments.threads),
            "--batch-size",
            str(arguments.batch_size),
            "--output",
            str(reranker_output),
        ]
        environment = {
            **os.environ,
            "HF_HUB_OFFLINE": "1",
            "TRANSFORMERS_OFFLINE": "1",
        }
        child = subprocess.Popen(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=environment,
        )
        time.sleep(arguments.settle_seconds)
        contended: list[dict[str, float]] = []
        for _ in range(arguments.samples):
            if child.poll() is not None:
                stdout, stderr = child.communicate()
                raise RuntimeError(
                    "reranker load ended before contention samples: "
                    f"exit={child.returncode} stdout={stdout!r} stderr={stderr!r}"
                )
            contended.append(
                _generate(
                    arguments.endpoint,
                    arguments.local_model,
                    arguments.timeout_seconds,
                )
            )
        stdout, stderr = child.communicate(timeout=300)
        if child.returncode != 0:
            raise RuntimeError(
                "reranker load failed: "
                f"exit={child.returncode} stdout={stdout!r} stderr={stderr!r}"
            )

    baseline_summary = _summary(baseline)
    contention_summary = _summary(contended)
    baseline_median = baseline_summary["wallMedianSeconds"]
    report: dict[str, Any] = {
        "schemaVersion": 1,
        "createdAt": datetime.now(UTC).isoformat(),
        "localModel": arguments.local_model,
        "rerankerModel": arguments.reranker_model,
        "rerankerThreads": arguments.threads,
        "rerankerBatchSize": arguments.batch_size,
        "baseline": {
            "summary": baseline_summary,
            "samples": baseline,
        },
        "underRerankerLoad": {
            "summary": contention_summary,
            "samples": contended,
        },
        "delta": {
            "wallMedianSeconds": (
                contention_summary["wallMedianSeconds"] - baseline_median
            ),
            "wallMedianRatio": (
                contention_summary["wallMedianSeconds"] / baseline_median
                if baseline_median > 0
                else None
            ),
        },
        "role": "diagnostic-only",
    }
    arguments.output.parent.mkdir(parents=True, exist_ok=True)
    arguments.output.write_text(
        json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(report["delta"], sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
