// CP-4 S1c-2 runner pure parts. Synthetic records only; no G-case fixture.
import assert from "node:assert/strict";
import { test } from "node:test";
import { validateGraphCaseSchedule } from "./availability.mjs";
import { K62_FREEZE, devVariant } from "./constants.mjs";
import { SOCKET_SAMPLE_SCHEMA } from "./egress.mjs";
import { assessMeasurementWindow, validateCp4Receipt } from "./receipt.mjs";
import {
  aggregatePreviews,
  assembleRunReceipt,
  distribution,
  graphArrival,
  graphRecord,
  measurementSeamEnv,
  previewSummary,
  quietAtStart,
  runSchedule,
  sampleRow,
  scheduledArms,
  snapshotOf,
  windowOutCause,
} from "./run-sample.mjs";
import { H40, H64 } from "./test-support.mjs";

const VARIANT = devVariant({
  key: "dev:dev-lantern.v1/base",
  expectedGraph: "available",
});
const UUID_A = "3f9a8f0e-5b6c-4d7e-8a9b-0c1d2e3f4a5b";
const UUID_B = "4f9a8f0e-5b6c-4d7e-8a9b-0c1d2e3f4a5c";

function ipc({ beginAt = 100, beginDone = 115, graph = null } = {}) {
  const rows = [
    {
      cmd: "related_scenes_begin",
      calledAt: beginAt,
      resolvedAt: beginDone,
      ok: true,
      settle: null,
      status: "raw-ready",
      reason: null,
      graphStatus: "pending",
      graphReason: null,
      pathAttachments: null,
      graphOnly: null,
    },
  ];
  if (graph)
    rows.push({
      cmd: "related_scenes_graph_continue",
      calledAt: 118,
      resolvedAt: graph.resolvedAt,
      ok: true,
      settle: null,
      status: graph.status,
      reason: graph.reason ?? null,
      graphStatus: null,
      graphReason: null,
      pathAttachments: graph.status === "available" ? 1 : null,
      graphOnly: graph.status === "available" ? true : null,
    });
  rows.push({
    cmd: "related_scenes_graph_continue",
    calledAt: 130,
    resolvedAt: 131,
    ok: true,
    settle: "unused",
    status: "cancelled",
    reason: null,
    graphStatus: null,
    graphReason: null,
    pathAttachments: null,
    graphOnly: null,
  });
  return rows;
}

function measure({
  graphOutcome = "graph-ready",
  arrivedAt = 121,
  ...rest
} = {}) {
  return {
    status: "completed",
    rawStatus: "completed",
    timing: { tFetchMs: 100, tRawReadyMs: 120, tReturnMs: 125, native: null },
    initialSnapshot: { indexUsable: true, querySupported: true },
    completion: { outcome: "ir-ready", deadlineExceeded: false },
    resultKind: "raw",
    graphOutcome,
    graph:
      graphOutcome === "graph-ready"
        ? {
            pathAttachments: [{ sceneId: "a", hop: 1, edges: 1 }],
            graphOnlySceneId: "b",
            edgeCount: 2,
          }
        : null,
    rawSceneIds: ["a"],
    finalSceneIds: ["a", "b"],
    ipc: ipc({
      graph:
        arrivedAt === null
          ? null
          : {
              resolvedAt: arrivedAt,
              status:
                graphOutcome === "graph-ready" ? "available" : "unavailable",
            },
    }),
    ...rest,
  };
}

function nativeRecord(overrides = {}) {
  const { ticket = {}, ...rest } = overrides;
  return {
    seq: 1,
    tBeginNs: 1_000_000,
    tReturnedNs: 1_010_000,
    startSlot: {
      kind: "ready",
      readyFresh: true,
      preparesReady: 2,
      readyGeneration: 3,
    },
    cacheOccupiedAtBegin: false,
    begin: "pending",
    reason: null,
    busyCause: null,
    ...rest,
    ticket:
      rest.begin && rest.begin !== "pending"
        ? null
        : {
            tTicketNs: 1_002_000,
            settled: true,
            tSettledNs: 7_002_000,
            outcome: "available",
            reason: null,
            disposition: "used",
            busyCause: null,
            freshnessStamp: {
              attemptedAtNs: 1_003_000,
              result: "fresh",
              matched: true,
            },
            ...ticket,
          },
  };
}

