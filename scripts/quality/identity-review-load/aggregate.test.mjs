// 集計の試験（合成の cell・rows。実在の原稿・名簿は使わない）。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  FORBIDDEN_KEY,
  LEGACY_METRIC_DEFINITION,
  assertRecordsClean,
  assertSingleBMetricDefinition,
  buildMeasureA,
  buildMeasureB1,
  buildMeasureB2,
  buildRecords,
  buildStarMapping,
  findForbiddenKeys,
  flattenRunA,
  flattenStoredUnreviewed,
  rangeOf,
  renderRecordsMarkdown,
  storedNotes,
  storedUnreviewedState,
} from "./aggregate.mjs";
import { storedNotMeasured, summarizeStoredProposals } from "./lib.mjs";
import { B_METRIC_DEFINITION_VERSION } from "./measure-b-core.mjs";
import {
  METRIC_DEFINITION_VERSION,
  buildRosterIndex,
  computeMeasureA,
} from "./measure-a-metrics.mjs";

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

// ---- 保存済みの未 review の提案の件数（問い 4）-----------------------------------------------

const storedOf = (current, prior) =>
  summarizeStoredProposals({
    runs: [
      {
        role: "current",
        listedByProduct: true,
        runStatus: "completed",
        setStatus: "draft",
        proposals: Array.from({ length: current }, () => ({
          kind: "codex.entity.bind",
          status: "unreviewed",
          applied: false,
        })),
      },
      ...(prior > 0
        ? [
            {
              role: "prior",
              listedByProduct: true,
              runStatus: "completed",
              setStatus: "draft",
              proposals: Array.from({ length: prior }, () => ({
                kind: "codex.relation.create",
                status: "unreviewed",
                applied: false,
              })),
            },
          ]
        : []),
    ],
    listedCount: prior > 0 ? 2 : 1,
  });

test("flattenStoredUnreviewed：未計測と欄の無い過去の records は 0 でなく null、state で理由を区別する", () => {
  const measured = flattenStoredUnreviewed({
    ...storedOf(5, 3),
    projectionCheck: { compared: true, ok: true, differingKinds: [] },
  });
  assert.equal(measured.storedUnreviewedTotal, 8);
  assert.equal(measured.storedUnreviewedCurrentRun, 5);
  assert.equal(measured.storedUnreviewedPriorRuns, 3);
  assert.equal(measured.storedUnreviewedPriorRunsRelation, 3);
  assert.equal(measured.storedUnreviewedPriorRunsEntity, 0);
  assert.equal(measured.storedProjectionMismatch, 0);
  assert.equal(
    flattenStoredUnreviewed({
      ...storedOf(1, 0),
      projectionCheck: { compared: true, ok: false, differingKinds: ["x"] },
    }).storedProjectionMismatch,
    1,
  );
  // 件数 0 の measured は 0。未計測は null。
  assert.equal(
    flattenStoredUnreviewed(storedOf(0, 0)).storedUnreviewedTotal,
    0,
  );
  for (const stored of [
    storedNotMeasured("persist-skipped"),
    storedNotMeasured("read-failed", { name: "Error" }),
    undefined,
  ]) {
    const flat = flattenStoredUnreviewed(stored);
    assert.ok(Object.values(flat).every((v) => v === null));
  }
  assert.equal(
    storedUnreviewedState({ storedUnreviewed: storedOf(1, 0) }),
    "measured",
  );
  assert.equal(
    storedUnreviewedState({
      storedUnreviewed: storedNotMeasured("persist-skipped"),
    }),
    "persist-skipped",
  );
  assert.equal(storedUnreviewedState({}), "absent");
});

test("flattenRunA：保存済みの未 review の列は件数か null だけ（既存の列の検査を保つ）", async () => {
  const r = await run("F100", [mkRow("al", "create-new")], 60);
  const flat = flattenRunA({ ...r, storedUnreviewed: storedOf(2, 4) });
  assert.equal(flat.storedUnreviewedPriorRuns, 4);
  assert.ok(Object.values(flat).every((v) => v === null || Number.isFinite(v)));
  assert.equal(flattenRunA(r).storedUnreviewedTotal, null);
});

