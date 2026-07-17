import assert from "node:assert/strict";
import test from "node:test";

import {
  aggregateProcessTree,
  buildVitestCommand,
  estimateSplitImpact,
  measureCommand,
  summarizeRuns,
} from "./browser-ci-benchmark.mjs";

test("buildVitestCommand keeps the baseline automatic and exposes measured candidates", () => {
  assert.deepEqual(buildVitestCommand({ suite: "browser" }), {
    executable: "pnpm",
    args: ["test:browser", "--run"],
  });
  assert.deepEqual(
    buildVitestCommand({
      suite: "browser",
      fileParallelism: false,
      maxWorkers: 1,
      shard: "1/2",
    }),
    {
      executable: "pnpm",
      args: [
        "test:browser",
        "--run",
        "--browser.fileParallelism=false",
        "--maxWorkers=1",
        "--shard=1/2",
      ],
    },
  );
  assert.deepEqual(buildVitestCommand({ suite: "storybook", maxWorkers: 2 }), {
    executable: "pnpm",
    args: ["test:storybook", "--run", "--maxWorkers=2"],
  });

  assert.throws(() => buildVitestCommand({ suite: "unit" }), /suite/);
  assert.throws(
    () => buildVitestCommand({ suite: "browser", maxWorkers: 0 }),
    /maxWorkers/,
  );
  assert.throws(
    () => buildVitestCommand({ suite: "browser", shard: "3/2" }),
    /shard/,
  );
});

test("aggregateProcessTree includes descendants and excludes unrelated processes", () => {
  const records = [
    { pid: 100, ppid: 1, rssPages: 10, cpuTicks: 2 },
    { pid: 101, ppid: 100, rssPages: 20, cpuTicks: 3 },
    { pid: 102, ppid: 101, rssPages: 30, cpuTicks: 5 },
    { pid: 200, ppid: 1, rssPages: 500, cpuTicks: 100 },
  ];

  assert.deepEqual(aggregateProcessTree(records, 100, 4096), {
    processCount: 3,
    rssBytes: 60 * 4096,
    cpuTicks: 10,
  });
});

test("summarizeRuns reports failures separately from successful timing samples", () => {
  const summary = summarizeRuns([
    {
      exitCode: 0,
      wallMs: 3_000,
      userCpuMs: 1_000,
      systemCpuMs: 200,
      peakRssBytes: 100,
    },
    {
      exitCode: 1,
      wallMs: 2_000,
      userCpuMs: 500,
      systemCpuMs: 100,
      peakRssBytes: 90,
    },
    {
      exitCode: 0,
      wallMs: 5_000,
      userCpuMs: 2_000,
      systemCpuMs: 300,
      peakRssBytes: 120,
    },
  ]);

  assert.equal(summary.totalRuns, 3);
  assert.equal(summary.passedRuns, 2);
  assert.equal(summary.failedRuns, 1);
  assert.equal(summary.failureRate, 1 / 3);
  assert.equal(summary.isFlaky, true);
  assert.equal(summary.wallMs.median, 4_000);
  assert.equal(summary.cpuMs.median, 1_750);
  assert.equal(summary.peakRssBytes.max, 120);
});

test("estimateSplitImpact compares critical path and runner cost", () => {
  assert.deepEqual(
    estimateSplitImpact({
      sharedSetupMs: 1_000,
      browserMs: 3_000,
      storybookMs: 1_000,
    }),
    {
      combinedCriticalPathMs: 5_000,
      splitCriticalPathMs: 4_000,
      criticalPathSavingsMs: 1_000,
      criticalPathSavingsRate: 0.2,
      combinedRunnerMs: 5_000,
      splitRunnerMs: 6_000,
      runnerCostIncreaseMs: 1_000,
      runnerCostIncreaseRate: 0.2,
    },
  );
});

test("measureCommand captures process-tree CPU and RSS without GNU time", async () => {
  const result = await measureCommand(
    process.execPath,
    [
      "-e",
      "const end = Date.now() + 80; let value = 0; while (Date.now() < end) value += Math.sqrt(value + 1);",
    ],
    { sampleIntervalMs: 5, stdio: "ignore" },
  );

  assert.equal(result.exitCode, 0);
  assert.ok(result.wallMs >= 40, `wallMs=${result.wallMs}`);
  assert.ok(result.userCpuMs + result.systemCpuMs > 0);
  assert.ok(result.peakRssBytes > 0);
  assert.ok(result.peakProcessCount >= 1);
});
