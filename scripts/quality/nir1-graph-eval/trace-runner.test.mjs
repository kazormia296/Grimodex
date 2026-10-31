// DR-CP4-TR-1、TR-2: (b) の trace の runner の Electron を使わない部分。偽の page
// の driver で操作の再生の順序（commit と query の間に harness の操作を入れない、
// A3 を親の開始の直後に読む、cycle end の直後に次の操作）、stall、閲覧中の往復、
// Main の poller の install と取り出し、admission の分岐、receipt の組立てを確かめる。
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { writeRunHead } from "./frozen-diagnostics.mjs";
import { URL } from "node:url";
import {
  TRACE_MAINTENANCE_FORBIDDEN,
  devTracePlan,
  traceMaintenanceEnv,
} from "./trace-record.mjs";
import {
  TRACE_DEV_PREVIEW_PURPOSE,
  admitTraceRun,
  captureBodyNonce,
  confirmTraceDeclaration,
  counterPoller,
  recordTraceSetupFailure,
  startFrozenTrace,
  frozenContext,
  checkTraceAttempt,
  runTraceDeclaration,
  runTraceOperations,
  traceAttemptOutcome,
  traceMaintenanceStart,
  traceMaterialResolver,
} from "./trace-runner.mjs";
import { DEV_PREVIEW_PURPOSES } from "./admission.mjs";
import { loadFrozenSetupPlans } from "./frozen-setup-plan.mjs";
import { typedRevisionMaterials } from "./material-revision.mjs";
import { TRACE_PROJECT } from "./trace-frozen.mjs";

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

test("O-1 (6): trace の起動の body declaration の nonce を保ち、宣言の段は Index の前後と seam の受領書を記録し、mount の前に current を照合する", async () => {
  const sink = { nonce: null };
  const started = [];
  const start = captureBodyNonce(async (args) => {
    started.push(args);
    return "session";
  }, sink);
  assert.equal(
    await start({ extraEnv: { GRIMODEX_BODY_DECLARATION_CI_NONCE: "n-1" } }),
    "session",
  );
  assert.equal(sink.nonce, "n-1");
  assert.equal(started.length, 1);
  const state = (token, effective = true) => ({
    ok: true,
    snapshot: {
      declarationToken: token,
      state: { kind: "declared", effective },
    },
  });
  let declared = false;
  let currentToken = "t-1";
  let authority = "w-1";
  const calls = [];
  globalThis.window = {
    cp4Harness: {
      call: async (name) => {
        calls.push(name);
        return { ok: true, value: { authorityId: authority } };
      },
      declaration: {
        declare: async () => {
          calls.push("declare");
          declared = true;
          return { ok: true };
        },
        state: async () => {
          calls.push("state");
          return declared ? state(currentToken) : { ok: true, snapshot: null };
        },
      },
    },
  };
  const page = { evaluate: async (fn, arg) => fn(arg) };
  const index = {
    b: { generation: 3, dirty: false },
    chronicle: { generation: 2, dirty: false },
  };
  const seam = {
    sha256: "f".repeat(64),
    value: {
      version: 1,
      envNames: { a: "X" },
      nonceDigest: "sha256:abc",
      approvedGrantCount: 1,
      approvedBindingDigests: ["sha256:digest-1"],
    },
  };
  const declaration = await runTraceDeclaration({
    page,
    workspacePath: "/w",
    projectId: "p",
    sceneId: "s",
    readIndex: () => index,
    readSeam: async () => seam,
    locatorDigest: "loc",
  });
  assert.equal(declaration.token, "t-1");
  assert.equal(declaration.bindingDigest, "digest-1");
  assert.equal(declaration.workspaceId, "w-1");
  assert.deepEqual(declaration.indexBefore, declaration.indexAfter);
  assert.deepEqual(calls, [
    "narrative_extraction_capture_workspace_binding",
    "declare",
    "state",
  ]);
  const confirmed = await confirmTraceDeclaration({
    page,
    declaration,
    workspacePath: "/w",
    projectId: "p",
    locatorDigest: "loc",
  });
  assert.equal(confirmed.verified, true);
  // token が変わる・workspace の authority が変わる・Index が動けば [precheck]。
  currentToken = "t-2";
  await assert.rejects(
    confirmTraceDeclaration({
      page,
      declaration,
      workspacePath: "/w",
      projectId: "p",
      locatorDigest: "loc",
    }),
    /\[precheck\]/u,
  );
  currentToken = "t-1";
  authority = "w-2";
  await assert.rejects(
    confirmTraceDeclaration({
      page,
      declaration,
      workspacePath: "/w",
      projectId: "p",
      locatorDigest: "loc",
    }),
    /\[precheck\].*workspaceId/u,
  );
  authority = "w-1";
  let generation = 3;
  const moving = await runTraceDeclaration({
    page,
    workspacePath: "/w",
    projectId: "p",
    sceneId: "s",
    readIndex: () => ({
      ...index,
      b: { generation: generation++, dirty: false },
    }),
    readSeam: async () => seam,
    locatorDigest: "loc",
  });
  await assert.rejects(
    confirmTraceDeclaration({
      page,
      declaration: moving,
      workspacePath: "/w",
      projectId: "p",
      locatorDigest: "loc",
    }),
    /\[precheck\] b Index generation changed/u,
  );
  // 宣言が拒まれれば [precheck]（blocked にしない）。
  globalThis.window.cp4Harness.declaration.declare = async () => ({
    ok: false,
    stage: "declare",
  });
  await assert.rejects(
    runTraceDeclaration({
      page,
      workspacePath: "/w",
      projectId: "p",
      sceneId: "s",
      readIndex: () => index,
      readSeam: async () => seam,
      locatorDigest: "loc",
    }),
    /\[precheck\] the K2\/4 declaration of s was refused/u,
  );
});

