// 正式の runner の骨格（S1f）の Electron を使わない部分: R1／R4 の待ち（偽の評価の
// 入口と時計）、query の Scene の pin の読取（一時の SQLite）、admission の分岐、
// receipt の組立て（合成の記録）。
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { K64_FREEZE, K62_FREEZE, devVariant } from "./constants.mjs";
import { k64GraphSampleRow } from "./k64-record.mjs";
import {
  K64_DEV_PREVIEW_PURPOSE,
  admitK64Run,
  assembleK64Receipt,
  waitR1,
  waitRelease,
} from "./k64-runner.mjs";
import {
  DEV_DRAFT_PROCEDURE_VERSION,
  loadProcedureFile,
} from "./procedure-file.mjs";
import { assessMeasurementWindow, validateCp4Receipt } from "./receipt.mjs";
import { runSchedule, sampleRow } from "./run-sample.mjs";
import { assertSeedPinsBeforeK64 } from "./seed-pin.mjs";
import { readQuerySceneSeedPins } from "./workspace-db.mjs";
import {
  H40,
  H64,
  REPO_ROOT,
  k64HookInput,
  ratification5,
} from "./test-support.mjs";

/** A fake evaluation entry: a list of owner states, one per status call. */
function fakeOwner(states) {
  const calls = [];
  let at = 0;
  const clock = { now: 0 };
  return {
    calls,
    clock,
    now: () => clock.now,
    sleep: async (ms) => {
      clock.now += ms;
    },
    addon: async (name) => {
      calls.push(name);
      if (name === "nir1GraphEvalClearNextQueryCache") {
        const state = states[Math.min(at, states.length - 1)];
        state.cacheOccupied = false;
        return JSON.stringify({ cleared: true });
      }
      const state = states[Math.min(at, states.length - 1)];
      at += 1;
      return JSON.stringify({ owner: { ...state } });
    },
  };
}

test("R1: 自分で観測して待ち、(1)〜(3) が揃えば止め、上限に届かなければ reachedQuiet false で返す", async () => {
  const quiet = fakeOwner([
    { slot: "deferred", cacheOccupied: false },
    { slot: "empty", cacheOccupied: true },
    { slot: "empty", cacheOccupied: false },
  ]);
  const reached = await waitR1({
    addon: quiet.addon,
    waitMs: 1_000,
    lastSeededEndedAt: null,
    previousReleaseWithinLimit: true,
    now: quiet.now,
    sleep: quiet.sleep,
  });
  assert.equal(reached.reachedQuiet, true);
  assert.equal(reached.cacheCleared, 1);
  assert.ok(quiet.calls.includes("nir1GraphEvalClearNextQueryCache"));
  // slot が空に戻らなければ上限で止め、sample は取る（分母から除かない）。
  const busy = fakeOwner([{ slot: "deferred", cacheOccupied: false }]);
  const notReached = await waitR1({
    addon: busy.addon,
    waitMs: 300,
    lastSeededEndedAt: null,
    previousReleaseWithinLimit: true,
    now: busy.now,
    sleep: busy.sleep,
  });
  assert.equal(notReached.reachedQuiet, false);
  assert.equal(notReached.slotEmpty, false);
  assert.ok(notReached.waitedMs >= 300);
  // (3) rebuild_min_interval は待つ。
  const interval = fakeOwner([{ slot: "empty", cacheOccupied: false }]);
  interval.clock.now = 10_000;
  const waited = await waitR1({
    addon: interval.addon,
    waitMs: 5_000,
    lastSeededEndedAt: 9_600,
    previousReleaseWithinLimit: true,
    now: interval.now,
    sleep: interval.sleep,
  });
  assert.equal(waited.reachedQuiet, true);
  assert.ok(waited.sinceLastSeededMs >= 1_000);
  // (4) は待てない: 前の release が上限を超えていれば、待たずに false で返す。
  const previous = fakeOwner([{ slot: "empty", cacheOccupied: false }]);
  const late = await waitR1({
    addon: previous.addon,
    waitMs: 5_000,
    lastSeededEndedAt: null,
    previousReleaseWithinLimit: false,
    now: previous.now,
    sleep: previous.sleep,
  });
  assert.equal(late.reachedQuiet, false);
  assert.equal(late.previousReleaseWithinLimit, false);
  assert.ok(late.waitedMs < 5_000);
});

