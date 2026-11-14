// 集計の試験（合成の cell・rows。実在の原稿・名簿は使わない）。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FORBIDDEN_KEY,
  assertRecordsClean,
  buildMeasureA,
  buildMeasureB1,
  buildMeasureB2,
  buildRecords,
  buildStarMapping,
  findForbiddenKeys,
  flattenRunA,
  rangeOf,
  renderRecordsMarkdown,
} from "./aggregate.mjs";
import { buildRosterIndex, computeMeasureA } from "./measure-a-metrics.mjs";

const ident = async (s) => s;
const roster = {
  entities: [
    {
      id: "e1",
      type: "character",
      name: "alpha",
      aliases: [{ surface: "al", level: "L2" }],
    },
    { id: "e2", type: "location", name: "beta", aliases: [] },
  ],
};
const mkRow = (keyHash, bindingKind, extra = {}) => ({
  keyHash,
  bindingKind,
  scenes: [[1, 1]],
  coarseClass: "person",
  bindExistingEntityId: null,
  candidates: [],
  typeStatus: "resolved",
  status: "unreviewed",
  bulkApprovable: false,
  ...extra,
});

async function run(label, rows, sceneCount) {
  const index = await buildRosterIndex(roster, ident);
  return {
    label,
    completed: true,
    extract: { sceneCount, entryCountInCatalog: 2 },
    metrics: computeMeasureA({ index, rows }),
    rows,
  };
}

async function fixtureCells(work) {
  const cell = async (id, kind, level, runs) => ({
    cell: `${work}-${id}`,
    work,
    kind,
    level,
    status: "ok",
    runs: runs.map(({ rows: _rows, ...rest }) => rest),
    _rows: runs.map((r) => ({ label: r.label, rows: r.rows })),
  });
  const base = [
    mkRow("al", "create-new", { bulkApprovable: true }),
    mkRow("zzz", "create-new"),
  ];
  const cells = [
    await cell("matrix-L2", "matrix", "L2", [await run("F100", base, 60)]),
    await cell("matrix-L0", "matrix", "L0", [await run("F100", base, 60)]),
    await cell("empty", "baseline", null, [await run("F100", base, 60)]),
    await cell("determinism-L2", "determinism", "L2", [
      await run("F100", base, 60),
    ]),
    await cell("cumulative-L2", "cumulative", "L2", [
      await run("F25", [mkRow("al", "create-new")], 15),
      await run(
        "F50",
        [mkRow("al", "create-new"), mkRow("zzz", "create-new")],
        30,
      ),
      await run("F75", base, 45),
      await run("F100", base, 60),
    ]),
    await cell("solo-L2-F25", "solo", "L2", [
      await run("F25", [mkRow("al", "create-new")], 15),
    ]),
  ];
  const rowsByCell = Object.fromEntries(cells.map((c) => [c.cell, c._rows]));
  return { cells: cells.map(({ _rows, ...c }) => c), rowsByCell };
}

test("rangeOf：最小〜最大（平均しない）", () => {
  assert.deepEqual(rangeOf([3, 1, 2]), { n: 3, min: 1, max: 3 });
  assert.deepEqual(rangeOf([]), { n: 0, min: null, max: null });
  assert.deepEqual(rangeOf([null, 4]), { n: 1, min: 4, max: 4 });
});

test("flattenRunA：列は件数だけ", async () => {
  const r = await run(
    "F100",
    [mkRow("al", "create-new", { bulkApprovable: true })],
    60,
  );
  const flat = flattenRunA(r);
  assert.equal(flat.sceneCount, 60);
  assert.equal(flat.bulk, 1);
  assert.ok(Object.values(flat).every((v) => v === null || Number.isFinite(v)));
  // 関係の呼び名の枠（この合成の名簿には無いので 0）。
  assert.equal(flat.relational, 0);
  assert.equal(flat.relationalCreateNew, 0);
});

test("buildMeasureA：作品ごとの表・一致の検査・累積の参考値・作品間の範囲", async () => {
  const a = await fixtureCells("w1");
  const b = await fixtureCells("w2");
  const m = buildMeasureA({
    cells: [...a.cells, ...b.cells],
    rowsByCell: { ...a.rowsByCell, ...b.rowsByCell },
  });
  assert.deepEqual(Object.keys(m.byWork), ["w1", "w2"]);
  const w = m.byWork.w1;
  assert.equal(w.matrix.L2.sceneCount, 60);
  assert.ok(w.matrix.empty && w.matrix.L0);
  assert.deepEqual(
    w.cumulative.map((r) => [r.label, r.sceneCount]),
    [
      ["F25", 15],
      ["F50", 30],
      ["F75", 45],
      ["F100", 60],
    ],
  );
  // 決定性・累積の最後・単独との一致（表記×種類の集合）。
  assert.equal(w.checks.determinismVsMatrixL2.equal, true);
  assert.equal(w.checks.cumulativeLastVsMatrixL2.equal, true);
  assert.equal(w.checks.cumulativeVsSolo.F25.equal, true);
  assert.equal(w.carryOver.runCount, 4);
  assert.equal(w.carryOver.note, "seed-stability-not-reauthoring");
  // 範囲：2 作品の同じ値。
  assert.deepEqual(m.ranges.L2.proposals, { n: 2, min: 2, max: 2 });
  assert.ok(!("average" in m.ranges.L2.proposals));
});

