import assert from "node:assert/strict";
import test from "node:test";
import {
  assertRunnable,
  checkpointSceneCount,
  opaqueWorkId,
  queryPositions,
} from "./raw-fullness.mjs";
import { analyze, wilson } from "./analyze.mjs";

test("地点の Scene 数と query の位置", () => {
  assert.deepEqual(
    [0.25, 0.5, 0.75, 1].map((f) => checkpointSceneCount(f, 18)),
    [5, 9, 14, 18],
  );
  assert.equal(checkpointSceneCount(0.25, 3), 2);
  assert.deepEqual(queryPositions(5), [2, 3, 4, 5]);
  assert.deepEqual(queryPositions(14), [5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
});

test("作品の ID は salt ごとに変わる", () => {
  assert.notEqual(opaqueWorkId("a", "k"), opaqueWorkId("b", "k"));
  assert.match(opaqueWorkId("a", "k"), /^[0-9a-f]{16}$/);
});

test("本番の作品は事前登録が無いと走らない", async () => {
  assert.deepEqual(await assertRunnable("trial", {}), {
    role: "trial",
    preregistration: null,
  });
  await assert.rejects(assertRunnable("main", {}), /preregistration/);
});

test("集計：満杯率・≤6・≤5 と D0", () => {
  const q = (rawCount, status = "ok") => ({
    evidenceScope: "not-cp4-evidence",
    opaqueWorkId: "w",
    checkpoint: 1,
    status,
    rawCount,
    repeatStable: true,
    top30: { laterScene: 1, sameScene: 2, earlierDistinctScenes: 3 },
  });
  const summary = analyze([
    {
      schemaVersion: "fusion-slot-raw-fullness/1",
      evidenceScope: "not-cp4-evidence",
      role: "trial",
      language: "ja",
      errors: [],
      checkpoints: [
        { queries: [q(8), q(8), q(6), q(5), q(0), q(null, "failed")] },
      ],
    },
  ]);
  assert.equal(summary.overall.ok, 5);
  assert.equal(summary.overall.failed, 1);
  assert.equal(summary.overall.full8.count, 2);
  assert.equal(summary.overall.atMost6.count, 3);
  assert.equal(summary.overall.atMost5.count, 2);
  assert.equal(summary.decision.D0.undecidable, true);
  const [low, high] = wilson(2, 5);
  assert.ok(low < 0.4 && high > 0.4);
});