test("レビュー P3: G-02 base が setup-complete に届かなければ trace は起動せず、先頭に束ねた (b) 未測定・HOLD の receipt を書く", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "s5b-tr-fail-"));
  const head = { kind: "trace", runStartedAtUtc: "2026-10-28T00:00:00.000Z" };
  const { sha256: headSha256 } = await writeRunHead({ runDir: dir, head });
  const prepared = {
    kind: "editing",
    head,
    headSha256,
    setupFailure: {
      b: "unmeasured",
      cp4Availability: "HOLD",
      blocked: { harnessId: "b-seal-not-published" },
    },
  };
  const receipt = await recordTraceSetupFailure({
    runDir: dir,
    runId: "t",
    prepared,
    candidate: { commit: "c" },
  });
  assert.equal(receipt.status, "unmeasured");
  assert.equal(receipt.cp4Availability, "HOLD");
  const written = JSON.parse(
    readFileSync(path.join(dir, "receipt.json"), "utf8"),
  );
  assert.equal(written.headSha256, headSha256);
  assert.match(
    readFileSync(path.join(dir, "SHA256SUMS"), "utf8"),
    /head\.json/u,
  );
  assert.equal(
    await recordTraceSetupFailure({
      runDir: dir,
      runId: "t",
      prepared: { ...prepared, setupFailure: null },
      candidate: {},
    }),
    null,
  );
});

test("レビュー P3: 凍結の trace の開始は setupFailure なら記録して context を作らず、context の組立ても setupFailure を拒む", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "s5b-tr-start-"));
  const head = { kind: "trace", runStartedAtUtc: "2026-10-28T00:00:00.000Z" };
  const { sha256: headSha256 } = await writeRunHead({ runDir: dir, head });
  let built = 0;
  const failed = await startFrozenTrace({
    runDir: dir,
    runId: "t",
    prepared: {
      kind: "editing",
      head,
      headSha256,
      setupFailure: { b: "unmeasured", cp4Availability: "HOLD", blocked: {} },
    },
    candidate: {},
    makeContext: () => {
      built += 1;
      return {};
    },
  });
  assert.equal(failed.context, null);
  assert.equal(failed.receipt.status, "unmeasured");
  assert.equal(built, 0);
  const ok = await startFrozenTrace({
    runDir: dir,
    runId: "t",
    prepared: { setupFailure: null },
    candidate: {},
    makeContext: () => ({ ready: true }),
  });
  assert.deepEqual(ok, { receipt: null, context: { ready: true } });
  assert.throws(
    () =>
      frozenContext({
        prepared: { setupFailure: { b: "unmeasured" } },
        setupRaw: {},
      }),
    /\[precheck\].*does not launch/u,
  );
});