const A3 = {
  schema: "nir1-graph-eval-a3/1",
  connection: "read-only-own",
  readOnly: true,
  queryOnly: true,
  tOpenStartedNs: 900_000,
  tSnapshotNs: 910_000,
  tFinishedNs: 950_000,
  revisions: [{ revisionId: "r1", a3: "eligible", reason: null }],
};

function rowsFor(mutateGraph = () => ({})) {
  return runSchedule().map((slot) =>
    slot.arm === "graph"
      ? sampleRow({
          variantKey: VARIANT.key,
          ...slot,
          d2aMode: "restricted",
          measure: measure(mutateGraph(slot)),
          nativeRecord: nativeRecord(mutateGraph(slot).native ?? {}),
          a3: A3,
        })
      : sampleRow({
          variantKey: VARIANT.key,
          ...slot,
          d2aMode: "restricted",
          measure: measure({ graphOutcome: null, arrivedAt: null }),
        }),
  );
}

test("the schedule is the predeclared AB/BA order the receipt validator recomputes", () => {
  assert.deepEqual(scheduledArms(0), ["hybrid", "graph"]);
  assert.deepEqual(scheduledArms(1), ["graph", "hybrid"]);
  const rows = runSchedule().map((slot) => ({
    ...slot,
    variantKey: VARIANT.key,
    trigger: "user-operation",
  }));
  assert.equal(rows.length, 70);
  validateGraphCaseSchedule(rows, [VARIANT.key]);
});

test("the Graph arrival is the awaiting continue, never the settling one", () => {
  const rows = ipc({ graph: { resolvedAt: 121, status: "available" } });
  assert.deepEqual(graphArrival(rows), {
    calledAt: 118,
    resolvedAt: 121,
    status: "available",
    reason: null,
  });
  assert.equal(graphArrival(ipc()), null);
});

test("the product join outcome maps to the S1b Graph record", () => {
  const ready = graphRecord({
    measure: measure(),
    arrival: { resolvedAt: 121, status: "available" },
    native: { source: "worker", busyCause: null },
  });
  assert.equal(ready.joined, true);
  assert.equal(ready.revalidation, "passed");
  assert.equal(ready.arrivedAt, 121);
  assert.equal(ready.edgeCount, 2);
  const late = graphRecord({
    measure: measure({ graphOutcome: "graph-late" }),
    arrival: { resolvedAt: 140, status: "cancelled" },
    native: { source: "worker", busyCause: null },
  });
  assert.equal(late.joined, false);
  assert.equal(late.arrivedAt, null, "a cancelled answer is not an arrival");
  const stale = graphRecord({
    measure: measure({ graphOutcome: "graph-unavailable:stale" }),
    arrival: null,
    native: { source: null, busyCause: null },
  });
  assert.deepEqual(
    [stale.outcome, stale.reason],
    ["graph-unavailable", "stale"],
  );
});

test("the B seal at the start is the begin's registration answer and the Chronicle snapshot", () => {
  assert.deepEqual(
    snapshotOf({
      measure: measure(),
      nativeRecord: nativeRecord({
        begin: "unavailable",
        reason: "registration-unavailable",
      }),
    }),
    { usable: false, reason: "registration-unavailable" },
  );
  assert.deepEqual(
    snapshotOf({
      measure: { ...measure(), initialSnapshot: { indexUsable: false } },
      nativeRecord: nativeRecord(),
    }),
    { usable: false, reason: "chronicle-index-unusable" },
  );
  assert.deepEqual(
    snapshotOf({ measure: measure(), nativeRecord: nativeRecord() }),
    {
      usable: true,
      reason: null,
    },
  );
});

test("a seeded sample needs its Native record and the timing shim's begin", () => {
  const base = {
    variantKey: VARIANT.key,
    arm: "graph",
    phase: "measured",
    repeat: 0,
    d2aMode: "restricted",
  };
  assert.throws(
    () => sampleRow({ ...base, measure: measure() }),
    /Native begin record/u,
  );
  assert.throws(
    () =>
      sampleRow({
        ...base,
        measure: { ...measure(), ipc: [] },
        nativeRecord: nativeRecord(),
        a3: A3,
      }),
    /timing shim/u,
  );
  const row = sampleRow({
    ...base,
    measure: measure(),
    nativeRecord: nativeRecord(),
    a3: A3,
  });
  assert.equal(row.graph.source, "worker");
  assert.equal(row.disclosure.graphAnswerAfterRawReadyMs, 1);
  assert.equal(row.disclosure.nativeWorkerMs, 6);
  assert.equal(row.disclosure.nativeBeginToSettledMs, 6.002);
  // settled 6.002 ms after the Native begin, Raw ready 20 ms after the begin call
  assert.ok(
    Math.abs(row.disclosure.lowerBoundArrivalAfterRawReadyMs + 13.998) < 1e-9,
  );
  assert.deepEqual(row.recordRead, {
    startedAtNs: 900_000,
    finishedAtNs: 950_000,
  });
});