test("buildMeasureA・★ の表・markdown：累積の列に保存済みの未 review を載せ、保存しない段は「未計測」と書く", async () => {
  const a = await fixtureCells("w1");
  // 累積の列だけ保存つき（F25 は前の回なし、以後は積み上がる）。matrix は保存なし。
  const cumulative = a.cells.find((c) => c.kind === "cumulative");
  const priors = [0, 2, 5, 9];
  cumulative.runs = cumulative.runs.map((r, i) => ({
    ...r,
    storedUnreviewed: {
      ...storedOf(3, priors[i]),
      projectionCheck: { compared: true, ok: true, differingKinds: [] },
    },
  }));
  for (const c of a.cells)
    if (c.kind !== "cumulative")
      c.runs = c.runs.map((r) => ({
        ...r,
        storedUnreviewed: storedNotMeasured("persist-skipped"),
      }));
  const measureA = buildMeasureA({ cells: a.cells, rowsByCell: a.rowsByCell });
  const w = measureA.byWork.w1;
  assert.deepEqual(
    w.cumulative.map((r) => r.storedUnreviewedPriorRuns),
    priors,
  );
  assert.equal(w.matrix.L2.storedUnreviewedTotal, null);
  assert.equal(w.storedStates.L2, "persist-skipped");
  assert.equal(w.storedStates["cumulative-F50"], "measured");
  // 未計測の段は範囲の n に入らない（null は数えない）。
  assert.equal(measureA.ranges.L2.storedUnreviewedTotal.n, 0);
  const star = buildStarMapping({ measureA });
  assert.deepEqual(
    star.perWork.w1.star8Stored.map((r) => [r.label, r.state, r.priorRuns]),
    [
      ["F25", "measured", 0],
      ["F50", "measured", 2],
      ["F75", "measured", 5],
      ["F100", "measured", 9],
    ],
  );
  assert.equal(star.star8.decided, false);
  assert.ok(star.star8.materials.includes("storedUnreviewedPriorRuns"));
  const records = buildRecords({ measureA, b1: [], b2: [] });
  assert.doesNotThrow(() => assertRecordsClean(records));
  const md = renderRecordsMarkdown(records);
  assert.match(md, /保存済みの未 review/u);
  assert.match(md, /\| F100 \|[^\n]*\| 12 \| 9 \|/u);
  assert.match(md, /\| L2 \|[^\n]*\| 未計測 \|/u);
});

test("指標の定義の版：records に版を載せ、旧 records（版なし）と新しい版が混ざった入力は集計しない", async () => {
  const a = await fixtureCells("w1");
  const measureA = buildMeasureA({ cells: a.cells, rowsByCell: a.rowsByCell });
  assert.equal(measureA.definitionVersion, METRIC_DEFINITION_VERSION);
  const records = buildRecords({ measureA, b1: [], b2: [] });
  assert.equal(records.metricDefinitionVersion, METRIC_DEFINITION_VERSION);
  assert.doesNotThrow(() => assertRecordsClean(records));
  assert.match(
    renderRecordsMarkdown(records),
    new RegExp(`指標の定義の版: 測定 A ${METRIC_DEFINITION_VERSION}`, "u"),
  );

  // 旧 records：metrics に版の欄が無い（定義の版 legacy）。全部が旧なら、旧として集計できる。
  const strip = (cells) =>
    cells.map((c) => ({
      ...c,
      runs: c.runs.map((r) => {
        const { definitionVersion: _v, ...metrics } = r.metrics;
        return { ...r, metrics };
      }),
    }));
  const legacy = buildMeasureA({
    cells: strip(a.cells),
    rowsByCell: a.rowsByCell,
  });
  assert.equal(legacy.definitionVersion, LEGACY_METRIC_DEFINITION);
  // 旧と新が混ざったら止める（数字の定義が違う）。どちらの順でも止める。
  const [first, ...rest] = a.cells;
  const mixed = [...strip([first]), ...rest];
  assert.throws(
    () => buildMeasureA({ cells: mixed, rowsByCell: a.rowsByCell }),
    /METRIC_DEFINITION_VERSIONS_MIXED versions=a-defs\/3,legacy/u,
  );
  assert.throws(
    () =>
      buildMeasureA({
        cells: [first, ...strip(rest)],
        rowsByCell: a.rowsByCell,
      }),
    /METRIC_DEFINITION_VERSIONS_MIXED/u,
  );
  // 別の版の文字列が混ざっても止める。
  const other = a.cells.map((c, i) =>
    i === 0
      ? {
          ...c,
          runs: c.runs.map((r) => ({
            ...r,
            metrics: { ...r.metrics, definitionVersion: "a-defs/9" },
          })),
        }
      : c,
  );
  assert.throws(
    () => buildMeasureA({ cells: other, rowsByCell: a.rowsByCell }),
    /METRIC_DEFINITION_VERSIONS_MIXED versions=a-defs\/3,a-defs\/9/u,
  );
});

