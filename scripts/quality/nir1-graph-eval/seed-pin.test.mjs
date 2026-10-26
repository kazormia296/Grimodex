// R5（K6/4:196）の seed の pin の照合と、SP/1（graph-case-seed-pin-setup）の
// variant ごとの照合。合成の記録と一時の DB だけ。凍結した G-case の材料は読まない
// （実 fixture の照合は S5 の前の別工程）。
import assert from "node:assert/strict";
import { test } from "node:test";
import { GRAPH_EVAL_VARIANTS } from "./constants.mjs";
import { seedPinWorkspace } from "./test-support.mjs";
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
 * S1g-A (SP/1 SP-P3) / P2-1: the frozen plan's rows, one variant workspace
 * each (its own DB and setup receipt). `change(variantKey, spec)` alters a
 * workspace before it is written.
 */
function frozenSpecs(change = (_key, spec) => spec) {
  return GRAPH_EVAL_VARIANTS.map((variant) =>
    change(variant.key, {
      caseId: variant.caseId,
      variantId: variant.variantId,
      fixtureKind: "frozen",
      querySceneLogical: `${variant.caseId}-query`,
      querySceneRuntime: `${variant.key}/query`,
      seedLogical: `${variant.caseId}-seed`,
      seedRuntime: `rt-${variant.key}`,
      entities: { other: "rt-other" },
      live: true,
      pins: [
        { entryId: `rt-${variant.key}`, createdAt: "2026-10-27T00:00:01Z" },
      ],
    }),
  );
}

function frozenRows(change) {
  return frozenSpecs(change).map((spec) => {
    const workspace = seedPinWorkspace(spec);
    return {
      caseId: spec.caseId,
      variantId: spec.variantId,
      setup: workspace.setup,
      read: workspace.read,
    };
  });
}

