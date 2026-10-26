// R5（K6/4:196）の seed の pin の照合と、SP/1（graph-case-seed-pin-setup）の
// variant ごとの照合。合成の記録と一時の DB だけ。凍結した G-case の材料は読まない
// （実 fixture の照合は S5 の前の別工程）。
import assert from "node:assert/strict";
import { test } from "node:test";
import { GRAPH_EVAL_VARIANTS } from "./constants.mjs";
import { productDbPinReads } from "./test-support.mjs";
import {
  FROZEN_SEED_CASE_IDS,
  assertSeedPinsBeforeK64,
  productSeedOf,
  verifySeedPins,
} from "./seed-pin.mjs";

const pin = (entryId, createdAt, entryInProject = true) => ({
  entryId,
  createdAt,
  entryInProject,
});

const scene = (pins, overrides = {}) => ({
  caseId: "G-02",
  querySceneId: "scene-q",
  sceneLive: true,
  pins,
  expectedSeed: "entity-seed",
  ...overrides,
});

test("R5: seed は製品の規則（created_at、entry_id の順で最初の pin だけ）で決まる", () => {
  assert.equal(
    productSeedOf(scene([pin("b", 2), pin("entity-seed", 1)])),
    "entity-seed",
  );
  // created_at が同じなら entry_id の順。
  assert.equal(
    productSeedOf(scene([pin("zz", "2026-10-01"), pin("aa", "2026-10-01")])),
    "aa",
  );
  // 最初の pin が空白か 200 UTF-16 を超えれば seed は無く、次の pin は試さない。
  assert.equal(
    productSeedOf(scene([pin("  ", 1), pin("entity-seed", 2)])),
    null,
  );
  assert.equal(
    productSeedOf(scene([pin("x".repeat(201), 1), pin("entity-seed", 2)])),
    null,
  );
  assert.equal(
    productSeedOf(scene([pin("x".repeat(200), 1)])),
    "x".repeat(200),
  );
  // 別の project の entry は join で落ちる。archive された Scene には seed が無い。
  assert.equal(
    productSeedOf(scene([pin("other", 1, false), pin("entity-seed", 2)])),
    "entity-seed",
  );
  assert.equal(
    productSeedOf(scene([pin("entity-seed", 1)], { sceneLive: false })),
    null,
  );
  assert.equal(productSeedOf(scene([])), null);
});

test("R5: 一致・不一致・確かめられないを分ける", () => {
  const result = verifySeedPins([
    scene([pin("entity-seed", 1)]),
    scene([pin("other", 1), pin("entity-seed", 2)], { caseId: "G-03" }),
    scene(null, { caseId: "G-04" }),
    scene([pin("entity-seed", 1)], { caseId: "G-05", expectedSeed: null }),
    scene([pin("entity-seed", 1), pin("x", "2")], { caseId: "G-06" }),
  ]);
  assert.deepEqual(
    result.rows.map((row) => [row.caseId, row.status]),
    [
      ["G-02", "match"],
      ["G-03", "mismatch"],
      ["G-04", "unconfirmed"],
      ["G-05", "unconfirmed"],
      ["G-06", "unconfirmed"],
    ],
  );
  assert.equal(result.rows[1].productSeed, "other");
  // 確かめられない case が 1 つでもあれば全体は unconfirmed（不一致より優先）。
  assert.equal(result.status, "unconfirmed");
  assert.equal(
    verifySeedPins([
      scene([pin("entity-seed", 1)]),
      scene([pin("other", 1)], { caseId: "G-03" }),
    ]).status,
    "mismatch",
  );
  assert.equal(verifySeedPins([]).status, "unconfirmed");
});

/**
 * S1g-A (SP/1 SP-P3): the frozen plan's rows, one per variant workspace,
 * read from a product DB. `change(variantKey, row)` alters a row's pins or
 * mapping before the DB is written.
 */
function frozenRows(change = (_key, row) => row) {
  const specs = GRAPH_EVAL_VARIANTS.map((variant) => {
    const runtime = `rt-${variant.key}`;
    return change(variant.key, {
      caseId: variant.caseId,
      variantId: variant.variantId,
      querySceneId: `${variant.key}/query`,
      expectedSeedLogical: `${variant.caseId}-seed`,
      expectedSeed: runtime,
      entityRuntimeIds: {
        [`${variant.caseId}-seed`]: runtime,
        other: "rt-other",
      },
      live: true,
      pins: [{ entryId: runtime, createdAt: "2026-10-27T00:00:01Z" }],
    });
  });
  const reads = productDbPinReads(
    specs.map((row) => ({
      sceneId: row.querySceneId,
      live: row.live,
      pins: row.pins,
    })),
  );
  return specs.map(({ live: _live, pins: _pins, ...row }) => ({
    ...row,
    read: reads[row.querySceneId],
  }));
}

const SEED_PLAN = GRAPH_EVAL_VARIANTS.map((variant) => ({
  caseId: variant.caseId,
  variantId: variant.variantId,
  querySceneId: `${variant.key}/query`,
  seedEntityId: `${variant.caseId}-seed`,
}));

const frozenGate = (cases, seedPlan = SEED_PLAN) =>
  assertSeedPinsBeforeK64({ cases, plan: "frozen", seedPlan });

test("R5／SP-P3: 凍結の plan は 13 の variant の workspace を 1 行ずつ、製品の DB から読んで照合し、すべて match のときだけ通る", () => {
  assert.deepEqual(FROZEN_SEED_CASE_IDS, [
    ...new Set(GRAPH_EVAL_VARIANTS.map((row) => row.caseId)),
  ]);
  const passed = frozenGate(frozenRows());
  assert.equal(passed.status, "match");
  assert.equal(passed.rows.length, 13);
  assert.ok(Object.isFrozen(passed) && Object.isFrozen(passed.rows));
});

