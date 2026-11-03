// 融合の枠の評価（段階 1）：raw-fullness.mjs の記録から Raw の件数の分布と満杯率を集計する。
//
//   node scripts/quality/fusion-slot-eval/analyze.mjs --records <records.json>[,<records.json>…] --output <repo の外の file>
//
// 指標：Raw の件数（0〜8）の分布、満杯（8 件）の割合、≤6・≤5 の割合（Wilson の 95％ 区間）。
// 全体・作品ごと・地点ごと・言語ごと・作品×地点ごとに出す。失敗した query は除かずに
// 件数を別に出し、割合の分母には入れない。判断規則は事前登録のとおり：
// D0（分母の query が 200 未満）は「判断不能」。D1（入力が無い）と κ の下限は段階 1 の
// Raw の測定には当たらない。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { assertOutsideRepo } from "./pd-corpus.mjs";

export const EVIDENCE_SCOPE = "not-cp4-evidence";
export const D0_MIN_QUERIES = 200;
export const RAW_MAX = 8;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Wilson の 95％ 区間（z = 1.96）。n = 0 は null。 */
export function wilson(successes, n, z = 1.96) {
  if (n === 0) return null;
  const p = successes / n;
  const denominator = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denominator;
  const half =
    (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denominator;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

function rate(successes, n) {
  return {
    count: successes,
    n,
    rate: n ? successes / n : null,
    wilson95: wilson(successes, n),
  };
}

export function summarize(queries) {
  const ok = queries.filter(
    (q) => q.status === "ok" && Number.isInteger(q.rawCount),
  );
  const distribution = Array.from({ length: RAW_MAX + 1 }, () => 0);
  for (const q of ok) distribution[q.rawCount]++;
  const withTop30 = ok.filter((q) => q.top30);
  const mean = (values) =>
    values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
  return {
    queries: queries.length,
    ok: ok.length,
    failed: queries.length - ok.length,
    unstableRepeat: ok.filter((q) => q.repeatStable === false).length,
    distribution,
    full8: rate(ok.filter((q) => q.rawCount === RAW_MAX).length, ok.length),
    atMost6: rate(ok.filter((q) => q.rawCount <= 6).length, ok.length),
    atMost5: rate(ok.filter((q) => q.rawCount <= 5).length, ok.length),
    meanRawCount: mean(ok.map((q) => q.rawCount)),
    top30: {
      method: "re-query",
      queries: withTop30.length,
      meanLaterScene: mean(withTop30.map((q) => q.top30.laterScene)),
      meanSameScene: mean(withTop30.map((q) => q.top30.sameScene)),
      meanEarlierDistinctScenes: mean(
        withTop30.map((q) => q.top30.earlierDistinctScenes),
      ),
      withAnyLaterScene: withTop30.filter((q) => q.top30.laterScene > 0).length,
    },
  };
}

function groupBy(queries, keyOf) {
  const groups = new Map();
  for (const q of queries) {
    const key = keyOf(q);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(q);
  }
  return Object.fromEntries(
    [...groups.entries()]
      .sort(([a], [b]) => String(a).localeCompare(String(b)))
      .map(([key, items]) => [key, summarize(items)]),
  );
}

export function analyze(runs) {
  const queries = [];
  for (const run of runs) {
    assert.equal(run.evidenceScope, EVIDENCE_SCOPE);
    assert.equal(run.schemaVersion, "fusion-slot-raw-fullness/1");
    for (const checkpoint of run.checkpoints)
      for (const q of checkpoint.queries) {
        assert.equal(q.evidenceScope, EVIDENCE_SCOPE);
        queries.push({ ...q, language: run.language, role: run.role });
      }
  }
  const overall = summarize(queries);
  return {
    schemaVersion: "fusion-slot-raw-fullness-summary/1",
    evidenceScope: EVIDENCE_SCOPE,
    runs: runs.map((run) => ({
      runId: run.runId,
      status: run.status,
      role: run.role,
      opaqueWorkId: run.opaqueWorkId,
      language: run.language,
      sceneCount: run.sceneCount,
      errors: run.errors.length,
    })),
    roles: [...new Set(runs.map((run) => run.role))],
    overall,
    byWork: groupBy(queries, (q) => q.opaqueWorkId),
    byCheckpoint: groupBy(queries, (q) => q.checkpoint),
    byLanguage: groupBy(queries, (q) => q.language),
    byWorkCheckpoint: groupBy(
      queries,
      (q) => `${q.opaqueWorkId}@${q.checkpoint}`,
    ),
    decision: {
      D0: {
        rule: `分母（成功した query）が ${D0_MIN_QUERIES} 未満なら判断不能`,
        denominator: overall.ok,
        undecidable: overall.ok < D0_MIN_QUERIES,
      },
      D1: "段階 1 の Raw の測定には当たらない（入力の有無を問う規則は IR・Graph 向け）",
      kappa: "段階 1 の Raw の測定には当たらない（ラベルを付けない）",
      use: "枠を変えない判断にだけ使う。作品の性質の範囲で、作者の実利用の分布ではない",
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  const options = {};
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 2)
    options[args[i].slice(2)] = args[i + 1];
  assert.ok(options.records && options.output, "--records と --output が要る");
  assertOutsideRepo(options.output);
  const runs = [];
  const inputs = [];
  for (const file of options.records.split(",")) {
    const bytes = await readFile(file);
    inputs.push({ file, sha256: sha256(bytes) });
    runs.push(JSON.parse(bytes.toString("utf8")));
  }
  const summary = analyze(runs);
  summary.inputs = inputs;
  summary.analysisScriptSha256 = sha256(await readFile(import.meta.filename));
  summary.generatedAt = new Date().toISOString();
  await writeFile(options.output, JSON.stringify(summary, null, 2) + "\n");
  process.stdout.write(
    `集計：query ${summary.overall.queries}（成功 ${summary.overall.ok}）、満杯 ${summary.overall.full8.count}、D0 判断不能=${summary.decision.D0.undecidable}\n`,
  );
}
