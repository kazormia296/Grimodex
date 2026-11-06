/**
 * 診断（diagnostic only）専用。分割あり／なしの比較と report の描画（純粋関数）。
 * 閾値は置かない。差の表と、規則（下記）に当てはめた機械的な印だけを出す。判断は人が行う。
 *
 * 規則（case × 指標ごと）: 同じ形の 2 run の差の最大を `withinMax` とし、
 * 分割あり／なしの平均の差の絶対値 `betweenMeanDiff` が `withinMax` 以下なら "within-noise"、
 * 超えたら "exceeds-noise"。run が欠けた（失敗した）形があるときは "incomplete"。
 */

import { differingParts } from "./graphDigest";

export type Shape = "split" | "unsplit";

export interface DispatchRecord {
  readonly stage: string;
  readonly invocationIndex: number;
  /** product が実際に組んだ request の形（roles と segment の有無）。 */
  readonly roles: readonly string[];
  readonly segmentCount: number;
  readonly responseDigest: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly stopReason: string | null;
  readonly attempts: number;
  readonly elapsedMs: number;
}

export interface RunRecord {
  readonly caseId: string;
  readonly suiteId: string;
  readonly shape: Shape;
  readonly run: number;
  readonly status: "ok" | "failed";
  readonly failure?: string;
  /** 失敗した API 呼出し（再送を使い切ったもの）の数。 */
  readonly failedCallCount: number;
  /** product が組んだ request の形が、この run の形（分割あり／なし）と違った呼出しの数。0 が正。 */
  readonly shapeMismatchCount: number;
  readonly metrics?: RunMetrics;
  readonly graphDigest?: string;
  /** graph digest の部分ごとの digest（違う部分の特定用）。 */
  readonly graphDigestParts?: Record<string, string>;
  /** 列挙値の件数分布（actuality・attribution・narrativeFrame・significance・proposalGate）。 */
  readonly enumHistograms?: Record<string, Record<string, number>>;
  readonly dispatches: readonly DispatchRecord[];
}

export const METRIC_KEYS = [
  "observationCount",
  "hypothesisCount",
  "proposalCount",
  "passed",
  "truePositive",
  "falsePositive",
  "falseNegative",
  "criticalViolationCount",
  "parseFailureCount",
  "requiredCovered",
  "actualityMatch",
  "significanceMatch",
  "proposalGateMatch",
  "forbiddenClaimed",
] as const;
export type MetricKey = (typeof METRIC_KEYS)[number];
export type RunMetrics = Record<MetricKey, number>;

export type Verdict = "within-noise" | "exceeds-noise" | "incomplete";

export interface MetricComparison {
  readonly metric: MetricKey;
  readonly values: Record<Shape, readonly (number | null)[]>;
  readonly withinMax: number | null;
  readonly betweenMeanDiff: number | null;
  readonly betweenMaxPairDiff: number | null;
  readonly verdict: Verdict;
}

export interface CaseComparison {
  readonly caseId: string;
  readonly suiteId: string;
  readonly metrics: readonly MetricComparison[];
  readonly graphDigests: Record<Shape, readonly (string | null)[]>;
  /** 4 run すべての graphDigest が一致したか。 */
  readonly graphDigestAllEqual: boolean | null;
  /** 4 run の間で値が一致しない graph digest の部分。 */
  readonly graphDigestDifferingParts: readonly string[];
  /** 分割あり／なしの run 同士（各形の run1 どうし）で一致しない部分。形の間の差の特定用。 */
  readonly graphDigestDifferingPartsBetweenShapes: readonly string[];
  readonly usage: Record<
    Shape,
    {
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
      dispatchCount: number;
    }
  >;
  readonly failedCallCount: number;
  readonly shapeMismatchCount: number;
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function compareMetric(
  metric: MetricKey,
  runs: Record<Shape, readonly RunRecord[]>,
): MetricComparison {
  const pick = (shape: Shape) =>
    runs[shape].map((run) =>
      run.status === "ok" && run.metrics ? run.metrics[metric] : null,
    );
  const values = { split: pick("split"), unsplit: pick("unsplit") };
  const complete = (shape: Shape): number[] | null => {
    const list = values[shape];
    return list.length >= 2 && list.every((v) => v !== null)
      ? (list as number[])
      : null;
  };
  const split = complete("split");
  const unsplit = complete("unsplit");
  if (split === null || unsplit === null) {
    return {
      metric,
      values,
      withinMax: null,
      betweenMeanDiff: null,
      betweenMaxPairDiff: null,
      verdict: "incomplete",
    };
  }
  const range = (list: number[]) => Math.max(...list) - Math.min(...list);
  const withinMax = Math.max(range(split), range(unsplit));
  const betweenMeanDiff = Math.abs(mean(split) - mean(unsplit));
  const betweenMaxPairDiff = Math.max(
    ...split.flatMap((a) => unsplit.map((b) => Math.abs(a - b))),
  );
  return {
    metric,
    values,
    withinMax,
    betweenMeanDiff,
    betweenMaxPairDiff,
    verdict: betweenMeanDiff <= withinMax ? "within-noise" : "exceeds-noise",
  };
}

export function compareCase(
  caseId: string,
  suiteId: string,
  runs: readonly RunRecord[],
): CaseComparison {
  const byShape: Record<Shape, RunRecord[]> = { split: [], unsplit: [] };
  for (const run of runs) byShape[run.shape].push(run);
  for (const shape of ["split", "unsplit"] as const)
    byShape[shape].sort((a, b) => a.run - b.run);
  const digests = (shape: Shape) =>
    byShape[shape].map((run) =>
      run.status === "ok" ? (run.graphDigest ?? null) : null,
    );
  const graphDigests = { split: digests("split"), unsplit: digests("unsplit") };
  const all = [...graphDigests.split, ...graphDigests.unsplit];
  const usageOf = (shape: Shape) => {
    const total = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      dispatchCount: 0,
    };
    for (const run of byShape[shape])
      for (const dispatch of run.dispatches) {
        total.inputTokens += dispatch.inputTokens;
        total.outputTokens += dispatch.outputTokens;
        total.cacheReadTokens += dispatch.cacheReadTokens;
        total.cacheWriteTokens += dispatch.cacheWriteTokens;
        total.dispatchCount += 1;
      }
    return total;
  };
  return {
    caseId,
    suiteId,
    metrics: METRIC_KEYS.map((metric) => compareMetric(metric, byShape)),
    graphDigests,
    graphDigestDifferingParts: differingParts(
      byShape.split
        .concat(byShape.unsplit)
        .flatMap((run) => (run.graphDigestParts ? [run.graphDigestParts] : [])),
    ),
    graphDigestDifferingPartsBetweenShapes: differingParts(
      [byShape.split[0], byShape.unsplit[0]].flatMap((run) =>
        run?.graphDigestParts ? [run.graphDigestParts] : [],
      ),
    ),
    graphDigestAllEqual: all.some((d) => d === null)
      ? null
      : all.every((d) => d === all[0]),
    usage: { split: usageOf("split"), unsplit: usageOf("unsplit") },
    failedCallCount: runs.reduce((sum, run) => sum + run.failedCallCount, 0),
    shapeMismatchCount: runs.reduce(
      (sum, run) => sum + run.shapeMismatchCount,
      0,
    ),
  };
}

