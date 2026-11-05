// 第 5 版の集計の補助（読むだけ）。harness と同じ summarizeQueries で、作品ごと・地点ごと・層別・tail10 と、
// 3 作品をまとめた参考値（D0・D1 の判定用）を出す。抽出の失敗は errorShape ごとに数える。
// 使い方：node agg-v5.mjs <ir-classify.mjs の絶対 path> <key>=<records.json> ...
import fs from "node:fs";
import { pathToFileURL } from "node:url";

const [classifyPath, ...pairs] = process.argv.slice(2);
const { summarizeQueries } = await import(pathToFileURL(classifyPath).href);

const BUCKETS = ["lt8", "8to30", "gt30"];
const brief = (s) => ({
  queries: s.queries,
  samples: s.samples,
  categories: s.categories,
  unused: s.slotUnusedReasons,
  slotUse: `${s.slotUseRate.numerator}/${s.slotUseRate.denominator}`,
  slotUseValue: s.slotUseRate.value,
  irUnavailable: `${s.irUnavailableRate.numerator}/${s.irUnavailableRate.denominator}`,
  rawFullWithIr: `${s.rawFullWithIrCandidate.numerator}/${s.rawFullWithIrCandidate.denominator}`,
  rawFullWithIrValue: s.rawFullWithIrCandidate.value,
  timeoutCounterfactual: `${s.timeoutCounterfactual.numerator}/${s.timeoutCounterfactual.denominator}`,
});
const shapeKey = (shape) => {
  if (!shape) return "(なし)";
  if (shape.includes("SNAPSHOT_SOURCE_CHANGED")) return "Snapshot build failed: SNAPSHOT_SOURCE_CHANGED";
  if (shape.startsWith("Snapshot build failed")) return "Snapshot build failed: <long>";
  if (shape.startsWith("Failed query")) return "Failed query（listEvents）";
  return shape.slice(0, 60);
};

const out = { works: {}, pooled: null, checks: {} };
const pooledQueries = [];
for (const pair of pairs) {
  const [key, file] = pair.split("=");
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  const cps = d.checkpoints.filter((c) => (c.queries ?? []).length > 0);
  const all = cps.flatMap((c) => c.queries);
  pooledQueries.push(...all);
  const summary = summarizeQueries(all);
  if (d.summary) {
    out.checks[key] = JSON.stringify(d.summary) === JSON.stringify(summary)
      ? "harness の summary と一致" : "harness の summary と不一致";
  }
  const failures = {};
  for (const e of d.extraction ?? []) {
    if (e.status === "completed") continue;
    const k = shapeKey(e.errorShape);
    (failures[k] ??= []).push(e.position);
  }
  out.works[key] = {
    status: d.status,
    sceneCount: d.sceneCount,
    extraction: { attempted: (d.extraction ?? []).length,
      completed: (d.extraction ?? []).filter((e) => e.status === "completed").length,
      failuresByShape: failures },
    checkpoints: cps.map((c) => ({ fraction: c.fraction, sceneCount: c.sceneCount, ...brief(summarizeQueries(c.queries)),
      irWaitMs: Math.round(c.irWait?.durationMs ?? NaN) })),
    total: brief(summary),
    byPriorScenes: Object.fromEntries(BUCKETS.map((b) => [b, brief(summarizeQueries(all.filter((q) => q.priorScenesBucket === b)))])),
    tail10: brief(summarizeQueries(all.filter((q) => q.tail10))),
    checkpointConstruction: d.checkpointConstruction ?? null,
  };
}
const pooled = summarizeQueries(pooledQueries);
out.pooled = {
  ...brief(pooled),
  byPriorScenes: Object.fromEntries(BUCKETS.map((b) => [b, brief(summarizeQueries(pooledQueries.filter((q) => q.priorScenesBucket === b)))])),
  tail10: brief(summarizeQueries(pooledQueries.filter((q) => q.tail10))),
  D0: { irReadyRawLt8: pooled.slotUseRate.denominator, threshold: 200, decidable: pooled.slotUseRate.denominator >= 200 },
  D1: (() => { const bad = pooled.categories["ir-not-built"] + pooled.categories.fault;
    return { notBuiltPlusFault: bad, samples: pooled.samples, rate: bad / pooled.samples, withinLimit: bad / pooled.samples <= 0.05 }; })(),
};
console.log(JSON.stringify(out, null, 1));
