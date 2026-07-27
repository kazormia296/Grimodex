#!/usr/bin/env node

import { readFileSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const DEFAULT_RUNTIME_BUDGETS = Object.freeze({
  coldStartMs: 4_000,
  projectOpenMs: 3_000,
  editorInputP95Ms: 8,
  autosaveDeriveSnapshotCpuMs: 50,
  autosaveInvokeSaveWallMs: 250,
  autosaveDomainIpcCount: 1,
  autosaveDbTransactionCount: 1,
  startupMemoryBytes: 1_000_000_000,
  peakMemoryBytes: 2_500_000_000,
  mapPeakMemoryBytes: 2_500_000_000,
  timelinePeakMemoryBytes: 2_500_000_000,
  linearPeakMemoryBytes: 2_500_000_000,
  longTaskCount: 2,
  longTaskMaxMs: 75,
});

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function findMark(perfSession, label) {
  return perfSession?.markStats?.find((entry) => entry.label === label) ?? null;
}

/**
 * Build autosave metrics without inferring logical operation counts from timing
 * marks. A mark measures elapsed work and may legitimately occur more than once;
 * the domain IPC / DB transaction counters are the canonical cardinality.
 */
export function extractAutosaveMetrics(perfSession) {
  const deriveSnapshot = findMark(
    perfSession,
    "editor.coreSave.deriveSnapshot",
  );
  const invokeSave = findMark(perfSession, "editor.coreSave.invokeSave");
  const domainIpcCount =
    perfSession?.counters?.["editor.coreSave.domainIpc"] ?? null;
  const dbTransactionCount =
    perfSession?.counters?.["editor.coreSave.dbTransaction"] ?? null;

  if (
    !deriveSnapshot ||
    !invokeSave ||
    !finite(domainIpcCount) ||
    !finite(dbTransactionCount)
  ) {
    return null;
  }

  return {
    deriveSnapshotCpuMs: deriveSnapshot.totalMs,
    invokeSaveWallMs: invokeSave.totalMs,
    domainIpcCount,
    dbTransactionCount,
  };
}

export function evaluateRuntimePerformance(
  metrics,
  budgets = DEFAULT_RUNTIME_BUDGETS,
) {
  const checks = [
    ["coldStartMs", metrics.coldStartMs, budgets.coldStartMs],
    ["projectOpenMs", metrics.projectOpenMs, budgets.projectOpenMs],
    ["editorInput.p95Ms", metrics.editorInput?.p95Ms, budgets.editorInputP95Ms],
    [
      "autosave.deriveSnapshotCpuMs",
      metrics.autosave?.deriveSnapshotCpuMs,
      budgets.autosaveDeriveSnapshotCpuMs,
    ],
    [
      "autosave.invokeSaveWallMs",
      metrics.autosave?.invokeSaveWallMs,
      budgets.autosaveInvokeSaveWallMs,
    ],
    [
      "autosave.domainIpcCount",
      metrics.autosave?.domainIpcCount,
      budgets.autosaveDomainIpcCount,
    ],
    [
      "autosave.dbTransactionCount",
      metrics.autosave?.dbTransactionCount,
      budgets.autosaveDbTransactionCount,
    ],
    [
      "memory.startupBytes",
      metrics.memory?.startupBytes,
      budgets.startupMemoryBytes,
    ],
    ["memory.peakBytes", metrics.memory?.peakBytes, budgets.peakMemoryBytes],
    [
      "memory.peakByViewBytes.map",
      metrics.memory?.peakByViewBytes?.map,
      budgets.mapPeakMemoryBytes,
    ],
    [
      "memory.peakByViewBytes.timeline",
      metrics.memory?.peakByViewBytes?.timeline,
      budgets.timelinePeakMemoryBytes,
    ],
    [
      "memory.peakByViewBytes.linear",
      metrics.memory?.peakByViewBytes?.linear,
      budgets.linearPeakMemoryBytes,
    ],
    ["longTask.count", metrics.longTask?.count, budgets.longTaskCount],
    ["longTask.maxMs", metrics.longTask?.maxMs, budgets.longTaskMaxMs],
  ].map(([name, actual, max]) => ({
    name,
    actual,
    max,
    ok: finite(actual) && actual <= max,
    missing: !finite(actual),
  }));
  return {
    ok: checks.every((check) => check.ok),
    checks,
  };
}

export function formatRuntimeBudgetReport(result) {
  return result.checks
    .map((check) => {
      const status = check.ok ? "PASS" : "FAIL";
      const actual = check.missing ? "missing" : check.actual;
      return `[runtime-perf] ${status} ${check.name}: ${actual} (max ${check.max})`;
    })
    .join("\n");
}

function main(argv) {
  const metricsPath = argv[2];
  if (!metricsPath) {
    throw new Error(
      "usage: node scripts/runtime-performance-budget.mjs <metrics.json>",
    );
  }
  const metrics = JSON.parse(readFileSync(metricsPath, "utf8"));
  const result = evaluateRuntimePerformance(metrics);
  console.log(formatRuntimeBudgetReport(result));
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv);
}
