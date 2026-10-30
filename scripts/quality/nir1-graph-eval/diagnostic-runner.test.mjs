// DR-CP4-O-1 (4): SP-P4 の runner の Electron を使わない部分。注入した setup と
// 側の測定で、試行の取り直し、2 回目の無効の [precheck]、同じ workspace の中の
// 不一致、SP-N7 で止まること、8 variant の要約を確かめる。
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEV_PREVIEW_PURPOSES } from "./admission.mjs";
import {
  SP_P4_DEV_PREVIEW_PURPOSE,
  runSpP4,
  spP4ReceiptDesign,
} from "./diagnostic-runner.mjs";
import {
  SP_P4,
  SP_P4_COMPARISON_RULE,
  SP_P4_IR_TIMEOUT_LIMIT,
  assertSpP4Passed,
  spP4SampleRecord,
  spP4Schedule,
} from "./frozen-diagnostics.mjs";

const schedule = spP4Schedule({ warmup: 5, measured: 30 });
const targets = SP_P4.variants.map((key) => ({
  variantKey: key,
  caseId: key.split("/")[0],
  variantId: key.split("/")[1],
  querySceneId: "q",
}));

function sideScenes(side) {
  const tag = side === "with-seed-pin-step" ? "w" : "o";
  return { q: `${tag}-q`, a: `${tag}-a`, b: `${tag}-b`, c: `${tag}-c` };
}

function samplesFor(side, change = () => ({})) {
  const scenes = sideScenes(side);
  return schedule.map((at, index) => {
    const patch = change(at, index) ?? {};
    return spP4SampleRecord({
      ...at,
      measure: {
        status: "completed",
        rawSceneIds: patch.raw ?? [scenes.a, scenes.b],
        resultSceneIds: patch.result ?? [scenes.a, scenes.b, scenes.c],
        resultKind: patch.ir === "timeout" ? "raw" : "fused",
        completion: {
          outcome: patch.ir ?? "ir-ready",
          deadlineExceeded: patch.ir === "timeout",
        },
      },
      denseHitSceneIds: [scenes.b, scenes.a],
      sparseSceneIds: [scenes.a],
      before: { begins: 2, cacheHits: 0, lateCached: 0 },
      after: { begins: patch.begins ?? 2, cacheHits: 0, lateCached: 0 },
      scenes,
    });
  });
}

function fake(plan = () => undefined) {
  const calls = [];
  return {
    calls,
    setupVariant: async (target) => {
      calls.push(["setup", target.variantKey]);
      return {
        sides: Object.fromEntries(
          SP_P4.sides.map((side) => [side, { summary: { side } }]),
        ),
      };
    },
    measureSide: async ({ target, side, attempt }) => {
      calls.push(["measure", target.variantKey, side, attempt]);
      const change = plan(target.variantKey, side, attempt);
      return {
        samples: samplesFor(side, change),
        d2aMode: "restricted",
        logicalToRuntime: { scenes: sideScenes(side) },
      };
    },
  };
}

const run = (driver) =>
  runSpP4({ targets, schedule, warmup: 5, measured: 30, ...driver });

test("O-1 (4): 8 variant の両側が一致すれば passed（setup の後に側ごとに 1 試行）", async () => {
  const driver = fake();
  const result = await run(driver);
  assert.equal(result.summary.status, "passed");
  assert.equal(result.stop, null);
  assert.equal(assertSpP4Passed(result.summary).status, "passed");
  assert.equal(driver.calls.filter((row) => row[0] === "measure").length, 16);
  assert.deepEqual(driver.calls.slice(0, 3), [
    ["setup", "G-01/v1"],
    ["measure", "G-01/v1", "without-seed-pin-step", 1],
    ["measure", "G-01/v1", "with-seed-pin-step", 1],
  ]);
  // 各試行の sample をすべて残す。
  const side = result.variants[0].sides["with-seed-pin-step"];
  assert.equal(side.attempts[0].samples.length, 35);
  assert.deepEqual(side.setup, { side: "with-seed-pin-step" });
});

test("O-1 (4): begins の差分が 0 でない試行は 1 回だけ取り直し、2 回目も無効なら [precheck] で止める", async () => {
  const retake = await run(
    fake((key, side, attempt) =>
      key === "G-03/base" && side === "without-seed-pin-step" && attempt === 1
        ? (at) =>
            at.phase === "measured" && at.repeat === 4 ? { begins: 3 } : {}
        : undefined,
    ),
  );
  assert.equal(retake.summary.status, "passed");
  const attempts = retake.variants[2].sides["without-seed-pin-step"].attempts;
  assert.deepEqual(
    attempts.map((row) => [row.attempt, row.valid, row.outcome]),
    [
      [1, false, "retake"],
      [2, true, "accepted"],
    ],
  );
  assert.deepEqual(attempts[0].invalidSamples, [
    { phase: "measured", repeat: 4, beginsDelta: 1 },
  ]);
  const driver = fake((key, side) =>
    key === "G-02/base" && side === "with-seed-pin-step"
      ? () => ({ begins: 5 })
      : undefined,
  );
  const stopped = await run(driver);
  assert.match(
    stopped.stop,
    /\[precheck\] SP-P4 G-02\/base with-seed-pin-step/u,
  );
  assert.equal(stopped.summary.status, "precheck");
  // 止めた後の variant は測らない。
  assert.ok(!driver.calls.some((row) => row[1] === "G-03/base"));
  assert.throws(() => assertSpP4Passed(stopped.summary), /\[precheck\]/u);
});