test("R5／SP-N1〜N3、N9、N11、N13、N14: 不一致・2 つ以上・pin なし・runtime ID の取り違え・自己申告・variant や G-01 の欠けは [precheck]", () => {
  const other = { entryId: "rt-other", createdAt: "2026-10-27T00:00:00Z" };
  const cases = [
    // SP-N1: pin の entry が予定の seed でない。
    [
      "N1",
      frozenRows((key, row) =>
        key === "G-02/base" ? { ...row, pins: [{ ...other }] } : row,
      ),
      /G-02\/base: mismatch/u,
    ],
    // SP-N2: 最初が予定の seed でも pin が 2 つ以上。
    [
      "N2",
      frozenRows((key, row) =>
        key === "G-04/base"
          ? {
              ...row,
              pins: [
                ...row.pins,
                { entryId: "rt-other", createdAt: "2026-10-27T00:00:09Z" },
              ],
            }
          : row,
      ),
      /G-04\/base: multiple-pins/u,
    ],
    // SP-N3: 最初が別の Entity、2 つ目が予定の seed。
    [
      "N3",
      frozenRows((key, row) =>
        key === "G-05/base" ? { ...row, pins: [other, ...row.pins] } : row,
      ),
      /G-05\/base: (mismatch|multiple-pins)/u,
    ],
    // SP-N9: archive された問いの Scene、別の project の entry。
    [
      "N9-archived",
      frozenRows((key, row) =>
        key === "G-06/base" ? { ...row, live: false } : row,
      ),
      /G-06\/base: mismatch/u,
    ],
    [
      "N9-project",
      frozenRows((key, row) =>
        key === "G-07/base"
          ? { ...row, pins: [{ ...row.pins[0], inProject: false }] }
          : row,
      ),
      /G-07\/base: mismatch/u,
    ],
    // SP-N11: unavailable を期待する variant に pin が無い。
    [
      "N11",
      frozenRows((key, row) =>
        key === "G-08/graph-index-unusable" ? { ...row, pins: [] } : row,
      ),
      /G-08\/graph-index-unusable: no-pin/u,
    ],
    // seed の runtime ID の取り違え（別の Entity の runtime ID を予定の seed とした）。
    [
      "swap",
      frozenRows((key, row) =>
        key === "G-03/base"
          ? {
              ...row,
              expectedSeed: "rt-other",
              pins: [
                { entryId: "rt-other", createdAt: "2026-10-27T00:00:01Z" },
              ],
            }
          : row,
      ),
      /G-03\/base: seed-runtime-id-mismatch/u,
    ],
  ];
  for (const [name, rows, pattern] of cases)
    assert.throws(() => frozenGate(rows), pattern, name);
  // 予定の seed の論理 ID が plan（fixture の値）と違う。
  assert.throws(
    () =>
      frozenGate(
        frozenRows((key, row) =>
          key === "G-02/base"
            ? {
                ...row,
                expectedSeedLogical: "other",
                expectedSeed: "rt-other",
                pins: [
                  { entryId: "rt-other", createdAt: "2026-10-27T00:00:01Z" },
                ],
              }
            : row,
        ),
      ),
    /G-02\/base: plan-seed-mismatch/u,
  );
  // SP-N13: receipt の自己申告（DB から読んでいない行）。
  const self = frozenRows().map(({ read, ...row }) => ({
    ...row,
    read: JSON.parse(JSON.stringify(read)),
  }));
  assert.throws(() => frozenGate(self), /self-reported/u);
  // SP-N11 と SP-N14: variant の欠け、G-01 の欠け、重なり、plan の無い呼出し。
  const all = frozenRows();
  for (const [rows, pattern] of [
    [
      all.filter((row) => row.variantId !== "graph-index-unusable"),
      /missing G-08\/graph-index-unusable/u,
    ],
    [all.filter((row) => row.caseId !== "G-01"), /missing G-01\/v1/u],
    [[...all, all[3]], /listed twice/u],
  ])
    assert.throws(() => frozenGate(rows), pattern);
  assert.throws(
    () => assertSeedPinsBeforeK64({ cases: all, plan: "frozen" }),
    /seedPlan/u,
  );
  assert.throws(() => frozenGate(all, SEED_PLAN.slice(1)), /seedPlan/u);
});

test("R5: dev の照合は dev の variant だけ（1 件以上、DB から読んだ行）", () => {
  const reads = productDbPinReads([
    {
      sceneId: "q",
      live: true,
      pins: [{ entryId: "entity-seed", createdAt: "1" }],
    },
  ]);
  const row = {
    caseId: "dev:lantern",
    querySceneId: "q",
    expectedSeed: "entity-seed",
    read: reads.q,
  };
  assert.equal(
    assertSeedPinsBeforeK64({ cases: [row], plan: "dev" }).status,
    "match",
  );
  assert.throws(
    () =>
      assertSeedPinsBeforeK64({
        cases: [{ ...row, read: { ...reads.q } }],
        plan: "dev",
      }),
    /self-reported/u,
  );
  assert.throws(
    () => assertSeedPinsBeforeK64({ cases: [], plan: "dev" }),
    /\[precheck\]/u,
  );
  assert.throws(
    () => assertSeedPinsBeforeK64({ cases: [row], plan: "other" }),
    /plan/u,
  );
});