test("each window-out sample has one cause in the fixed order", () => {
  const base = sampleRow({
    variantKey: VARIANT.key,
    arm: "graph",
    phase: "measured",
    repeat: 0,
    d2aMode: "restricted",
    measure: measure(),
    nativeRecord: nativeRecord(),
    a3: A3,
  });
  const with_ = (graph, extra = {}) => ({
    ...base,
    ...extra,
    graph: { ...base.graph, ...graph },
  });
  assert.equal(windowOutCause(with_({ source: "cache" })), "cache-origin");
  assert.equal(
    windowOutCause(
      with_({
        outcome: "graph-unavailable",
        reason: "busy",
        busyCause: "in-use",
        joined: false,
      }),
    ),
    "busy:in-use",
  );
  assert.equal(
    windowOutCause(
      with_({ outcome: "graph-unavailable", reason: "stale", joined: false }),
    ),
    "unavailable:stale",
  );
  assert.equal(
    windowOutCause(
      with_(
        { outcome: "graph-late", joined: false },
        { startSlot: { readyFresh: false } },
      ),
    ),
    "not-ready-at-start",
  );
  assert.equal(
    windowOutCause(
      with_(
        { outcome: "graph-late", joined: false },
        { freshnessStamp: { matched: false } },
      ),
    ),
    "stamp-mismatch",
  );
  assert.equal(
    windowOutCause(with_({ outcome: "graph-late", joined: false })),
    "worker-late",
  );
});

test("the preview counts the (a) window on the dev plan against the 1% yardstick", () => {
  const allIn = previewSummary({ samples: rowsFor(), variant: VARIANT });
  assert.equal(allIn.preview, true);
  assert.equal(allIn.n, 30);
  assert.equal(allIn.inWindow, 30);
  assert.equal(allIn.exceedsYardstick, false);
  assert.equal(allIn.steadyState.status, "valid");
  assert.equal(allIn.distributions.joinedArrivalAfterRawReadyMs.p50, 1);
  const stale = previewSummary({
    samples: rowsFor(() => ({
      graphOutcome: "graph-unavailable:stale",
      arrivedAt: null,
    })),
    variant: VARIANT,
  });
  assert.equal(stale.inWindow, 0);
  assert.equal(stale.exceedsYardstick, true);
  assert.deepEqual(stale.windowOutCauses, { "unavailable:stale": 30 });
  assert.deepEqual(stale.steadyState.qualityHoldVariants, [VARIANT.key]);
  const pooled = aggregatePreviews([
    { runId: "a", preview: allIn },
    { runId: "b", preview: stale },
  ]);
  assert.equal(pooled.pooled.n, 60);
  assert.equal(pooled.pooled.inWindow, 30);
  assert.deepEqual(pooled.inWindowRateRange, { min: 0, max: 1 });
});

test("the distribution is nearest-rank over finite values", () => {
  assert.deepEqual(distribution([3, null, 1, 2, Number.NaN]), {
    n: 3,
    p50: 2,
    p90: 3,
    p99: 3,
    min: 1,
    max: 3,
  });
  assert.equal(distribution([]).p50, null);
});

