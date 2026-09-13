import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  aggregateProcessTree,
  buildBenchmarkConfiguration,
  buildVitestCommand,
  estimateSplitImpact,
  inspectVitestReport,
  measureCommand,
  preflightVitestReport,
  summarizeRuns,
} from "./browser-ci-benchmark.mjs";
import { groupMembers } from "./browser-ci-supervisor.mjs";

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
  assert.deepEqual(
    buildVitestCommand({
      suite: "webgl",
      fileParallelism: false,
      maxWorkers: 1,
    }),
    {
      executable: "pnpm",
      args: [
        "test:webgl",
        "--run",
        "--browser.fileParallelism=false",
        "--maxWorkers=1",
      ],
    },
  );

  assert.deepEqual(
    buildBenchmarkConfiguration({
      fileParallelism: false,
      maxWorkers: 1,
    }),
    {
      fileParallelism: false,
      maxWorkers: 1,
      shard: null,
      retry: 0,
      collectPss: false,
      sampleIntervalMs: 2_000,
      timeoutMs: 300_000,
    },
  );

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
  const valid = {
    childClose: { observed: true },
    terminationResult: { terminationVerified: true },
    vitest: { success: true, allTestsPassed: true },
    vitestReport: { status: "valid", fresh: true, boundToRun: true },
  };
  const summary = summarizeRuns([
    {
      ...valid,
      exitCode: 0,
      wallMs: 3_000,
      userCpuMs: 1_000,
      systemCpuMs: 200,
      peakRssBytes: 100,
    },
    {
      ...valid,
      exitCode: 1,
      wallMs: 2_000,
      userCpuMs: 500,
      systemCpuMs: 100,
      peakRssBytes: 90,
    },
    {
      ...valid,
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
  assert.equal(
    summarizeRuns([{ ...valid, exitCode: 0, childClose: { observed: false } }])
      .passedRuns,
    0,
  );
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
  if (result.resourceMetricsAvailable) {
    assert.ok(result.userCpuMs + result.systemCpuMs > 0);
    assert.ok(result.peakRssBytes > 0);
    assert.ok(result.peakProcessCount >= 1);
  }
});

test("measureCommand observes a child that exits during the initial sample", async () => {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error("short command completion was missed")),
      2_000,
    );
  });

  let result;
  try {
    result = await Promise.race([
      measureCommand(process.execPath, ["-e", ""], {
        sampleIntervalMs: 5,
        stdio: "ignore",
      }),
      timeout,
    ]);
  } finally {
    clearTimeout(timeoutId);
  }

  assert.equal(result.exitCode, 0);
});

const fakeChild = (pid, kill) =>
  Object.assign(new EventEmitter(), { pid, kill });
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const linuxRuntime = (pid, readProcRecords = async () => []) => ({
  platform: "linux",
  readIdentity: async () => ({
    state: "alive",
    identity: { pid, startTimeTicks: 7 },
    pgrp: pid,
  }),
  readProcRecords,
});

test("rootless Linux watchdog settles every identity failure without signaling", async () => {
  const cases = [
    ["pending", () => new Promise(() => {})],
    ["unverified", async () => ({ state: "unverified", identity: null })],
    [
      "rejected",
      async () => {
        throw new Error("identity read failed");
      },
    ],
    ["gone", async () => ({ state: "gone", identity: null })],
  ];

  for (const [label, readIdentity] of cases) {
    const pid = 52_000 + cases.findIndex(([name]) => name === label);
    const child = fakeChild(pid, () => {
      throw new Error(`${label} child must not receive a direct signal`);
    });
    const signals = [];
    const started = Date.now();
    const result = await measureCommand(process.execPath, ["-e", ""], {
      timeoutMs: 30,
      stdio: "ignore",
      sampleIntervalMs: 5,
      spawn: () => child,
      kill: (groupPid, signal) => signals.push({ groupPid, signal }),
      runtime: {
        platform: "linux",
        cleanupTimeoutMs: 40,
        readIdentity,
        readProcRecords: async () => [],
      },
    });

    assert.ok(
      Date.now() - started < 500,
      `${label} did not settle within the injected watchdog + cleanup bound`,
    );
    assert.equal(result.exitCode, 1, label);
    assert.equal(result.childClose.observed, false, label);
    assert.equal(result.terminationResult.terminationVerified, false, label);
    assert.equal(result.terminationResult.closeTimedOut, true, label);
    assert.deepEqual(signals, [], label);
    assert.ok(result.terminationResult.errors.length > 0, label);
    assert.ok(result.firstFailure !== null, label);
  }
});