test("指標の定義の版：a-defs/2 の records（一括 1 回で誤った Entry ができる件数の欄が無い）と a-defs/3 は混ぜて集計しない", async () => {
  const a = await fixtureCells("w1");
  const [first, ...rest] = a.cells;
  const asV2 = (cell) => ({
    ...cell,
    runs: cell.runs.map((r) => {
      const { bulkCreateWrongEntry: _w, ...mismatch } = r.metrics.mismatch;
      return {
        ...r,
        metrics: { ...r.metrics, definitionVersion: "a-defs/2", mismatch },
      };
    }),
  });
  assert.equal(METRIC_DEFINITION_VERSION, "a-defs/3");
  assert.throws(
    () =>
      buildMeasureA({
        cells: [asV2(first), ...rest],
        rowsByCell: a.rowsByCell,
      }),
    /METRIC_DEFINITION_VERSIONS_MIXED versions=a-defs\/2,a-defs\/3/u,
  );
  // 全部が a-defs/2 なら、その版として集計でき、新しい欄は 0 でなく null（範囲は n=0 で「-」）。
  const allV2 = buildMeasureA({
    cells: a.cells.map(asV2),
    rowsByCell: a.rowsByCell,
  });
  assert.equal(allV2.definitionVersion, "a-defs/2");
  const l2 = Object.values(allV2.byWork)[0].matrix.L2;
  assert.equal(l2.bulkCreateWrongEntry, null);
  assert.equal(l2.bulkCreateOutsideRoster, null);
  assert.deepEqual(allV2.ranges.L2.bulkCreateWrongEntry, {
    n: 0,
    min: null,
    max: null,
  });
});

test("旧 records（版なし）だけを集計すると、一括の結び付け・結び先違い・合計・関係の呼び名の欄は 0 でなく null（markdown は「-」）", async () => {
  const a = await fixtureCells("w1");
  const legacyCells = a.cells.map((c) => ({
    ...c,
    runs: c.runs.map((r) => {
      const {
        definitionVersion: _v,
        relational: _r,
        bulkApprovable: _b,
        ...metrics
      } = r.metrics;
      const {
        bulkBind: _bb,
        relational: _rc,
        ...categoryCounts
      } = metrics.categoryCounts;
      const {
        wrongTargetInBulk: _w,
        wrongTargetInBulkEntity: _we,
        bulkBindOnAmbiguous: _ba,
        bulkBindOnAmbiguousOutOfSet: _bo,
        bulkCreateWrongEntry: _bw,
        ...mismatch
      } = metrics.mismatch;
      return {
        ...r,
        metrics: { ...metrics, categoryCounts, mismatch },
      };
    }),
  }));
  const measureA = buildMeasureA({
    cells: legacyCells,
    rowsByCell: a.rowsByCell,
  });
  assert.equal(measureA.definitionVersion, LEGACY_METRIC_DEFINITION);
  const l2 = Object.values(measureA.byWork)[0].matrix.L2;
  for (const column of [
    "bulkBind",
    "bulkTotal",
    "wrongTargetInBulk",
    "relational",
    "relationalUnresolved",
    "relationalBindExisting",
    "relationalCreateNew",
    "relationalUnresolvedPartial",
    "bulkCreateWrongEntry",
  ])
    assert.equal(l2[column], null, column);
  // 旧の bulk（create-new 専用）は残る。
  assert.equal(typeof l2.bulk, "number");
  assert.deepEqual(measureA.ranges.L2.bulkTotal, {
    n: 0,
    min: null,
    max: null,
  });
  const md = renderRecordsMarkdown(buildRecords({ measureA }));
  assert.deepEqual(
    md
      .split("## 測定 B")[0]
      .split("\n")
      .filter((line) => /\bnull\b|undefined|NaN/u.test(line)),
    [],
    "markdown に null・undefined・NaN が出ない",
  );
});