const SEED_PLAN = GRAPH_EVAL_VARIANTS.map((variant) => ({
  caseId: variant.caseId,
  variantId: variant.variantId,
  querySceneId: `${variant.caseId}-query`,
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

test("R5／SP-N1〜N3、N9、N11、N13、N14: 不一致・2 つ以上・pin なし・自己申告・variant や G-01 の欠けは [precheck]", () => {
  const other = { entryId: "rt-other", createdAt: "2026-10-27T00:00:00Z" };
  const on = (target, change) => (key, spec) =>
    key === target ? { ...spec, ...change(spec) } : spec;
  for (const [name, rows, pattern] of [
    [
      "N1",
      frozenRows(on("G-02/base", () => ({ pins: [other] }))),
      /G-02\/base: mismatch/u,
    ],
    [
      "N2",
      frozenRows(
        on("G-04/base", (spec) => ({
          pins: [
            ...spec.pins,
            { entryId: "rt-other", createdAt: "2026-10-27T00:00:09Z" },
          ],
        })),
      ),
      /G-04\/base: multiple-pins/u,
    ],
    [
      "N3",
      frozenRows(on("G-05/base", (spec) => ({ pins: [other, ...spec.pins] }))),
      /G-05\/base: (mismatch|multiple-pins)/u,
    ],
    [
      "N9-archived",
      frozenRows(on("G-06/base", () => ({ live: false }))),
      /G-06\/base: mismatch/u,
    ],
    [
      "N9-project",
      frozenRows(
        on("G-07/base", (spec) => ({
          pins: [{ ...spec.pins[0], inProject: false }],
        })),
      ),
      /G-07\/base: mismatch/u,
    ],
    [
      "N11",
      frozenRows(on("G-08/graph-index-unusable", () => ({ pins: [] }))),
      /G-08\/graph-index-unusable: no-pin/u,
    ],
  ])
    assert.throws(() => frozenGate(rows), pattern, name);
  // 予定の seed の論理 ID を plan（fixture の値）と違う Entity にした setup。
  assert.throws(
    () =>
      frozenGate(
        frozenRows(on("G-03/base", () => ({ seedLogical: "other-seed" }))),
      ),
    /G-03\/base: seed-not-mapped/u,
  );
  // SP-N13: receipt の自己申告（封印の無い読取、封印の無い setup）。
  const all = frozenRows();
  assert.throws(
    () =>
      frozenGate(
        all.map((row) => ({
          ...row,
          read: JSON.parse(JSON.stringify(row.read)),
        })),
      ),
    /self-reported/u,
  );
  assert.throws(
    () => frozenGate(all.map((row) => ({ ...row, setup: { ...row.setup } }))),
    /setup-self-reported/u,
  );
  // SP-N11 と SP-N14: variant の欠け、G-01 の欠け、重なり、plan の無い呼出し。
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

test("P2-1: 封印した読取は DB・project・Scene に束縛され、使い回し・別の Scene・別の workspace・呼出し側の対応表は通らない", () => {
  const all = frozenRows();
  // 1 つの workspace の読取を G-01〜G-03 に使い回す（配線の誤りで 1 つだけ読む）。
  const reused = all.map((row, at) =>
    at < 3 ? { ...row, read: all[0].read } : row,
  );
  assert.throws(
    () => frozenGate(reused),
    /read-of-another-scene|workspace-reused/u,
  );
  const shared = all.map((row, at) =>
    at < 3 ? { ...row, read: all[0].read, setup: all[0].setup } : row,
  );
  assert.throws(
    () => frozenGate(shared),
    /workspace-reused|setup-of-another-variant/u,
  );
  // 同じ DB の別の Scene を読んだ。
  const [wrongScene] = frozenSpecs()
    .slice(1, 2)
    .map((spec) =>
      seedPinWorkspace({
        ...spec,
        otherScenes: ["elsewhere"],
        readSceneId: "elsewhere",
      }),
    );
  assert.throws(
    () =>
      frozenGate(
        all.map((row, at) =>
          at === 1 ? { ...row, read: wrongScene.read } : row,
        ),
      ),
    /G-02\/base: read-of-another-scene/u,
  );
  // 受領書の cold DB と違う workspace（別の DB）を読んだ。
  const [otherDb] = frozenSpecs()
    .slice(2, 3)
    .map((spec) => seedPinWorkspace(spec));
  assert.throws(
    () =>
      frozenGate(
        all.map((row, at) => (at === 2 ? { ...row, read: otherDb.read } : row)),
      ),
    /G-03\/base: read-of-another-workspace/u,
  );
  // 別の variant の setup の受領書。
  assert.throws(
    () =>
      frozenGate(
        all.map((row, at) =>
          at === 4 ? { ...row, setup: all[5].setup } : row,
        ),
      ),
    /setup-of-another-variant/u,
  );
  // 呼出し側が runtime の seed と対応表を渡しても使わない（setup の受領書から取る）。
  const forged = frozenRows((key, spec) =>
    key === "G-06/base"
      ? { ...spec, pins: [{ entryId: "rt-other", createdAt: "1" }] }
      : spec,
  ).map((row) =>
    row.caseId === "G-06"
      ? {
          ...row,
          expectedSeed: "rt-other",
          entityRuntimeIds: { "G-06-seed": "rt-other" },
        }
      : row,
  );
  assert.throws(() => frozenGate(forged), /G-06\/base: mismatch/u);
});

test("R5: dev の照合は dev の workspace だけ（1 件以上、受領書と DB の読取）", () => {
  const workspace = seedPinWorkspace({
    caseId: "dev:lantern",
    fixtureKind: "dev",
    querySceneLogical: "q",
    querySceneRuntime: "q",
    seedLogical: "seed",
    seedRuntime: "entity-seed",
    live: true,
    pins: [{ entryId: "entity-seed", createdAt: "1" }],
  });
  const row = {
    caseId: "dev:lantern",
    setup: workspace.setup,
    read: workspace.read,
    querySceneLogical: "q",
    expectedSeedLogical: "seed",
  };
  assert.equal(
    assertSeedPinsBeforeK64({ cases: [row], plan: "dev" }).status,
    "match",
  );
  assert.throws(
    () =>
      assertSeedPinsBeforeK64({
        cases: [{ ...row, read: { ...workspace.read } }],
        plan: "dev",
      }),
    /self-reported/u,
  );
  // 凍結の setup の受領書は dev の照合に使えない（逆も同じ）。
  assert.throws(
    () =>
      assertSeedPinsBeforeK64({
        cases: [{ ...row, setup: frozenRows()[0].setup }],
        plan: "dev",
      }),
    /setup-of-another-kind/u,
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
