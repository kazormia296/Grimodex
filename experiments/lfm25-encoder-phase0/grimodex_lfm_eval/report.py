"""Render an early-gate JSON artifact as a compact Markdown decision report."""

from __future__ import annotations

import argparse
from pathlib import Path

from .performance_schema import PerformanceReport


def render_performance_report(report: PerformanceReport) -> str:
    lines = [
        "# LFM2.5 Encoder Phase 0 — C0.5 Early Gate",
        "",
        f"- Run: `{report.run_id}`",
        f"- Model revision: `{report.model_revision}`",
        f"- Manifest SHA-256: `{report.manifest_hash}`",
        f"- Dtype: `{report.dtype}`",
        "",
        "## Decisions",
        "",
        "| Workload | Candidates | warm/cold p95 | Verdict | Selected setup |",
        "|---|---:|---:|---|---|",
    ]
    for decision in report.decisions:
        lines.append(
            f"| {decision.workload} | {decision.candidate_count} | "
            f"{decision.p95_seconds:.3f}s | {decision.verdict} | "
            f"{decision.reason} |"
        )
    lines.extend(
        [
            "",
            "This report is a feasibility gate only. It does not authorize product "
            "candidate removal or Phase 1 integration.",
            "",
        ]
    )
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--performance-run", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    arguments = parser.parse_args()
    report = PerformanceReport.model_validate_json(
        arguments.performance_run.read_text(encoding="utf-8")
    )
    arguments.output.parent.mkdir(parents=True, exist_ok=True)
    arguments.output.write_text(
        render_performance_report(report),
        encoding="utf-8",
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