test("一括の結び先違いの危険（結び先が 1 つに定まらない表記への一括）と、保存済みの未 review の内訳の列が平らな件数になる", async () => {
  const index = await buildRosterIndex(
    {
      entities: [
        {
          id: "e1",
          type: "character",
          name: "alpha",
          aliases: [{ surface: "shared", level: "L2" }],
        },
        {
          id: "e2",
          type: "character",
          name: "beta",
          aliases: [{ surface: "shared", level: "L2" }],
        },
      ],
    },
    ident,
  );
  const rows = [
    mkRow("shared", "bind-existing", {
      bindExistingEntityId: "e1",
      bulkApprovable: true,
      applicability: "applicable",
      safe: true,
    }),
  ];
  const r = {
    label: "F100",
    completed: true,
    extract: { sceneCount: 3, entryCountInCatalog: 2 },
    metrics: computeMeasureA({ index, rows }),
    storedUnreviewed: summarizeStoredProposals({
      runs: [
        {
          role: "current",
          listedByProduct: true,
          tracked: true,
          visibleToAuthor: true,
          runStatus: "completed",
          setStatus: "draft",
          proposals: Array.from({ length: 4 }, () => ({
            kind: "codex.entity.bind",
            status: "unreviewed",
            applied: false,
          })),
        },
        {
          role: "prior",
          listedByProduct: true,
          tracked: false,
          failedStage: true,
          runStatus: "completed",
          setStatus: "draft",
          proposals: Array.from({ length: 6 }, () => ({
            kind: "codex.entity.bind",
            status: "unreviewed",
            applied: false,
          })),
        },
      ],
      listedCount: 100,
    }),
  };
  const flat = flattenRunA(r);
  assert.equal(flat.wrongTargetInBulk, 1);
  assert.equal(flat.bulkBindOnAmbiguous, 1);
  assert.equal(flat.wrongTargetInBulkEntity, 0);
  assert.equal(flat.bulkBindOnAmbiguousOutOfSet, 0);
  assert.equal(flat.storedUnreviewedTotal, 10);
  assert.equal(flat.storedUnreviewedPriorRuns, 0);
  assert.equal(flat.storedUnreviewedNotAdoptedRuns, 6);
  assert.equal(flat.storedUnreviewedVisibleToAuthor, 4);
  assert.equal(flat.storedUnreviewedNotVisibleToAuthor, 6);
  assert.equal(flat.storedFailedStageRuns, 1);
  assert.equal(flat.storedUntrackedRuns, 0);
  assert.equal(flat.storedListTruncated, 1);
  assert.ok(Object.values(flat).every((v) => v === null || Number.isFinite(v)));
  // 新しい欄（採用しなかった run・作者に見える run・打ち切り）が無い過去の records は、その欄だけ null（0 ではない）。
  const {
    failedStageRunCount: _f,
    untrackedRunCount: _u,
    listTruncated: _t,
    ...oldStored
  } = storedOf(2, 1);
  const {
    notAdoptedRuns: _n,
    visibleToAuthor: _v,
    notVisibleToAuthor: _nv,
    ...oldUnreviewed
  } = oldStored.unreviewed;
  const old = flattenStoredUnreviewed({
    ...oldStored,
    unreviewed: oldUnreviewed,
  });
  assert.equal(old.storedUnreviewedTotal, 3);
  assert.equal(old.storedUnreviewedPriorRuns, 1);
  for (const column of [
    "storedUnreviewedNotAdoptedRuns",
    "storedUnreviewedVisibleToAuthor",
    "storedUnreviewedNotVisibleToAuthor",
    "storedFailedStageRuns",
    "storedUntrackedRuns",
    "storedListTruncated",
  ])
    assert.equal(old[column], null, column);
});