test("R4: sample の後の release と owner の静止を手順のファイルの上限まで待つ", async () => {
  const released = fakeOwner([
    { slot: "in-use", cacheOccupied: false },
    { slot: "empty", cacheOccupied: false },
  ]);
  const ok = await waitRelease({
    addon: released.addon,
    waitMs: 1_000,
    now: released.now,
    sleep: released.sleep,
  });
  assert.deepEqual(
    { withinLimit: ok.withinLimit, slot: ok.slot },
    { withinLimit: true, slot: "empty" },
  );
  const stuck = fakeOwner([{ slot: "retiring", cacheOccupied: false }]);
  const over = await waitRelease({
    addon: stuck.addon,
    waitMs: 200,
    now: stuck.now,
    sleep: stuck.sleep,
  });
  assert.equal(over.withinLimit, false);
  assert.equal(over.slot, "retiring");
  assert.ok(over.waitedMs >= 200);
});

test("R5: query の Scene の pin を製品の join と同じ形で DB から読み、照合の入口に渡せる", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cp4-pins-"));
  try {
    const file = path.join(dir, "grimodex.db");
    const db = new DatabaseSync(file);
    db.exec(`
      CREATE TABLE tree_nodes (id TEXT PRIMARY KEY, project_id TEXT, node_type TEXT, archived_at TEXT);
      CREATE TABLE codex_entries (id TEXT PRIMARY KEY, project_id TEXT);
      CREATE TABLE scene_codex_pins (scene_id TEXT, entry_id TEXT, created_at TEXT);
      INSERT INTO tree_nodes VALUES ('q', 'p', 'scene', NULL), ('q2', 'p', 'scene', NULL);
      INSERT INTO codex_entries VALUES ('seed', 'p'), ('other', 'p2');
      INSERT INTO scene_codex_pins VALUES ('q', 'seed', '2026-10-26T00:00:01Z'),
        ('q', 'other', '2026-10-26T00:00:00Z'),
        ('q2', 'seed', '2026-10-26T00:00:02Z');
    `);
    db.close();
    const read = readQuerySceneSeedPins(file, "p", "q");
    assert.equal(read.sceneLive, true);
    assert.deepEqual(read.pins, [
      {
        entryId: "other",
        createdAt: "2026-10-26T00:00:00Z",
        entryInProject: false,
      },
      {
        entryId: "seed",
        createdAt: "2026-10-26T00:00:01Z",
        entryInProject: true,
      },
    ]);
    // SP/1 SP-P1: 問いの Scene の pin は 1 つだけ（別の project の entry の pin も数える）。
    assert.throws(
      () =>
        assertSeedPinsBeforeK64({
          cases: [
            { caseId: "dev:x", querySceneId: "q", expectedSeed: "seed", read },
          ],
          plan: "dev",
        }),
      /multiple-pins/u,
    );
    assert.equal(
      assertSeedPinsBeforeK64({
        cases: [
          {
            caseId: "dev:x",
            querySceneId: "q2",
            expectedSeed: "seed",
            read: readQuerySceneSeedPins(file, "p", "q2"),
          },
        ],
        plan: "dev",
      }).status,
      "match",
    );
    assert.equal(readQuerySceneSeedPins(file, "p", "missing").sceneLive, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("admission: 凍結した fixture は admitGraphCaseRun を通り、K6/4 の凍結が無い今は [precheck] で止まる。dev は予告の admission", () => {
  assert.equal(K64_FREEZE.freezeCommit, null);
  assert.throws(
    () =>
      admitK64Run({
        root: REPO_ROOT,
        fixture: {
          kind: "frozen",
          path: "evals/nir1-graph/g02-directed-relation.v1.json",
        },
      }),
    /\[precheck\]/,
  );
  assert.throws(
    () =>
      admitK64Run({ root: REPO_ROOT, fixture: { kind: "dev", loaded: {} } }),
    /\[precheck\]/,
  );
  assert.equal(K64_DEV_PREVIEW_PURPOSE, "k64-runner-preview");
});

const VARIANT = devVariant({
  key: "dev:dev-lantern.v1/base",
  expectedGraph: "available",
});

/** A synthetic dev run: the full AB/BA schedule through the K6/4 producer. */
function devSamples(k64Input) {
  return runSchedule().map((slot) =>
    slot.arm === "graph"
      ? k64GraphSampleRow(k64Input({ phase: slot.phase, repeat: slot.repeat }))
      : sampleRow({
          variantKey: VARIANT.key,
          arm: "hybrid",
          phase: slot.phase,
          repeat: slot.repeat,
          d2aMode: "restricted",
          measure: {
            status: "completed",
            timing: { tFetchMs: 10, tRawReadyMs: 50, tReturnMs: 61 },
            completion: { outcome: "ir-ready" },
            initialSnapshot: { indexUsable: true },
            rawSceneIds: ["dev-a", "dev-b"],
            finalSceneIds: ["dev-a", "dev-b", "dev-c"],
          },
        }),
  );
}

test("receipt: dev の予告は hook の消費者の runner の receipt で、集計と品質を同じ samples から作り、検証に通る（予告のまま）", async () => {
  const samples = devSamples(k64HookInput);
  const procedure = loadProcedureFile({
    root: REPO_ROOT,
    version: DEV_DRAFT_PROCEDURE_VERSION,
    purpose: "dev-preview",
  });
  const windowRows = [0, 20_000, 40_000, 62_000].map((atMs) => ({
    atMs,
    locksReadable: true,
    heavySlotFiles: 3,
    heavySlotsInUse: 0,
    buildProcesses: [],
    otherMeasurements: [],
    sameWorktreeBuild: false,
  }));
  const run = { startedAtMs: 1_000, finishedAtMs: 61_000 };
  const receipt = assembleK64Receipt({
    runId: "k64-dev-1",
    preview: true,
    fixture: {
      path: "scripts/quality/nir1-graph-eval/dev-fixtures/dev-lantern.v1.json",
      sha256: H64("d"),
      kind: "dev",
    },
    variant: VARIANT,
    head: {
      k62: { freezeCommit: K62_FREEZE.commit, sha256: K62_FREEZE.sha256 },
      runStartedAtUtc: "2026-10-26T00:00:00.000Z",
    },
    candidate: {
      commit: ratification5().candidateHead,
      tree: H40("2"),
      clean: true,
      productReceiptSha256: H64("3"),
      evalReceiptSha256: H64("4"),
      workerSha256: H64("5"),
      features: ["nir1-graph-eval"],
      models: {
        ja: { modelSha256: H64("6"), tokenizerSha256: H64("7") },
        en: { modelSha256: H64("8"), tokenizerSha256: H64("9") },
      },
      electronVersion: "43.8.3",
      harnessFiles: { "k64-runner.mjs": H64("a") },
    },
    ratification5: ratification5(),
    procedure,
    environment: {
      hostSnapshot: { loadAverage: [0, 0, 0] },
      windowSamples: windowRows,
      windowAssessment: assessMeasurementWindow({
        samples: windowRows,
        run,
        ownPids: [],
      }),
      ownPids: [],
      xvfbDisplay: ":7",
      removedEnv: ["WAYLAND_DISPLAY"],
      netLog: { sha256: H64("b"), nonLoopbackAttempts: 0, truncated: false },
      socketSamples: [],
      stop: { closed: true, remaining: [] },
      x11: { before: [], after: [] },
      profileEgress: { dictionaries: [], networkPersistentServers: [] },
      observer: { ok: true },
      mainWorker: {
        ok: true,
        atStart: H64("5"),
        atEnd: H64("5"),
      },
    },
    run,
    settings: {
      d2aModes: { hybrid: "restricted", graph: "restricted" },
      reauthorization: { mode: "restricted" },
      setupReceipt: { logicalToRuntime: { projectId: "p" } },
    },
    samples,
    checks: {},
  });
  assert.equal(receipt.runnerKind, "k64-hook-consumer");
  assert.equal(receipt.preview, true);
  assert.equal(receipt.verdict.outcome, "preview-only");
  assert.equal(receipt.settings.k64.procedureFile.version, "draft-1");
  assert.equal(receipt.aggregates.steadyStateCase.k64.followUp, 30);
  assert.equal(receipt.k64Preview.steadyState.regime, "k64");
  assert.equal(receipt.k64Preview.steadyState.k64.display.followUp, 30);
  assert.equal(receipt.k64Preview.quality.status, "measurable");
  assert.equal(
    receipt.k64Preview.steadyState.samplesDigest,
    receipt.k64Preview.qualitySamplesDigest,
  );
  const errors = validateCp4Receipt(receipt, {
    ratification5: ratification5(),
    procedure,
  }).filter((error) => !/socketSamples/.test(error));
  assert.deepEqual(errors, []);
});