test("early SIGINT settles rootless Linux cleanup and preserves the requested signal", async () => {
  const child = fakeChild(52_100, () => {
    throw new Error("rootless child must not receive a direct signal");
  });
  const signals = [];
  const identityStarted = deferred();
  const started = Date.now();
  const resultPromise = measureCommand(process.execPath, ["-e", ""], {
    timeoutMs: 200,
    stdio: "ignore",
    sampleIntervalMs: 5,
    spawn: () => child,
    kill: (groupPid, signal) => signals.push({ groupPid, signal }),
    runtime: {
      platform: "linux",
      cleanupTimeoutMs: 40,
      readIdentity: async () => {
        identityStarted.resolve();
        return new Promise(() => {});
      },
      readProcRecords: async () => [],
    },
  });
  // The identity read starts after signal listeners are installed.
  await identityStarted.promise;
  assert.equal(process.emit("SIGINT"), true);
  assert.deepEqual(signals, []);

  const result = await resultPromise;
  assert.ok(Date.now() - started < 500);
  assert.equal(result.exitCode, 1);
  assert.equal(result.forwardedSignal, "SIGINT");
  assert.equal(result.childClose.observed, false);
  assert.equal(result.terminationResult.terminationVerified, false);
  assert.equal(result.terminationResult.termSignal, "SIGINT");
  assert.equal(result.terminationResult.actions[0]?.signal, "SIGINT");
  assert.match(
    result.terminationResult.actions[0]?.error?.message ?? "",
    /identity unavailable|refusing signal/,
  );
  assert.deepEqual(signals, []);
});

test("early SIGINT waits for a delayed verified identity before group cleanup", async () => {
  const child = fakeChild(52_101, () => {
    throw new Error("verified Linux cleanup must use the process group");
  });
  const signals = [];
  const identityStarted = deferred();
  const identityReady = deferred();
  const resultPromise = measureCommand(process.execPath, ["-e", ""], {
    timeoutMs: 200,
    stdio: "ignore",
    sampleIntervalMs: 5,
    spawn: () => child,
    kill: (groupPid, signal) => signals.push({ groupPid, signal }),
    runtime: {
      platform: "linux",
      cleanupTimeoutMs: 40,
      readIdentity: async () => {
        identityStarted.resolve();
        await identityReady.promise;
        return {
          state: "alive",
          identity: { pid: child.pid, startTimeTicks: 7 },
          pgrp: child.pid,
        };
      },
      readProcRecords: async () => [],
    },
  });
  await identityStarted.promise;
  assert.equal(process.emit("SIGINT"), true);
  assert.deepEqual(signals, []);
  identityReady.resolve();

  const result = await resultPromise;
  assert.equal(result.exitCode, 1);
  assert.equal(result.forwardedSignal, "SIGINT");
  assert.equal(result.terminationResult.actions[0]?.signal, "SIGINT");
  assert.equal(result.terminationResult.actions[0]?.identityVerified, true);
  assert.deepEqual(signals[0], { groupPid: -child.pid, signal: "SIGINT" });
});

test("supervisor fails closed for systemic or malformed /proc scans", async () => {
  const denied = new Error("permission denied");
  denied.code = "EACCES";
  assert.equal(
    await groupMembers({
      platform: "linux",
      readDirectory: async () => ["100", "101"],
      readStat: async () => {
        throw denied;
      },
      selfPid: 1,
    }),
    null,
  );

  assert.equal(
    await groupMembers({
      platform: "linux",
      readDirectory: async () => ["100"],
      readStat: async () => "100 (malformed",
      selfPid: 1,
    }),
    null,
  );

  const vanished = new Error("process exited during scan");
  vanished.code = "ENOENT";
  assert.deepEqual(
    await groupMembers({
      platform: "linux",
      readDirectory: async () => ["100"],
      readStat: async () => {
        throw vanished;
      },
      selfPid: 1,
    }),
    [],
  );
});

