import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  PRODUCT_JOURNEYS,
  assertLifecycleTransitionOrder,
  resolveSelectedProductJourneys,
  runProductJourneys,
} from "../electron/scripts/product-journeys.mjs";

function deterministicClock(values) {
  let index = 0;
  return () => {
    assert.ok(index < values.length, "clock was read more often than expected");
    return values[index++];
  };
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

test("product runner records deterministic results while preserving serial fresh harnesses", async (t) => {
  const outputRoot = await mkdtemp(
    path.join(os.tmpdir(), "grimodex-product-results-"),
  );
  const resultsPath = path.join(outputRoot, "results.json");
  const events = [];
  let harnessIndex = 0;
  t.after(() => rm(outputRoot, { recursive: true, force: true }));

  await runProductJourneys({
    journeys: [
      {
        id: "first",
        run: async (harness) => {
          events.push(`run:first:${harness.index}`);
        },
      },
      {
        id: "second",
        run: async (harness) => {
          events.push(`run:second:${harness.index}`);
        },
      },
    ],
    assertArtifacts: () => events.push("assert-artifacts"),
    createHarness: () => {
      const index = ++harnessIndex;
      events.push(`create:${index}`);
      return {
        index,
        finalizeDiagnostics: async () => ({
          rendererErrorCount: 0,
          pageErrors: [],
          mainErrorCount: index === 1 ? 1 : 0,
          unallowedMainErrors: [],
          mainCleanPass: true,
          cleanPass: true,
        }),
        dispose: async ({ success, name }) => {
          events.push(`dispose:${index}:${success}:${name}`);
        },
      };
    },
    clock: deterministicClock([100, 125, 200, 260]),
    resultsPath,
  });

  assert.deepEqual(events, [
    "assert-artifacts",
    "create:1",
    "run:first:1",
    "dispose:1:true:first",
    "create:2",
    "run:second:2",
    "dispose:2:true:second",
  ]);
  const report = await readJson(resultsPath);
  assert.equal(report.version, 3);
  assert.equal(report.status, "passed");
  assert.deepEqual(report.journeys, [
    {
      id: "first",
      status: "passed",
      durationMs: 25,
      rendererErrorCount: 0,
      pageErrors: [],
      mainErrorCount: 1,
      unallowedMainErrors: [],
      mainCleanPass: true,
      cleanPass: true,
    },
    {
      id: "second",
      status: "passed",
      durationMs: 60,
      rendererErrorCount: 0,
      pageErrors: [],
      mainErrorCount: 0,
      unallowedMainErrors: [],
      mainCleanPass: true,
      cleanPass: true,
    },
  ]);
});

test("product runner writes the failed and fail-fast results before rethrowing", async (t) => {
  const outputRoot = await mkdtemp(
    path.join(os.tmpdir(), "grimodex-product-results-"),
  );
  const resultsPath = path.join(outputRoot, "results.json");
  const events = [];
  let failureDiagnostics = {
    rendererErrorCount: 0,
    pageErrors: [],
    cleanPass: true,
  };
  t.after(() => rm(outputRoot, { recursive: true, force: true }));

  await assert.rejects(
    runProductJourneys({
      journeys: [
        {
          id: "broken",
          run: async () => {
            events.push("run:broken");
            throw new TypeError("boom");
          },
        },
        {
          id: "never",
          run: async () => {
            events.push("run:never");
          },
        },
      ],
      assertArtifacts: () => undefined,
      createHarness: () => {
        events.push("create");
        return {
          diagnostics: () => failureDiagnostics,
          dispose: async ({ success, name }) => {
            events.push(`dispose:${success}:${name}`);
            failureDiagnostics = {
              rendererErrorCount: 1,
              pageErrors: [
                {
                  phase: `failure:${name}`,
                  message: "late shutdown error",
                },
              ],
              cleanPass: false,
            };
          },
        };
      },
      clock: deterministicClock([10, 22]),
      resultsPath,
    }),
    /broken: TypeError: boom/,
  );

  assert.deepEqual(events, ["create", "run:broken", "dispose:false:broken"]);
  const report = await readJson(resultsPath);
  assert.equal(report.version, 3);
  assert.equal(report.status, "failed");
  assert.ok(
    report.journeys.every(
      (journey) => journey.cleanPass !== true || journey.status === "passed",
    ),
    "only passed journeys may report cleanPass=true",
  );
  assert.deepEqual(report.journeys, [
    {
      id: "broken",
      status: "failed",
      durationMs: 12,
      error: { name: "TypeError", message: "boom" },
      rendererErrorCount: 1,
      pageErrors: [
        {
          phase: "failure:broken",
          message: "late shutdown error",
        },
      ],
      mainErrorCount: 0,
      unallowedMainErrors: [],
      mainCleanPass: true,
      cleanPass: false,
    },
    {
      id: "never",
      status: "not-run",
      durationMs: 0,
      reason: "Fail-fast after broken.",
    },
  ]);
});

test("product runner still writes a versioned report when artifact preflight fails", async (t) => {
  const outputRoot = await mkdtemp(
    path.join(os.tmpdir(), "grimodex-product-results-"),
  );
  const resultsPath = path.join(outputRoot, "results.json");
  t.after(() => rm(outputRoot, { recursive: true, force: true }));

  await assert.rejects(
    runProductJourneys({
      journeys: [{ id: "never", run: async () => undefined }],
      assertArtifacts: () => {
        throw new Error("missing build");
      },
      createHarness: () => {
        throw new Error("harness must not be created");
      },
      clock: deterministicClock([]),
      resultsPath,
    }),
    /missing build/,
  );

  const report = await readJson(resultsPath);
  assert.equal(report.version, 3);
  assert.equal(report.status, "failed");
  assert.deepEqual(report.error, {
    name: "Error",
    message: "missing build",
  });
  assert.deepEqual(report.journeys, [
    {
      id: "never",
      status: "not-run",
      durationMs: 0,
      reason: "Artifact preflight failed.",
    },
  ]);
});

test("product runner fails closed when renderer diagnostics are not clean", async (t) => {
  const outputRoot = await mkdtemp(
    path.join(os.tmpdir(), "grimodex-product-results-"),
  );
  const resultsPath = path.join(outputRoot, "results.json");
  const events = [];
  const diagnostics = {
    rendererErrorCount: 1,
    pageErrors: [
      {
        phase: "close",
        message: "unhandled renderer rejection",
      },
    ],
    mainErrorCount: 0,
    unallowedMainErrors: [],
    mainCleanPass: true,
    cleanPass: false,
  };
  t.after(() => rm(outputRoot, { recursive: true, force: true }));

  await assert.rejects(
    runProductJourneys({
      journeys: [{ id: "renderer-broken", run: async () => undefined }],
      assertArtifacts: () => undefined,
      createHarness: () => ({
        finalizeDiagnostics: async () => {
          events.push("finalize");
          const error = new Error("renderer diagnostics failed");
          error.diagnostics = diagnostics;
          throw error;
        },
        diagnostics: () => diagnostics,
        dispose: async ({ success, name }) => {
          events.push(`dispose:${success}:${name}`);
        },
      }),
      clock: deterministicClock([10, 22]),
      resultsPath,
    }),
    /renderer-broken: Error: renderer diagnostics failed/,
  );

  assert.deepEqual(events, ["finalize", "dispose:false:renderer-broken"]);
  const report = await readJson(resultsPath);
  assert.equal(report.version, 3);
  assert.equal(report.status, "failed");
  assert.deepEqual(report.journeys, [
    {
      id: "renderer-broken",
      status: "failed",
      durationMs: 12,
      error: {
        name: "Error",
        message: "renderer diagnostics failed",
      },
      ...diagnostics,
    },
  ]);
});

test("lifecycle journey assertion requires one transition id with the exact six-phase order", async () => {
  const phases = [
    "switch-requested",
    "quiescence-started",
    "old-stream-completed",
    "old-scope-persisted",
    "authority-commit",
    "new-scope-hydrated",
  ];
  const events = phases.map((phase, sequence) => ({
    schemaVersion: 1,
    transitionId: "project:one",
    sequence,
    timestampMs: 100 + sequence,
    kind: "project",
    phase,
    from: {
      workspacePath: "/novel",
      workspaceOpenRevision: 1,
      projectId: "project-a",
    },
    to: {
      workspacePath: "/novel",
      workspaceOpenRevision: 1,
      projectId: "project-b",
    },
  }));
  const recorded = [];
  const harness = {
    readLifecycleTrace: async () => events,
    recordTimeline: (event, details) => recorded.push({ event, details }),
  };

  const matched = await assertLifecycleTransitionOrder(
    harness,
    {},
    {
      kind: "project",
      from: { projectId: "project-a" },
      to: { projectId: "project-b" },
      label: "project switch",
    },
  );
  assert.deepEqual(matched, events);
  assert.equal(recorded[0].event, "application-lifecycle-order-verified");
  assert.deepEqual(recorded[0].details.lifecyclePhases, phases);

  const outOfOrderHarness = {
    ...harness,
    readLifecycleTrace: async () =>
      events.map((event, index) =>
        index === 1
          ? { ...event, phase: "old-stream-completed" }
          : index === 2
            ? { ...event, phase: "quiescence-started" }
            : event,
      ),
  };
  await assert.rejects(
    assertLifecycleTransitionOrder(
      outOfOrderHarness,
      {},
      {
        kind: "project",
        from: { projectId: "project-a" },
        to: { projectId: "project-b" },
        label: "project switch",
      },
    ),
    /did not emit the required lifecycle order/,
  );
});

test("affected execution resolves a strict catalog-ordered runner subset", () => {
  const selected = resolveSelectedProductJourneys(
    PRODUCT_JOURNEYS,
    JSON.stringify([
      "map-native-roundtrip",
      "editor-persistence",
      "mcp-external-write-conflict",
    ]),
  );

  assert.deepEqual(
    selected.map((journey) => journey.id),
    [
      "editor-persistence",
      "mcp-external-write-conflict",
      "map-native-roundtrip",
    ],
  );
});

test("runner selection rejects malformed, duplicate, empty, and unknown IDs", () => {
  assert.throws(
    () => resolveSelectedProductJourneys(PRODUCT_JOURNEYS, "not-json"),
    /valid JSON array/i,
  );
  assert.throws(
    () =>
      resolveSelectedProductJourneys(
        PRODUCT_JOURNEYS,
        JSON.stringify(["editor-persistence", "editor-persistence"]),
      ),
    /duplicate.*editor-persistence/i,
  );
  assert.throws(
    () => resolveSelectedProductJourneys(PRODUCT_JOURNEYS, "[]"),
    /at least one journey ID/i,
  );
  assert.throws(
    () =>
      resolveSelectedProductJourneys(
        PRODUCT_JOURNEYS,
        JSON.stringify(["deleted-journey"]),
      ),
    /unknown.*deleted-journey/i,
  );
  assert.equal(
    resolveSelectedProductJourneys(PRODUCT_JOURNEYS, undefined),
    PRODUCT_JOURNEYS,
  );
});