test("the measurement seam env is the body declaration seam, plus only the disclosed maintenance stop", () => {
  const product = measurementSeamEnv({
    bodyNonce: UUID_A,
    maintenance: "product",
  });
  assert.deepEqual(Object.keys(product).sort(), [
    "CI",
    "GRIMODEX_BODY_DECLARATION_CI_NONCE",
    "GRIMODEX_BODY_DECLARATION_CI_OWNER_TOKEN",
  ]);
  const stopped = measurementSeamEnv({
    bodyNonce: UUID_A,
    maintenance: "scheduler-disabled-for-launch",
    maintenanceNonce: UUID_B,
  });
  assert.equal(stopped.GRIMODEX_PRODUCT_JOURNEY_MAINTENANCE_SETUP, "disabled");
  assert.equal(stopped.GRIMODEX_PRODUCT_JOURNEY_MAINTENANCE_TRIGGER, undefined);
  assert.throws(
    () => measurementSeamEnv({ bodyNonce: "x", maintenance: "product" }),
    /UUIDv4/u,
  );
  assert.throws(
    () =>
      measurementSeamEnv({
        bodyNonce: UUID_A,
        maintenance: "graph-index-build",
      }),
    /unknown maintenance mode/u,
  );
  assert.throws(
    () =>
      measurementSeamEnv({
        bodyNonce: UUID_A,
        maintenance: "scheduler-disabled-for-launch",
      }),
    /maintenance seam nonce/u,
  );
});

function socketSamples(times) {
  return times.map((atMs) => ({
    schema: SOCKET_SAMPLE_SCHEMA,
    atMs,
    rootPid: 10,
    pids: [10],
    unreadable: [],
    sockets: { tcp: 1, udp: 0, loopback: 1, unconnected: 0 },
    external: [],
    externalListeners: [],
  }));
}

test("an assembled dev preview receipt passes the §7.2 validator with recomputed aggregates", () => {
  const samples = rowsFor();
  const run = { startedAtMs: 1_000, finishedAtMs: 31_000 };
  const windowSamples = [0, 20_000, 32_000].map((atMs) => ({
    atMs,
    heavySlotsInUse: 0,
    buildProcesses: [],
    otherMeasurements: [],
    sameWorktreeBuild: false,
  }));
  const receipt = assembleRunReceipt({
    runId: "dev-preview-1",
    fixture: {
      path: "scripts/quality/nir1-graph-eval/dev-fixtures/dev-lantern.v1.json",
      sha256: H64("d"),
      kind: "dev",
    },
    variant: VARIANT,
    head: {
      k62: { freezeCommit: K62_FREEZE.commit, sha256: K62_FREEZE.sha256 },
      runStartedAtUtc: "2026-10-25T00:00:00.000Z",
    },
    candidate: {
      commit: H40("1"),
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
      harnessFiles: { "runner.mjs": H64("a") },
    },
    environment: {
      hostSnapshot: { loadAverage: [0, 0, 0] },
      windowSamples,
      windowAssessment: assessMeasurementWindow({
        samples: windowSamples,
        run,
        ownPids: [],
      }),
      ownPids: [],
      xvfbDisplay: ":7",
      removedEnv: ["WAYLAND_DISPLAY"],
      netLog: { sha256: H64("b"), nonLoopbackAttempts: 0 },
      socketSamples: socketSamples([0, 20_000, 32_000]),
    },
    run,
    settings: {
      maintenance: "product",
      d2aModes: { hybrid: "restricted", graph: "restricted" },
      reauthorization: { mode: "restricted" },
      setupReceipt: { logicalToRuntime: { projectId: "p" } },
    },
    declaration: null,
    measurementWorkspace: null,
    samples,
    checks: {},
  });
  assert.deepEqual(validateCp4Receipt(receipt), []);
  assert.equal(receipt.preview, true);
  assert.equal(receipt.verdict.outcome, "preview-only");
  assert.equal(receipt.previewSummary.inWindow, 30);
  // a tampered aggregate is recomputed and refused
  receipt.aggregates.steadyStateCase.inWindow = 29;
  assert.ok(
    validateCp4Receipt(receipt).some((error) =>
      /aggregates differ/u.test(error),
    ),
  );
});

test("D′: a Graph sample starts on an empty slot, an empty cache and after the rebuild interval", () => {
  const quiet = {
    slot: "empty",
    cacheOccupied: false,
    sinceLastSeededMs: 1_000,
  };
  assert.equal(quietAtStart(quiet), true);
  assert.equal(quietAtStart({ ...quiet, sinceLastSeededMs: null }), true);
  for (const slot of [
    "deferred",
    "preparing",
    "in-use",
    "ready",
    "suspended",
    "retiring",
    null,
  ])
    assert.equal(quietAtStart({ ...quiet, slot }), false, slot);
  assert.equal(quietAtStart({ ...quiet, cacheOccupied: true }), false);
  assert.equal(quietAtStart({ ...quiet, cacheOccupied: undefined }), false);
  assert.equal(quietAtStart({ ...quiet, sinceLastSeededMs: 999 }), false);
});