const REPO_ROOT = path.resolve(new URL("../../..", import.meta.url).pathname);
test("DR-CP4-V-2: 凍結の trace の F6 の resolver は Gold と同じ G-02 base の setup の plan から作り、期待は trace の file の材料と同じで、材料の path を material-revision で解決する", () => {
  const tracePlan = JSON.parse(
    readFileSync(
      path.join(REPO_ROOT, "evals/nir1-graph/trace-browsing.v1.json"),
      "utf8",
    ),
  );
  const fixture = JSON.parse(
    readFileSync(path.join(REPO_ROOT, TRACE_PROJECT.fixturePath), "utf8"),
  );
  const setupPlan = loadFrozenSetupPlans({
    root: REPO_ROOT,
    stopsAt: "complete",
  }).find((row) => row.variantKey === "G-02/base");
  const materials = typedRevisionMaterials(setupPlan);
  // 論理 ID → runtime ID（setup の受領書の logicalToRuntime の形）。
  const rt = (logical) => `rt-${logical}`;
  const scenes = Object.fromEntries(
    fixture.scenes.map((row) => [row.id, rt(row.id)]),
  );
  const entities = {};
  const typedRevisions = {};
  for (const revision of materials.values()) {
    typedRevisions[revision.id] = { revisionId: rt(revision.id) };
    for (const relation of revision.relations) {
      entities[relation.from] = rt(relation.from);
      entities[relation.to] = rt(relation.to);
    }
  }
  const ids = { scenes, entities, typedRevisions };
  const resolver = traceMaterialResolver({
    root: REPO_ROOT,
    tracePlan,
    fixture,
    ids,
  });
  assert.deepEqual(resolver.pairs, [
    "g02-r-sela|g02-works-beside",
    "g02-r-tamsin|g02-trained-tamsin",
  ]);
  const edgeOf = (revisionId, relationId) => {
    const row = materials
      .get(revisionId)
      .relations.find((value) => value.relationId === relationId);
    return {
      relationType: row.relationType,
      directionality: row.directionality,
      from: rt(row.from),
      to: rt(row.to),
      evidence: [
        { evidenceId: "ev-1", quoteSha256: row.fromQuoteSha256 },
        { evidenceId: "ev-2", quoteSha256: row.toQuoteSha256 },
      ],
    };
  };
  const paths = {
    graphOnly: {
      sceneId: rt("g02-tamsin-first"),
      edges: [edgeOf("g02-r-tamsin", "g02-trained-tamsin")],
    },
    pathAttachments: [
      {
        sceneId: rt("g02-attach"),
        edges: [edgeOf("g02-r-sela", "g02-works-beside")],
      },
    ],
  };
  const matched = resolver.contribution(paths);
  assert.equal(matched.basis, "material-revision");
  assert.equal(matched.contribution, true);
  assert.deepEqual(matched.matched, [
    "graph-only:g02-tamsin-first",
    "path-attachment:g02-attach",
  ]);
  assert.equal(matched.unresolvedEdges, 0);
  // 観測の無い子（paths なし）は寄与なし、基底は material-revision のまま。
  const none = resolver.contribution(null);
  assert.equal(none.basis, "material-revision");
  assert.equal(none.contribution, false);
  // trace の file の材料が fixture の期待と食い違えば [precheck]。
  assert.throws(
    () =>
      traceMaterialResolver({
        root: REPO_ROOT,
        tracePlan: {
          ...tracePlan,
          expectedMaterials: tracePlan.expectedMaterials.slice(0, 1),
        },
        fixture,
        ids,
      }),
    /\[precheck\] DR-CP4-V-2/u,
  );
});
