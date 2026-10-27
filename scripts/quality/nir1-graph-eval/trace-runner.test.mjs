// DR-CP4-TR-1、TR-2: (b) の trace の runner の Electron を使わない部分。偽の page
// の driver で操作の再生の順序（commit と query の間に harness の操作を入れない、
// A3 を親の開始の直後に読む、cycle end の直後に次の操作）、stall、閲覧中の往復、
// Main の poller の install と取り出し、admission の分岐、receipt の組立てを確かめる。
import assert from "node:assert/strict";
import { test } from "node:test";
import { URL } from "node:url";
import {
  TRACE_MAINTENANCE_FORBIDDEN,
  devTracePlan,
  traceMaintenanceEnv,
} from "./trace-record.mjs";
import {
  TRACE_DEV_PREVIEW_PURPOSE,
  admitTraceRun,
  counterPoller,
  checkTraceAttempt,
  runTraceOperations,
  traceAttemptOutcome,
  traceMaintenanceStart,
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
    advance: (ms) => tick(ms),
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

test("TR-1／O-1 (6): admission は dev の予告を通し、凍結した trace は admitGraphCaseRun の admission が無ければ [precheck] で止める", () => {
  assert.ok(DEV_PREVIEW_PURPOSES.includes(TRACE_DEV_PREVIEW_PURPOSE));
  assert.throws(
    () => admitTraceRun({ root: "/r", fixture: { kind: "frozen" } }),
    /\[precheck\].*admitGraphCaseRun/u,
  );
  // dev の予告の admission は凍結の trace に使えない。
  assert.throws(
    () =>
      admitTraceRun({
        root: "/r",
        fixture: { kind: "frozen" },
        admission: { kind: "dev-preview", purpose: TRACE_DEV_PREVIEW_PURPOSE },
      }),
    /\[precheck\]/u,
  );
  assert.throws(
    () => admitTraceRun({ root: "/r", fixture: {} }),
    /\[precheck\]/u,
  );
});

test("TR-9: 開始時の封印は親の begin の前（編集中は commit の観測の後、閲覧中は場面の移動の後、最初の query は mount の前の読取）に 1 回読み、query の番号に結び、読取の前後に renderer の時刻を取る", async () => {
  for (const kind of ["editing", "browsing"]) {
    const { calls, driver, advance } = fakeDriver();
    const sealCalls = [];
    const result = await runTraceOperations({
      plan: plan(kind, 2),
      runtime: RUNTIME,
      driver,
      mountedAt: 1_000,
      openSeal: { read: "ok", b: null, startedAt: 1, finishedAt: 2 },
      readSeal: async () => {
        sealCalls.push(calls.at(-1).name);
        advance(7);
        return { read: "ok", b: { generation: 1, dirty: false } };
      },
      readA3: async () => ({}),
      readNative: async () => {},
      tShowMs: 2_000,
      parentLimitMs: 30_000,
    });
    // Before each query (after the commit / the move) and after its parent
    // was observed (レビュー P2-1).
    assert.deepEqual(
      sealCalls,
      kind === "editing"
        ? [
            "awaitCounted",
            "awaitBodyCommit",
            "awaitCounted",
            "awaitBodyCommit",
            "awaitCounted",
          ]
        : [
            "awaitCounted",
            "navigate",
            "awaitCounted",
            "navigate",
            "awaitCounted",
          ],
      kind,
    );
    assert.deepEqual(Object.keys(result.startSeals).map(Number), [0, 1, 2]);
    assert.equal(result.startSeals[0].before.finishedAt, 2);
    for (const index of [0, 1, 2])
      assert.deepEqual(Object.keys(result.startSeals[index]).sort(), [
        "after",
        "before",
      ]);
    // Every read is in the log as a seal-read (an event, not an operation).
    assert.equal(result.log.filter((row) => row.op === "seal-read").length, 6);
    // The renderer time after the read (the read took 7 ms of the fake clock).
    assert.equal(
      result.startSeals[1].before.finishedAt -
        result.startSeals[1].before.startedAt,
      7,
    );
    // The read is before the counted query is looked for.
    const counted = calls.filter((row) => row.name === "awaitCounted");
    assert.ok(result.startSeals[2].before.finishedAt <= counted[2].at);
  }
});

test("TR-10: trace の測定の起動にだけ S2 の maintenance の gate の env（CI、owner token、起動ごとの nonce、B-ROUTE の trigger）が入り、定常状態の起動の env は変わらない", async () => {
  const { launch } = await import("./dprime-check.mjs");
  const { readFile } = await import("node:fs/promises");
  const seen = [];
  const start = async (args) => {
    seen.push(args.extraEnv);
    return {
      evidence: { problems: [] },
      addon: async () =>
        JSON.stringify({
          registrations: 1,
          worker: { state: "configured" },
          gateOpened: true,
          owner: { profile: { restricted: true, inFlightStopped: true } },
        }),
      stop: async () => ({}),
    };
  };
  const options = {
    "eval-build": "/x",
    "ja-model": "j",
    "en-model": "e",
    run: "r",
  };
  const nonce = "0f8fad5b-d9cb-469f-a165-70867728950e";
  await launch({ label: "measure", runDir: "/r", options, start });
  await launch({
    label: "measure",
    runDir: "/r",
    options,
    start: traceMaintenanceStart(start, nonce),
  });
  const [steady, trace] = seen;
  assert.equal(steady.GRIMODEX_PRODUCT_JOURNEY_MAINTENANCE_TRIGGER, undefined);
  assert.equal(steady.GRIMODEX_PRODUCT_JOURNEY_MAINTENANCE_NONCE, undefined);
  assert.equal(trace.CI, "true");
  assert.equal(
    trace.GRIMODEX_PRODUCT_JOURNEY_MAINTENANCE_TRIGGER,
    "nir1-graph-index-build",
  );
  assert.equal(trace.GRIMODEX_PRODUCT_JOURNEY_MAINTENANCE_NONCE, nonce);
  // The owner token is the product source's public constant (S2: 「source の
  // 公開の定数」).
  const source = await readFile(
    new URL(
      "../../../electron/main/narrativeMaintenanceCiSeam.ts",
      import.meta.url,
    ),
    "utf8",
  );
  const token = /NARRATIVE_MAINTENANCE_OWNER_TOKEN =\s*"([^"]+)"/u.exec(
    source,
  )[1];
  assert.equal(trace.GRIMODEX_PRODUCT_JOURNEY_MAINTENANCE_OWNER_TOKEN, token);
  // The body declaration seam of the measurement launch is kept.
  for (const key of Object.keys(steady)) assert.ok(key in trace, key);
  // S2 forbiddenSeamOptions never enter.
  for (const key of TRACE_MAINTENANCE_FORBIDDEN)
    assert.equal(trace[key], undefined, key);
  assert.throws(
    () =>
      traceMaintenanceEnv({
        nonce,
        base: {
          CI: "true",
          GRIMODEX_PRODUCT_JOURNEY_MAINTENANCE_SETUP: "disabled",
        },
      }),
    /\[precheck\].*SETUP/u,
  );
  assert.throws(
    () => traceMaintenanceEnv({ nonce: "x", base: { CI: "true" } }),
    /\[precheck\].*nonce/u,
  );
  // k64-runner and runner never use the trace's launch.
  for (const file of ["k64-runner.mjs", "runner.mjs"])
    assert.doesNotMatch(
      await readFile(new URL(file, import.meta.url), "utf8"),
      /traceMaintenance/u,
      file,
    );
});

