import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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

test("記憶の対照の AI 原稿は本番と同じく事前登録が要り、知らない role は拒む", async () => {
  await assert.rejects(assertRunnable("control-ai-gen", {}), /preregistration/);
  await assert.rejects(assertRunnable("control", {}), /unknown role/);
  const dir = await mkdtemp(path.join(os.tmpdir(), "prereg-"));
  try {
    const confirmed = path.join(dir, "confirmed.md");
    await writeFile(confirmed, "# 事前登録（確定）\n");
    const digest = createHash("sha256")
      .update(await readFile(confirmed))
      .digest("hex");
    assert.deepEqual(
      await assertRunnable("control-ai-gen", {
        preregistration: confirmed,
        "preregistration-sha256": digest,
      }),
      {
        role: "control-ai-gen",
        preregistration: { path: confirmed, sha256: digest },
      },
    );
    const draft = path.join(dir, "draft.md");
    await writeFile(draft, "# 事前登録（下書き）\n");
    const draftDigest = createHash("sha256")
      .update(await readFile(draft))
      .digest("hex");
    await assert.rejects(
      assertRunnable("control-ai-gen", {
        preregistration: draft,
        "preregistration-sha256": draftDigest,
      }),
      /下書き/,
    );
    await assert.rejects(
      assertRunnable("control-ai-gen", {
        preregistration: confirmed,
        "preregistration-sha256": draftDigest,
      }),
      /sha256/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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