test("storedNotes・markdown：打ち切り・件数の不一致・採用しなかった run・未計測の理由が表に出る（件数と語だけ）", async () => {
  assert.equal(storedNotes({}, "measured"), "-");
  assert.match(
    storedNotes({}, "persist-skipped"),
    /未計測\(persist-skipped\)/u,
  );
  assert.match(storedNotes({}, "absent"), /欄なし/u);
  assert.match(storedNotes({ storedListTruncated: 1 }, "measured"), /上限/u);
  assert.match(
    storedNotes({ storedProjectionMismatch: 1 }, "measured"),
    /不一致/u,
  );
  assert.match(
    storedNotes({ storedFolderUnknownRuns: 3 }, "measured"),
    /folder 不明の run 3/u,
  );
  assert.match(
    storedNotes(
      { storedFailedStageRuns: 2, storedUntrackedRuns: 1 },
      "measured",
    ),
    /失敗した段の run 2・控えに無い run 1/u,
  );
  // 累積の表に載る。
  const a = await fixtureCells("w1");
  const cumulative = a.cells.find((c) => c.kind === "cumulative");
  const runWith = (extra) =>
    summarizeStoredProposals({
      runs: [
        {
          role: "current",
          listedByProduct: true,
          tracked: true,
          visibleToAuthor: true,
          folderKnown: true,
          runStatus: "completed",
          setStatus: "draft",
          proposals: [
            { kind: "codex.entity.bind", status: "unreviewed", applied: false },
          ],
        },
        ...extra,
      ],
      listedCount: 100,
    });
  cumulative.runs = cumulative.runs.map((r, i) => ({
    ...r,
    storedUnreviewed: {
      ...runWith(
        i === 3
          ? [
              {
                role: "prior",
                listedByProduct: true,
                tracked: false,
                folderKnown: true,
                runStatus: "completed",
                setStatus: "draft",
                proposals: [],
              },
            ]
          : [],
      ),
      projectionCheck: { compared: true, ok: i !== 3, differingKinds: [] },
    },
  }));
  const measureA = buildMeasureA({ cells: a.cells, rowsByCell: a.rowsByCell });
  const md = renderRecordsMarkdown(buildRecords({ measureA, b1: [], b2: [] }));
  assert.match(
    md,
    /\| F100 \|[^\n]*列挙が上限に達した\(過少の可能性\)・保存と projection の件数が不一致・控えに無い run 1 \|/u,
  );
  assert.match(md, /\| F25 \|[^\n]*列挙が上限に達した\(過少の可能性\) \|/u);
  assert.match(md, /うち採用しなかった run/u);
  // 保存済みの欄が無い段（matrix）は「欄なし」。
  assert.match(md, /\| L2 \|[^\n]*欄なし \|/u);
});

test("測定 B の指標の定義の版：B1・B2 を合わせて版が混ざったら止め、旧 records（版なし）は legacy として別に扱う（A の版とは別）", () => {
  const cell = (version, level = "L2") => ({
    work: "w1",
    level,
    status: "ok",
    ...(version === undefined ? {} : { metricDefinitionVersion: version }),
    value: {
      result: { requests: [], iterations: [], decisionCounts: null },
    },
  });
  assert.equal(assertSingleBMetricDefinition([]), null);
  assert.equal(
    assertSingleBMetricDefinition([
      cell(B_METRIC_DEFINITION_VERSION),
      cell(B_METRIC_DEFINITION_VERSION, "L1"),
    ]),
    B_METRIC_DEFINITION_VERSION,
  );
  // 旧だけなら旧として集計できる。
  assert.equal(
    assertSingleBMetricDefinition([cell(undefined)]),
    LEGACY_METRIC_DEFINITION,
  );
  // 旧と新が混ざったら止まる。B1 だけ・B2 だけ・合わせた records のどれでも。
  const mixed = [cell(B_METRIC_DEFINITION_VERSION), cell(undefined, "L1")];
  assert.throws(
    () => assertSingleBMetricDefinition(mixed),
    /METRIC_DEFINITION_VERSIONS_MIXED versions=b-defs\/2,legacy[^\n]*measure=B/u,
  );
  assert.throws(() => buildMeasureB1(mixed), /VERSIONS_MIXED/u);
  assert.throws(() => buildMeasureB2(mixed), /VERSIONS_MIXED/u);
  assert.throws(
    () =>
      buildRecords({
        measureA: null,
        b1: [cell(B_METRIC_DEFINITION_VERSION)],
        b2: [cell(undefined)],
      }),
    /VERSIONS_MIXED/u,
  );
  // 揃っていれば records に B の版が載り、A の版（measureA）とは別の欄。
  const records = buildRecords({
    measureA: null,
    b1: [cell(B_METRIC_DEFINITION_VERSION)],
    b2: [cell(B_METRIC_DEFINITION_VERSION)],
  });
  assert.equal(records.measureB.definitionVersion, B_METRIC_DEFINITION_VERSION);
  assert.equal(records.metricDefinitionVersion, null);
  assert.doesNotThrow(() => assertRecordsClean(records));
  assert.match(
    renderRecordsMarkdown(records),
    new RegExp(`測定 B ${B_METRIC_DEFINITION_VERSION}`, "u"),
  );
});