const short = (digest: string | null) =>
  digest === null ? "-" : digest.replace(/^sha256:/u, "").slice(0, 10);
const cell = (list: readonly (number | null)[]) =>
  list.map((v) => (v === null ? "x" : String(v))).join("/");

/** Markdown の表。本文・題名・応答の本文は入れない（件数・digest・score だけ）。 */
export function renderMarkdown(report: {
  readonly runId: string;
  readonly model: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly cases: readonly CaseComparison[];
  readonly runs: readonly RunRecord[];
}): string {
  const lines: string[] = [];
  lines.push(`# Chronicle prompt cache 診断（diagnostic only）`);
  lines.push("");
  lines.push(
    `certification には関わらない。閾値なし。runId=${report.runId} model=${report.model}`,
  );
  lines.push("");
  lines.push(
    `各セルは run1/run2。x は失敗した run。verdict は 分割あり／なしの平均差 <= 同じ形の run 間の差の最大 のとき within-noise。`,
  );
  for (const entry of report.cases) {
    lines.push("");
    lines.push(`## ${entry.caseId} (${entry.suiteId})`);
    lines.push("");
    lines.push(
      "| 指標 | 分割あり | 分割なし | run 間の差の最大 | 平均差 | 全 pair の最大差 | verdict |",
    );
    lines.push("|---|---|---|---|---|---|---|");
    for (const m of entry.metrics) {
      lines.push(
        `| ${m.metric} | ${cell(m.values.split)} | ${cell(m.values.unsplit)} | ${m.withinMax ?? "-"} | ${m.betweenMeanDiff ?? "-"} | ${m.betweenMaxPairDiff ?? "-"} | ${m.verdict} |`,
      );
    }
    lines.push("");
    lines.push(
      `graph digest（観測の意味 field の正規化。run1/run2）: 分割あり ${entry.graphDigests.split.map(short).join("/")}、分割なし ${entry.graphDigests.unsplit.map(short).join("/")}、4 run 全一致 ${entry.graphDigestAllEqual === null ? "不明" : entry.graphDigestAllEqual ? "はい" : "いいえ"}。` +
        `4 run で違う部分: ${entry.graphDigestDifferingParts.join(", ") || "なし"}、形の間（run1 どうし）で違う部分: ${entry.graphDigestDifferingPartsBetweenShapes.join(", ") || "なし"}`,
    );
    lines.push("");
    lines.push("| 形 | 呼出し | input | output | cache_read | cache_write |");
    lines.push("|---|---|---|---|---|---|");
    for (const shape of ["split", "unsplit"] as const) {
      const u = entry.usage[shape];
      lines.push(
        `| ${shape === "split" ? "分割あり" : "分割なし"} | ${u.dispatchCount} | ${u.inputTokens} | ${u.outputTokens} | ${u.cacheReadTokens} | ${u.cacheWriteTokens} |`,
      );
    }
    lines.push("");
    lines.push(
      `失敗した呼出し: ${entry.failedCallCount} 件、request の形が run の形と違った呼出し: ${entry.shapeMismatchCount} 件（0 が正）`,
    );
  }
  const failedRuns = report.runs.filter((run) => run.status === "failed");
  lines.push("");
  lines.push(`## 失敗した run: ${failedRuns.length} 件`);
  for (const run of failedRuns)
    lines.push(
      `- ${run.caseId} ${run.shape} run${run.run}: ${run.failure ?? "unknown"}（失敗した呼出し ${run.failedCallCount}）`,
    );
  return `${lines.join("\n")}\n`;
}
