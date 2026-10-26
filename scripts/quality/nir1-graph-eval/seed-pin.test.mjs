// R5（K6/4:196）の seed の pin の照合。合成の記録だけ。凍結した G-case の材料は
// 読まない（実 fixture の照合は S5 の前の別工程）。
import assert from "node:assert/strict";
import { test } from "node:test";
import { GRAPH_EVAL_VARIANTS } from "./constants.mjs";
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

test("R5: 一致しない／確かめられないなら K6/4 の判定を始めない（[precheck]、CP-0 の側で扱う）", () => {
  const all = FROZEN_SEED_CASE_IDS.map((caseId) =>
    scene([pin("entity-seed", 1)], { caseId }),
  );
  assert.deepEqual(FROZEN_SEED_CASE_IDS, [
    ...new Set(GRAPH_EVAL_VARIANTS.map((row) => row.caseId)),
  ]);
  const passed = assertSeedPinsBeforeK64({ cases: all, plan: "frozen" });
  assert.equal(passed.status, "match");
  assert.ok(Object.isFrozen(passed) && Object.isFrozen(passed.rows));
  for (const cases of [
    all.slice(1),
    [...all.slice(1), scene([pin("other", 1)], { caseId: "G-01" })],
    [...all.slice(1), scene(null, { caseId: "G-01" })],
    [...all, scene([pin("entity-seed", 1)], { caseId: "G-02" })],
  ])
    assert.throws(
      () => assertSeedPinsBeforeK64({ cases, plan: "frozen" }),
      /\[precheck\].*R5/,
    );
  // dev の照合は dev の case だけ（1 件以上）。
  assert.equal(
    assertSeedPinsBeforeK64({
      cases: [scene([pin("entity-seed", 1)], { caseId: "dev:lantern" })],
      plan: "dev",
    }).status,
    "match",
  );
  assert.throws(
    () => assertSeedPinsBeforeK64({ cases: [], plan: "dev" }),
    /\[precheck\]/,
  );
  assert.throws(
    () => assertSeedPinsBeforeK64({ cases: all, plan: "other" }),
    /plan/,
  );
});