test("run-measure-b は cell の結果に測定 B の指標の定義の版を載せる（aggregate が版の混在を止める入力）", () => {
  const source = readFileSync(
    path.join(import.meta.dirname, "run-measure-b.mjs"),
    "utf8",
  );
  assert.match(
    source,
    /schemaVersion: "identity-load-measure-b\/1",\s*(?:\/\/[^\n]*\n\s*)?metricDefinitionVersion: B_METRIC_DEFINITION_VERSION,/u,
  );
});

test("F2 の新しい欄と status：cell の記録（build の出所・宛先・guard の件数）は出力の検査を通り、不採用の status は B1・B2 の行に反映される", () => {
  const cell = (status) => ({
    schemaVersion: "identity-load-measure-b/1",
    metricDefinitionVersion: B_METRIC_DEFINITION_VERSION,
    work: "w1",
    level: "L2",
    status,
    observed: {
      buildProvenance: {
        head: "a".repeat(40),
        recordedAt: "2026-11-23T01:02:03.000Z",
        files: [
          { path: "dist-electron/main.cjs", sha256: "b".repeat(64) },
          {
            path: "electron/native/grimodex-node/grimodex-node.node",
            sha256: "c".repeat(64),
          },
        ],
      },
      egress: {
        sampleCount: 4,
        sampleFailures: 0,
        nonLoopbackDestinationCount: 2,
        nonLoopbackDestinations: [
          "tcp 198.51.100.7:443",
          "tcp 2001:db8:abcd:1:0:0:0:7:443",
        ],
        disallowedDestinations: [],
        policy: { allowCidrs: ["198.51.100.0/24", "2001:db8:abcd::/48"] },
        policyApplied: true,
      },
    },
    value: {
      preconditions: {
        role: { roleKeysChecked: 7, nonDefaultRoleKeys: 0 },
        hidden: { entryCount: 2, checkedCount: 2, hiddenCount: 0 },
        sendGuardChecks: 3,
      },
      result: { requests: [], iterations: [], stopped: null },
    },
  });
  const statuses = [
    "ok",
    "egress-detected",
    "egress-unverified",
    "build-unverified",
    "budget-stopped",
  ];
  const cells = statuses.map(cell);
  for (const c of cells) assert.doesNotThrow(() => assertRecordsClean(c));
  assert.deepEqual(
    buildMeasureB1(cells).map((row) => row.status),
    statuses,
  );
  assert.deepEqual(
    buildMeasureB2(cells).map((row) => row.status),
    statuses,
  );
});