test("normal exit cleans a same-PGID TERM-ignoring descendant", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "grimodex-supervisor-"),
  );
  const pidPath = path.join(directory, "descendant.pid");
  const code =
    "const fs=require('node:fs');const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:'ignore'});fs.writeFileSync(process.env.GX_DESC_PID,String(c.pid));setTimeout(()=>process.exit(0),25);";
  try {
    const result = await measureCommand(process.execPath, ["-e", code], {
      env: { ...process.env, GX_DESC_PID: pidPath },
      stdio: "ignore",
      sampleIntervalMs: 5,
    });
    const pid = Number((await readFile(pidPath, "utf8")).trim());
    assert.equal(result.exitCode, 1);
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("watchdog escalates TERM/KILL and non-Linux timeout stays unverified", async () => {
  const child = fakeChild(43_210, () => {
    throw new Error("Linux watchdog must signal the process group");
  });
  const result = await measureCommand(process.execPath, ["-e", ""], {
    timeoutMs: 30,
    stdio: "ignore",
    sampleIntervalMs: 5,
    spawn: () => child,
    kill: (pid, signal) => {
      if (signal === "SIGKILL")
        setImmediate(() => child.emit("close", 1, "SIGKILL"));
    },
    runtime: linuxRuntime(43_210),
  });
  assert.equal(result.timedOut, true);
  assert.deepEqual(
    result.terminationResult.actions.map(({ signal }) => signal),
    ["SIGTERM", "SIGKILL"],
  );
  assert.equal(result.terminationResult.terminationVerified, true);

  for (const platform of ["darwin", "win32"]) {
    const direct = new EventEmitter();
    direct.pid = 43_211;
    direct.kill = (signal) => {
      setImmediate(() => direct.emit("close", null, signal));
      return true;
    };
    const directResult = await measureCommand(process.execPath, ["-e", ""], {
      timeoutMs: 10,
      platform,
      spawn: () => direct,
      stdio: "ignore",
      runtime: { platform, readProcRecords: async () => [] },
    });
    assert.equal(directResult.resourceMetricsAvailable, false);
    assert.equal(directResult.terminationResult.terminationVerified, false);
  }
});

test("Linux identity mismatch refuses process-group signaling", async () => {
  let identityCalls = 0;
  const child = fakeChild(42_424, () => true);
  let signaled = false;
  setTimeout(() => child.emit("close", 0, null), 40);
  const result = await measureCommand(process.execPath, ["-e", ""], {
    timeoutMs: 10,
    stdio: "ignore",
    spawn: () => child,
    kill: () => {
      signaled = true;
    },
    runtime: {
      ...linuxRuntime(42_424),
      readIdentity: async (pid) => ({
        state: "alive",
        identity: { pid, startTimeTicks: ++identityCalls === 1 ? 7 : 8 },
        pgrp: pid,
      }),
    },
  });
  assert.equal(signaled, false);
  assert.equal(result.terminationResult.terminationVerified, false);
});

test("final process scan settles when its reader never resolves", async () => {
  let scans = 0;
  const killCalls = [];
  const child = fakeChild(51_000, () => true);
  const started = Date.now();
  const result = await measureCommand(process.execPath, ["-e", ""], {
    platform: "linux",
    spawn: () => {
      queueMicrotask(() => child.emit("close", 0, null));
      return child;
    },
    stdio: "ignore",
    runtime: {
      ...linuxRuntime(51_000, async () => {
        scans += 1;
        return scans === 1 ? [] : new Promise(() => {});
      }),
      kill: (...args) => killCalls.push(args),
    },
  });
  assert.equal(result.childClose.observed, true);
  assert.equal(result.timedOut, false);
  assert.equal(result.terminationResult.attempted, false);
  assert.deepEqual(killCalls, []);
  assert.equal(result.finalSampleTimedOut, true);
  assert.ok(Date.now() - started < 5_800);
});

function reportFixture(overrides = {}) {
  return {
    success: true,
    numTotalTestSuites: 127,
    numPassedTestSuites: 127,
    numFailedTestSuites: 0,
    numPendingTestSuites: 0,
    numTotalTests: 253,
    numPassedTests: 253,
    numFailedTests: 0,
    numPendingTests: 0,
    numTodoTests: 0,
    testResults: Array.from({ length: 55 }, (_, index) => ({
      name: `suite-${index}.test.ts`,
      status: "passed",
      assertionResults: Array.from({ length: index < 33 ? 5 : 4 }, () => ({
        status: "passed",
      })),
    })),
    ...overrides,
  };
}

test("Vitest preflight is nonce-bound and inspection fails closed", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "grimodex-vitest-"));
  const reportPath = path.join(directory, "run.json");
  try {
    await writeFile(reportPath, JSON.stringify({ stale: true }), "utf8");
    const preflight = await preflightVitestReport(reportPath);
    assert.equal(preflight.status, "stale-removed");
    assert.equal(
      (await inspectVitestReport(reportPath, { run: 1, preflight })).status,
      "missing",
    );

    const unpassed = (status, key) => {
      const report = reportFixture({
        success: false,
        numPassedTests: 252,
        [key]: 1,
      });
      report.testResults[0].assertionResults[0].status = status;
      return report;
    };
    const cases = [
      ["invalid", { nope: true }],
      ["failed", unpassed("failed", "numFailedTests")],
      ["failed", unpassed("pending", "numPendingTests")],
      ["failed", unpassed("todo", "numTodoTests")],
      ["invalid", { ...reportFixture(), numTotalTests: 252 }],
      ["invalid", { ...reportFixture(), numPassedTests: 252 }],
    ];
    const inspect = async (report, status) => {
      await writeFile(reportPath, JSON.stringify(report), "utf8");
      assert.equal(
        (
          await inspectVitestReport(reportPath, {
            run: 1,
            preflight: { status: "absent" },
          })
        ).status,
        status,
      );
    };
    for (const [status, report] of cases) {
      await inspect(report, status);
    }

    await writeFile(reportPath, JSON.stringify(reportFixture()), "utf8");
    const passing = await inspectVitestReport(reportPath, {
      run: 1,
      preflight: { status: "absent" },
    });
    assert.equal(passing.status, "valid");
    assert.equal(passing.evidence.testFiles.length, 55);
    assert.equal(passing.evidence.numTotalTests, 253);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