test("レビュー P3 (b): 閲覧中の Q の外の移動には parentSeq を付けず、counted query の数は plannedQ と同じ", async () => {
  const { driver } = fakeDriver();
  const browsing = plan("browsing", 3);
  const result = await runTraceOperations({
    plan: browsing,
    runtime: RUNTIME,
    driver,
    mountedAt: 1_000,
    readA3: async () => ({}),
    readNative: async () => {},
    tShowMs: 2_000,
    parentLimitMs: 30_000,
  });
  const withParent = result.log.filter((row) =>
    Number.isInteger(row.parentSeq),
  );
  assert.equal(withParent.length, browsing.plannedQ);
  assert.ok(
    withParent.every((row) => row.op !== "navigate"),
    "a move carries no parent",
  );
  assert.deepEqual(
    withParent.map((row) => row.index),
    [0, 1, 2, 3],
  );
  // The outside-Q move to the other Scene is logged with its publish.
  const moves = result.log.filter(
    (row) => row.op === "navigate" && row.sceneId === "rt-o",
  );
  assert.equal(moves.length, 3);
  assert.ok(moves.every((row) => row.published && row.parentSeq === undefined));
});

test("レビュー P3 (d): --attempt は 1 から attemptLimit まで、最後の試行の stall は [precheck]、それより前の stall は取り直し", () => {
  assert.equal(checkTraceAttempt({ attempt: 1, attemptLimit: 2 }), 1);
  for (const attempt of [0, 3, 1.5, Number.NaN])
    assert.throws(
      () => checkTraceAttempt({ attempt, attemptLimit: 2 }),
      /\[precheck\].*--attempt/u,
    );
  assert.throws(
    () => checkTraceAttempt({ attempt: 1, attemptLimit: 0 }),
    /attemptLimit/u,
  );
  const stalled = { reason: "no-product-query" };
  assert.equal(
    traceAttemptOutcome({ attempt: 1, attemptLimit: 2, stalled }),
    "retake",
  );
  assert.equal(
    traceAttemptOutcome({ attempt: 2, attemptLimit: 2, stalled }),
    "precheck",
  );
  assert.equal(
    traceAttemptOutcome({ attempt: 2, attemptLimit: 2, stalled: null }),
    "completed",
  );
});