test("一括 1 回で誤った Entry ができる件数：名簿の外・結び先が定まらない表記・既知の実体への一括の create-new が、列・作品間の範囲・markdown の表に出る", async () => {
  const wrongRoster = {
    entities: [
      {
        id: "e1",
        type: "character",
        name: "alpha",
        aliases: [{ surface: "shared", level: "L2" }],
        relationalSurfaces: ["kin-call"],
      },
      {
        id: "e2",
        type: "character",
        name: "beta",
        aliases: [{ surface: "shared", level: "L2" }],
      },
    ],
  };
  const index = await buildRosterIndex(wrongRoster, ident);
  const bulk = (key) => mkRow(key, "create-new", { bulkApprovable: true });
  // 名簿の外 2（ノイズ・関係の呼び名）・結び先が定まらない表記 1・既知の実体 1。
  const rows = [bulk("noise"), bulk("kin-call"), bulk("shared"), bulk("alpha")];
  const make = (work, rowList) => ({
    cell: `${work}-matrix-L2`,
    work,
    kind: "matrix",
    level: "L2",
    status: "ok",
    runs: [
      {
        label: "F100",
        completed: true,
        extract: { sceneCount: 60, entryCountInCatalog: 2 },
        metrics: computeMeasureA({ index, rows: rowList }),
      },
    ],
  });
  const measureA = buildMeasureA({
    cells: [make("w1", rows), make("w2", rows.slice(0, 1))],
    rowsByCell: {},
  });
  const l2 = measureA.byWork.w1.matrix.L2;
  assert.equal(l2.bulkCreateWrongEntry, 4);
  assert.equal(l2.bulkCreateOutsideRoster, 3);
  assert.equal(l2.bulkCreateNotInRoster, 1);
  assert.equal(l2.bulkCreateRelational, 1);
  assert.equal(l2.bulkCreateAmbiguous, 1);
  assert.equal(l2.bulkCreateKnownEntity, 1);
  // 操作の下限の「一括承認」は名簿の実体の行（shared・alpha）だけ。
  assert.equal(l2.bulkTotal, 2);
  assert.deepEqual(measureA.ranges.L2.bulkCreateWrongEntry, {
    n: 2,
    min: 1,
    max: 4,
  });
  const md = renderRecordsMarkdown(buildRecords({ measureA }));
  assert.match(md, /一括 1 回で誤った Entry ができる件数\(うち名簿の外/u);
  assert.match(md, /\| w1 \| L2 \|[^\n]*\| 4\(3\) \|/u);
  assert.match(md, /\| w2 \| L2 \|[^\n]*\| 1\(1\) \|/u);
  assert.match(
    md,
    /\| 承認の下限 \| 一括 1 回で誤った Entry ができる件数 \|\n\|(?:---\|){8}\n\| L2 \|[^\n]*\| 1–4 \|/u,
  );
  // 表の見出しと区切りの列数が合う（markdown の表が崩れない）。
  const lines = md.split("\n");
  const at = lines.findIndex((line) =>
    line.startsWith("| 作品 | 段 | 場面数 |"),
  );
  const header = lines[at];
  const separator = lines[at + 1];
  assert.equal(
    header.split("|").length,
    separator.split("|").length,
    "見出しと区切りの列数",
  );
});

test("関係の呼び名の unresolved（部分一致の候補あり）は列と markdown に出る。folder 不明の run の注記は、製品との差（どの folder にも当てる・多く出る側）を言う", async () => {
  const index = await buildRosterIndex(
    {
      entities: [
        {
          id: "e1",
          type: "character",
          name: "alpha",
          aliases: [],
          relationalSurfaces: ["kin-call"],
        },
      ],
    },
    ident,
  );
  const rows = [
    mkRow("kin-call", "unresolved", {
      candidates: [{ id: "e1", score: 70, methods: ["prefix"] }],
    }),
    mkRow("kin-call", "unresolved", {
      candidates: [{ id: "e1", score: 100, methods: ["exact-name"] }],
    }),
    mkRow("kin-call", "create-new"),
  ];
  const flat = flattenRunA({
    label: "F100",
    completed: true,
    extract: { sceneCount: 3, entryCountInCatalog: 1 },
    metrics: computeMeasureA({ index, rows }),
  });
  assert.equal(flat.relational, 3);
  assert.equal(flat.relationalUnresolved, 2);
  assert.equal(flat.relationalUnresolvedPartial, 1);
  // 操作の下限には入らない（別枠のまま）。
  assert.equal(flat.opsApprovalSurface, 0);
  assert.equal(flat.opsKeepSurfaceSurface, 0);
  // folder 不明の run：製品はどの folder にも当てる（写しは独立の folder）。注記は「過少」と言わない。
  const note = storedNotes({ storedFolderUnknownRuns: 2 }, "measured");
  assert.match(note, /folder 不明の run 2/u);
  assert.match(note, /製品はどの folder にも当てる/u);
  assert.doesNotMatch(note, /過少/u);
});