test("O-1 (4): 両側が 1 sample でも違えば SP-N7 で止め、後の variant を測らない", async () => {
  const driver = fake((key, side) =>
    key === "G-04/base" && side === "with-seed-pin-step"
      ? (at) =>
          at.phase === "measured"
            ? { raw: ["w-b", "w-a"], result: ["w-b", "w-a", "w-c"] }
            : {}
      : undefined,
  );
  const result = await run(driver);
  assert.equal(result.summary.status, "sp-n7");
  assert.equal(result.variants.at(-1).variantKey, "G-04/base");
  assert.equal(result.variants.at(-1).comparison.same, false);
  assert.ok(!driver.calls.some((row) => row[1] === "G-05/base"));
  assert.throws(() => assertSpP4Passed(result.summary), /SP-N7/u);
});

test("O-1 (4): 同じ workspace の measured の sample どうしが違えば比較の前に [precheck] で止め、記録は残す（current の規則）", async () => {
  const result = await run({
    ...fake((key, side) =>
      key === "G-01/v1" && side === "without-seed-pin-step"
        ? (at) =>
            at.phase === "measured" && at.repeat === 10
              ? { result: ["o-a", "o-b"], ir: "timeout" }
              : {}
        : undefined,
    ),
    rule: "current",
  });
  assert.match(
    result.stop,
    /\[precheck\].*G-01\/v1:without-seed-pin-step.*\(rIrSceneIds, irSupplementSceneId\)/u,
  );
  assert.equal(result.summary.status, "incomplete");
  assert.equal(result.variants.length, 1);
  assert.equal(
    result.variants[0].sides["without-seed-pin-step"].unstable,
    true,
  );
  // 判定とは別の開示: IR の期限切れの頻度と、不一致が期限切れだけで説明できるか。
  const side = result.variants[0].sides["without-seed-pin-step"];
  assert.equal(side.attempts[0].ir.measured.notReady, 1);
  assert.deepEqual(side.attempts[0].ir.notReadySamples, [
    {
      phase: "measured",
      repeat: 10,
      outcome: "timeout",
      deadlineExceeded: true,
      resultKind: "raw",
    },
  ]);
  assert.equal(side.instability.explainedByIrDeadline, true);
  assert.equal(side.instability.differing, 1);
  assert.equal(
    result.variants[0].sides["without-seed-pin-step"].attempts[0].samples
      .length,
    35,
  );
});

test("O-1 (1): SP-P4 の dev の予告は dev preview の目的に登録されている（diag-registration と同じ登録）", () => {
  assert.ok(DEV_PREVIEW_PURPOSES.includes(SP_P4_DEV_PREVIEW_PURPOSE));
});

test("Q-1: 既定の規則では期限切れだけの sample は IR の比較から外して passed、外した数を側ごとに開示し、failed は外さず止める", async () => {
  const timeoutAt =
    (repeats, ir = "timeout") =>
    (key, side) =>
      key === "G-01/v1" && side === "with-seed-pin-step"
        ? (at) =>
            at.phase === "measured" && repeats.includes(at.repeat)
              ? { result: ["w-a", "w-b"], ir }
              : {}
        : undefined;
  const passed = await run(fake(timeoutAt([10, 20])));
  assert.equal(passed.stop, null);
  assert.equal(passed.summary.status, "passed");
  const side = passed.variants[0].sides["with-seed-pin-step"];
  assert.deepEqual(
    [side.stability.irTimeoutExcluded, side.stability.irCompared],
    [2, 28],
  );
  assert.equal(side.attempts[0].ir.measured.timeoutExcluded, 2);
  assert.deepEqual(passed.variants[0].comparison.irTimeouts, {
    without: 0,
    with: 2,
  });
  // 7 件は上限を超えて [precheck]（SP-N7 でない）。
  const over = await run(fake(timeoutAt([1, 2, 3, 4, 5, 6, 7])));
  assert.match(over.stop, /\[precheck\].*7 of 30 .*more than 6/u);
  assert.notEqual(over.summary.status, "sp-n7");
  // failed は外さない（同じ workspace の中の不一致で [precheck]）。
  const failed = await run(fake(timeoutAt([10], "failed")));
  assert.match(failed.stop, /\[precheck\].*measured 10 differs/u);
});

test("Q-1 (C2): receipt の design は規則と期限切れの上限（gate が照合する欄）を書く", () => {
  const design = spP4ReceiptDesign({ targets, warmup: 5, measured: 30 });
  assert.equal(design.rule, SP_P4_COMPARISON_RULE);
  assert.equal(design.rule, "ir-complete-pairs");
  assert.equal(design.irTimeoutLimit, SP_P4_IR_TIMEOUT_LIMIT);
  assert.equal(design.irTimeoutLimit, 6);
  assert.deepEqual(design.variants, SP_P4.variants);
});
