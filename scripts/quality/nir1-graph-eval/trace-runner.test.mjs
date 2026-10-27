// DR-CP4-TR-1、TR-2: (b) の trace の runner の Electron を使わない部分。偽の page
// の driver で操作の再生の順序（commit と query の間に harness の操作を入れない、
// A3 を親の開始の直後に読む、cycle end の直後に次の操作）、stall、閲覧中の往復、
// Main の poller の install と取り出し、admission の分岐、receipt の組立てを確かめる。
import assert from "node:assert/strict";
import { test } from "node:test";
import { devTracePlan } from "./trace-record.mjs";
import {
  TRACE_DEV_PREVIEW_PURPOSE,
  admitTraceRun,
  counterPoller,
  runTraceOperations,
} from "./trace-runner.mjs";
import { DEV_PREVIEW_PURPOSES } from "./admission.mjs";

function plan(kind, cycles = 2) {
  return devTracePlan({
    kind,
    cycles,
    querySceneId: "q",
    otherSceneId: "o",
    seedEntityId: "seed",
    materials: ["rev"],
  });
}

const RUNTIME = { scenes: { q: "rt-q", o: "rt-o" } };

/** A fake page driver: every call is logged with the fake renderer clock. */
function fakeDriver({ stallAt = null } = {}) {
  const calls = [];
  let now = 1_000;
  let seq = 0;
  const tick = (ms = 1) => (now += ms);
  const stalled = (name) =>
    stallAt === name ||
    stallAt === `${name}#${calls.filter((row) => row.name === name).length}`;
  const log = (name, input, value) => {
    calls.push({ name, input, at: now });
    return value;
  };
  return {
    calls,
    driver: {
      now: async () => now,
      caretToEnd: async () => log("caretToEnd", null, { at: tick(5) }),
      type: async (text) =>
        log("type", text, { startedAt: tick(1), endedAt: tick(50) }),
      backspace: async (count) =>
        log("backspace", count, { startedAt: tick(1), endedAt: tick(30) }),
      awaitBodyCommit: async (input) => {
        if (stalled("awaitBodyCommit"))
          return log("awaitBodyCommit", input, {
            ok: false,
            stalled: "no-autosave-commit",
          });
        return log("awaitBodyCommit", input, {
          ok: true,
          at: tick(2_000),
          sceneId: input.sceneId,
          contentVersion: 7,
        });
      },
      awaitCounted: async (input) => {
        if (stalled("awaitCounted"))
          return log("awaitCounted", input, {
            ok: false,
            stalled: "no-product-query",
          });
        seq += 1;
        return log("awaitCounted", input, {
          ok: true,
          seq,
          calledAt: tick(400),
          seed: "rt-seed",
        });
      },
      awaitCycleEnd: async (input) => {
        seq += 1;
        return log("awaitCycleEnd", input, {
          reason: "child-published",
          at: tick(100),
          lastSeq: seq,
        });
      },
      navigate: async (input) =>
        log("navigate", input, { ok: true, at: tick(1) }),
      awaitPublished: async (input) => {
        seq += 1;
        return log("awaitPublished", input, {
          ok: true,
          seq,
          at: tick(450),
          published: true,
        });
      },
    },
  };
}

test("TR-1: 編集中の再生は caret → 入力 → commit の観測 → query の観測 → A3 → cycle end の順で、commit と query の間に harness の操作を入れない", async () => {
  const { calls, driver } = fakeDriver();
  const a3 = [];
  const natives = [];
  const result = await runTraceOperations({
    plan: plan("editing", 2),
    runtime: RUNTIME,
    driver,
    mountedAt: 1_000,
    readA3: async (parentSeq) => {
      a3.push({ parentSeq, afterCall: calls.at(-1).name });
      return { parentSeq };
    },
    readNative: async () => natives.push(calls.length),
    tShowMs: 2_000,
    parentLimitMs: 30_000,
  });
  assert.equal(result.stalled, null);
  assert.deepEqual(
    calls.map((row) => row.name),
    [
      "awaitCounted",
      "awaitCycleEnd",
      "caretToEnd",
      "type",
      "awaitBodyCommit",
      "awaitCounted",
      "awaitCycleEnd",
      "caretToEnd",
      "backspace",
      "awaitBodyCommit",
      "awaitCounted",
      "awaitCycleEnd",
    ],
  );
  // A3 は親の fetch を見た直後（cycle end の前）に 1 回。
  assert.deepEqual(
    a3.map((row) => row.afterCall),
    ["awaitCounted", "awaitCounted", "awaitCounted"],
  );
  assert.equal(natives.length, 3);
  // query の観測は commit の時刻より後を探し、stall の上限は trace の file の値。
  const counted = calls.filter((row) => row.name === "awaitCounted");
  assert.equal(counted[1].input.sinceAt, calls[4].at);
  assert.equal(counted[1].input.limitMs, 10_000);
  assert.equal(counted[1].input.sceneId, "rt-q");
  assert.deepEqual(
    result.log.map((row) => row.op),
    [
      "open-scene",
      "edit",
      "confirm-autosave-commit",
      "product-query",
      "edit",
      "confirm-autosave-commit",
      "product-query",
    ],
  );
  const parents = result.log.filter((row) => Number.isInteger(row.parentSeq));
  assert.deepEqual(
    parents.map((row) => row.index),
    [0, 1, 2],
  );
  assert.deepEqual(
    Object.keys(result.a3Reads).map(Number),
    parents.map((row) => row.parentSeq),
  );
  assert.equal(result.log[1].action, "append-suffix");
  assert.equal(result.log[4].action, "remove-suffix");
});

