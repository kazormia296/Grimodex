import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_RUNTIME_BUDGETS,
  evaluateRuntimePerformance,
  extractAutosaveMetrics,
} from "./runtime-performance-budget.mjs";

function passingMetrics() {
  return {
    coldStartMs: 1_500,
    projectOpenMs: 900,
    editorInput: { p50Ms: 2, p95Ms: 6, p99Ms: 9 },
    autosave: {
      deriveSnapshotCpuMs: 20,
      invokeSaveWallMs: 80,
      domainIpcCount: 1,
      dbTransactionCount: 1,
    },
    memory: {
      startupBytes: 400_000_000,
      peakBytes: 600_000_000,
      peakByViewBytes: {
        map: 550_000_000,
        timeline: 560_000_000,
        linear: 570_000_000,
      },
    },
    longTask: { count: 0, maxMs: 0 },
  };
}

test("runtime performance budgets accept a complete passing sample", () => {
  const result = evaluateRuntimePerformance(passingMetrics());
  assert.equal(result.ok, true);
  assert.equal(
    result.checks.every((check) => check.ok),
    true,
  );
});

test("autosave metrics keep CPU, wall time, and logical counters independent", () => {
  const metrics = extractAutosaveMetrics({
    markStats: [
      {
        label: "editor.coreSave.deriveSnapshot",
        count: 2,
        totalMs: 18,
      },
      {
        label: "editor.coreSave.invokeSave",
        count: 3,
        totalMs: 75,
      },
    ],
    counters: {
      "editor.coreSave.domainIpc": 1,
      "editor.coreSave.dbTransaction": 1,
    },
  });

  assert.deepEqual(metrics, {
    deriveSnapshotCpuMs: 18,
    invokeSaveWallMs: 75,
    domainIpcCount: 1,
    dbTransactionCount: 1,
  });
});

test("autosave metrics reject missing canonical counters", () => {
  assert.equal(
    extractAutosaveMetrics({
      markStats: [
        { label: "editor.coreSave.deriveSnapshot", count: 1, totalMs: 10 },
        { label: "editor.coreSave.invokeSave", count: 1, totalMs: 20 },
      ],
      counters: {},
    }),
    null,
  );
});

test("runtime performance budgets reject missing metrics and regressions", () => {
  const metrics = passingMetrics();
  metrics.editorInput.p95Ms = DEFAULT_RUNTIME_BUDGETS.editorInputP95Ms + 1;
  delete metrics.memory.peakBytes;
  delete metrics.memory.peakByViewBytes.timeline;

  const result = evaluateRuntimePerformance(metrics);
  assert.equal(result.ok, false);
  assert.equal(
    result.checks.find((check) => check.name === "editorInput.p95Ms").ok,
    false,
  );
  assert.equal(
    result.checks.find((check) => check.name === "memory.peakBytes").missing,
    true,
  );
  assert.equal(
    result.checks.find(
      (check) => check.name === "memory.peakByViewBytes.timeline",
    ).missing,
    true,
  );
});
