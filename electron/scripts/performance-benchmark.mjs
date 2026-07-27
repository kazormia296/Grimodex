#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { rootDir } from "./build.mjs";

const temporaryDirectory = mkdtempSync(
  path.join(os.tmpdir(), "grimodex-electron-perf-"),
);
const metricsPath = path.join(temporaryDirectory, "metrics.json");
const smokePath = path.join(rootDir, "electron", "scripts", "smoke.mjs");
const budgetPath = path.join(
  rootDir,
  "scripts",
  "runtime-performance-budget.mjs",
);

const smoke = spawnSync(process.execPath, [smokePath], {
  cwd: rootDir,
  env: {
    ...process.env,
    GRIMODEX_PERF_OUTPUT: metricsPath,
  },
  stdio: "inherit",
});
if (smoke.status !== 0) {
  console.error(
    `[electron:perf] smoke/measurement failed; metrics directory retained: ${temporaryDirectory}`,
  );
  process.exit(smoke.status ?? 1);
}

const budget = spawnSync(process.execPath, [budgetPath, metricsPath], {
  cwd: rootDir,
  stdio: "inherit",
});
if (budget.status !== 0) {
  console.error(
    `[electron:perf] budget failed; metrics retained: ${metricsPath}`,
  );
  process.exit(budget.status ?? 1);
}

rmSync(temporaryDirectory, { recursive: true, force: true });
console.log("[electron:perf] PASS");