test("B1・B2 の表：3 回の範囲・判断不能・停止・B2 の合計", () => {
  const metrics = (n) => ({
    aliasButtons: n,
    aliasMatchRoster: n,
    candidateCount: 10,
  });
  const req = (ok, n, tin) => ({
    ok,
    retried: false,
    usage: ok ? { input_tokens: tin, output_tokens: 100 } : null,
    metrics: ok ? metrics(n) : null,
  });
  const b1 = buildMeasureB1([
    {
      work: "w1",
      level: "L2",
      status: "ok",
      value: {
        roster: { entityCount: 10, cut: 0 },
        result: {
          candidates: { visibleCount: 10 },
          requests: [req(true, 3, 900), req(true, 5, 1000), req(false, 0, 0)],
          successCount: 2,
          failuresByKind: { "no-valid-result": 1 },
          undeterminable: false,
          stopped: null,
          registeredNotInCandidates: 1,
          selfAgreement: {
            keysCompared: 4,
            aliasAgree: 3,
            typeAgree: 4,
            successfulRuns: 2,
          },
        },
      },
    },
  ]);
  assert.deepEqual(b1[0].metricRanges.aliasButtons, { n: 2, min: 3, max: 5 });
  assert.deepEqual(b1[0].tokensIn, { n: 2, min: 900, max: 1000 });
  assert.equal(b1[0].requestCount, 3);
  assert.equal(b1[0].failuresByKind["no-valid-result"], 1);
  const b2 = buildMeasureB2([
    {
      work: "w1",
      level: "L2",
      status: "ok",
      value: {
        result: {
          initialCandidateCount: 120,
          plannedIterations: 3,
          iterations: [
            { ok: true, metrics: metrics(2) },
            { ok: true, metrics: metrics(3) },
            { ok: false, metrics: null },
          ],
          decisionCounts: { alias: 5, accept: 0, dismiss: 100 },
          dismissReasons: { unlisted: 100 },
          stopped: null,
          noProgress: false,
          finalVisibleCount: 0,
        },
      },
    },
  ]);
  assert.equal(b2[0].iterationCount, 3);
  assert.equal(b2[0].failedIterations, 1);
  assert.equal(b2[0].metricTotals.aliasMatchRoster, 5);
});

test("★ の対応表：常に決めない。場面で指す人が変わる表記が 5 未満なら「材料なし」", async () => {
  const a = await fixtureCells("w1");
  const measureA = buildMeasureA({ cells: a.cells, rowsByCell: a.rowsByCell });
  const few = buildStarMapping({
    measureA,
    ambiguousSurfaceCounts: { w1: 2, w2: 2 },
  });
  assert.equal(few.star5.noMaterial, true);
  assert.equal(
    buildStarMapping({ measureA, ambiguousSurfaceCounts: { w1: 3, w2: 2 } })
      .star5.noMaterial,
    false,
  );
  assert.equal(buildStarMapping({ measureA }).star5.noMaterial, false);
  for (const key of ["star4", "star5", "star8", "star1_2_3_6_7"])
    assert.equal(few[key].decided, false);
  assert.ok(few.star4.cannotSay.length > 0);
  assert.equal(few.perWork.w1.star4.unresolvedCandidateIn, 0);
});

test("records：本文・credential の欄が無いことを検査する（欄の拒否・文字列の拒否・shingle）", async () => {
  const a = await fixtureCells("w1");
  const measureA = buildMeasureA({ cells: a.cells, rowsByCell: a.rowsByCell });
  const records = buildRecords({ measureA, b1: [], b2: [] });
  assert.equal(records.evidenceScope, "not-cp4-evidence");
  assert.deepEqual(records.declarations, ["not-quality-claim", "not-gold"]);
  assert.equal(records.indicatorName, "match-with-roster");
  assert.doesNotThrow(() => assertRecordsClean(records));
  // credential を示す欄名は拒む（token の件数は拒まない）。
  for (const key of [
    "authorization",
    "apiKey",
    "api_key",
    "credential",
    "password",
    "bearer",
    "secret",
  ])
    assert.throws(
      () => assertRecordsClean({ ok: 1, [key]: 1 }),
      /RECORDS_UNCLEAN/u,
    );
  assert.doesNotThrow(() => assertRecordsClean({ tokensIn: 5 }));
  assert.ok(!FORBIDDEN_KEY.test("tokensIn"));
  assert.deepEqual(findForbiddenKeys({ a: { b: { Authorization: 1 } } }), [
    "$.a.b.<forbidden-key>",
  ]);
  // 日本語・自由文の文字列は拒む。
  assert.throws(
    () => assertRecordsClean({ note: "原稿の一文" }),
    /RECORDS_UNCLEAN/u,
  );
  assert.throws(
    () => assertRecordsClean({ note: "free text, with comma" }),
    /RECORDS_UNCLEAN/u,
  );
  // 原稿の shingle（ASCII の語）が混ざれば拒む。
  assert.throws(
    () =>
      assertRecordsClean({ id: "someuniqueword" }, ["xx someuniqueword yy"]),
    /unclean|UNCLEAN/u,
  );
});

test("markdown は件数と範囲だけを出し、測定 A と B は別表", async () => {
  const a = await fixtureCells("w1");
  const measureA = buildMeasureA({ cells: a.cells, rowsByCell: a.rowsByCell });
  const records = buildRecords({ measureA, b1: [], b2: [] });
  const md = renderRecordsMarkdown(records);
  assert.match(md, /## 測定 A/u);
  assert.match(md, /## 測定 B/u);
  assert.match(md, /品質の証拠ではない/u);
  assert.match(md, /どの選択肢を支持するかは決めない/u);
  assert.ok(md.indexOf("## 測定 A") < md.indexOf("## 測定 B"));
});