test("TR-1: 操作の後に製品の応答が上限の内に来なければ trace-stalled で止め、それまでの記録を返す", async () => {
  const { driver } = fakeDriver({ stallAt: "awaitBodyCommit" });
  const result = await runTraceOperations({
    plan: plan("editing", 2),
    runtime: RUNTIME,
    driver,
    mountedAt: 1_000,
    readA3: async () => ({}),
    readNative: async () => {},
    tShowMs: 2_000,
    parentLimitMs: 30_000,
  });
  assert.deepEqual(result.stalled, {
    seq: 2,
    op: "confirm-autosave-commit",
    reason: "no-autosave-commit",
  });
  assert.equal(result.log.at(-1).op, "edit");
});

test("TR-1: 閲覧中の再生は seed の無い場面へ移って公開を待ち、query の場面へ戻って counted query を観測する", async () => {
  const { calls, driver } = fakeDriver();
  const result = await runTraceOperations({
    plan: plan("browsing", 2),
    runtime: RUNTIME,
    driver,
    mountedAt: 1_000,
    readA3: async () => ({}),
    readNative: async () => {},
    tShowMs: 2_000,
    parentLimitMs: 30_000,
  });
  assert.equal(result.stalled, null);
  assert.deepEqual(
    calls.map((row) => row.name),
    [
      "awaitCounted",
      "awaitCycleEnd",
      "navigate",
      "awaitPublished",
      "navigate",
      "awaitCounted",
      "awaitCycleEnd",
      "navigate",
      "awaitPublished",
      "navigate",
      "awaitCounted",
      "awaitCycleEnd",
    ],
  );
  assert.deepEqual(calls[2].input, { sceneId: "rt-o" });
  assert.deepEqual(calls[4].input, { sceneId: "rt-q" });
  assert.equal(calls[5].input.sinceAt, calls[4].at);
  assert.equal(result.log.filter((row) => row.op === "navigate").length, 4);
});

test("TR-1: 親が guard の内に返らなければ（cycle end が harness-limit）stall にする", async () => {
  const { driver } = fakeDriver();
  driver.awaitCycleEnd = async () => ({
    reason: "harness-limit",
    at: 0,
    lastSeq: 1,
  });
  const result = await runTraceOperations({
    plan: plan("editing", 1),
    runtime: RUNTIME,
    driver,
    mountedAt: 1_000,
    readA3: async () => ({}),
    readNative: async () => {},
    tShowMs: 2_000,
    parentLimitMs: 30_000,
  });
  assert.equal(result.stalled.reason, "parent-never-returned");
});

test("TR-2: Main の poller は評価の入口の module を読み込んで install し、drain と stop を同じ app.evaluate で呼ぶ", async () => {
  const seen = [];
  const app = {
    evaluate: async (fn, arg) => {
      seen.push({ source: String(fn), arg });
      if (String(fn).includes("setInterval"))
        return JSON.stringify({ installed: true, intervalMs: arg[1] });
      if (String(fn).includes("clearInterval"))
        return JSON.stringify({ stopped: true, polls: 3 });
      return JSON.stringify({ installed: true, polls: 3, errors: 0, runs: [] });
    },
  };
  const poller = counterPoller({ app, nativePath: "/x/grimodex-node.node" });
  assert.deepEqual(await poller.install(), { installed: true, intervalMs: 5 });
  assert.equal(seen[0].arg[0], "/x/grimodex-node.node");
  assert.ok(seen[0].arg[2].includes("lateCached"));
  assert.equal((await poller.stop()).stopped, true);
  assert.equal((await poller.drain()).polls, 3);
});

test("TR-1: admission は dev の予告だけを通し、凍結した trace は S6 の配線まで [precheck] で止める", () => {
  assert.ok(DEV_PREVIEW_PURPOSES.includes(TRACE_DEV_PREVIEW_PURPOSE));
  assert.throws(
    () => admitTraceRun({ root: "/r", fixture: { kind: "frozen" } }),
    /\[precheck\].*S6/u,
  );
  assert.throws(
    () => admitTraceRun({ root: "/r", fixture: {} }),
    /\[precheck\]/u,
  );
});
