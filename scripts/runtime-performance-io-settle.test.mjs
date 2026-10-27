import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  RUNTIME_PERFORMANCE_IO_SETTLE_POLICY,
  buildRuntimePerformanceIoSettlePath,
  formatRuntimePerformanceIoSettleLine,
  isRuntimePerformanceIoSettleEnabled,
  readHostIoPressure,
  runHostSync,
  runRuntimePerformanceIoSettleStep,
  settleHostIoBeforeMeasurement,
  writeRuntimePerformanceIoSettleEvidence,
} from "../electron/scripts/runtime-performance-io-settle.mjs";
import { prepareRuntimePerformanceArtifacts } from "../electron/scripts/performance-benchmark.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const CI = { CI: "true" };

function psi(fullAvg10, { some = fullAvg10 + 1, total = 0 } = {}) {
  return (
    `some avg10=${some.toFixed(2)} avg60=1.00 avg300=0.50 total=${total + 10}\n` +
    `full avg10=${fullAvg10.toFixed(2)} avg60=1.00 avg300=0.50 total=${total}\n`
  );
}

/**
 * Fake host: `readings` are successive /proc/pressure/io contents (the last
 * one repeats), the clock only advances through `sleep` and `syncMs`.
 */
function fakeHost(readings, { syncMs = 0, syncStatus = "completed" } = {}) {
  let clock = 0;
  let reads = 0;
  const calls = { sleeps: [], syncTimeouts: [], paths: [] };
  return {
    calls,
    get reads() {
      return reads;
    },
    options: {
      platform: "linux",
      env: CI,
      now: () => clock,
      sleep: (milliseconds) => {
        calls.sleeps.push(milliseconds);
        clock += milliseconds;
      },
      runSync: (timeoutMs) => {
        calls.syncTimeouts.push(timeoutMs);
        clock += syncMs;
        return syncStatus;
      },
      readFile: (filePath) => {
        calls.paths.push(filePath);
        const value = readings[Math.min(reads, readings.length - 1)];
        reads += 1;
        if (value instanceof Error) throw value;
        return value;
      },
    },
  };
}

test("the settle policy is fixed: <2% io full avg10, 60 s cap, 1 s polls", () => {
  assert.deepEqual(RUNTIME_PERFORMANCE_IO_SETTLE_POLICY, {
    metric: "io.full.avg10",
    maximumFullAvg10Percent: 2,
    maximumWaitMs: 60_000,
    pollIntervalMs: 1_000,
  });
  assert.ok(Object.isFrozen(RUNTIME_PERFORMANCE_IO_SETTLE_POLICY));
});

test("(f) io PSI parsing reads some/full avg10 and rejects incomplete files", () => {
  const read = (contents) =>
    readHostIoPressure({ readFile: () => contents, procRoot: "/proc" });
  const parsed = read(
    "some avg10=21.04 avg60=9.00 avg300=1.00 total=999\nfull avg10=19.77 avg60=7.00 avg300=0.50 total=888\n",
  );
  assert.equal(parsed.full.avg10, 19.77);
  assert.equal(parsed.some.avg10, 21.04);
  assert.equal(parsed.full.total, 888);
  // `full` is required: the gate keys on full, not some.
  assert.equal(read("some avg10=1.00 avg60=1.00 avg300=1.00 total=1\n"), null);
  assert.equal(
    read(
      "some avg10=1.00 avg60=1.00 avg300=1.00 total=1\nfull avg10=x avg60=1.00 avg300=1.00 total=1\n",
    ),
    null,
  );
  assert.equal(read(""), null);
  let requested = null;
  readHostIoPressure({
    procRoot: "/fake-proc",
    readFile: (filePath) => {
      requested = filePath;
      return psi(0);
    },
  });
  assert.equal(requested, path.join("/fake-proc", "pressure", "io"));
});

test("(a) low io pressure proceeds immediately after sync without sleeping", () => {
  const host = fakeHost(
    [psi(0.56, { total: 1_000 }), psi(0.7, { total: 3_000 })],
    {
      syncMs: 40,
    },
  );
  const record = settleHostIoBeforeMeasurement(host.options);
  assert.equal(record.status, "settled");
  assert.equal(record.reason, null);
  assert.equal(record.capReached, false);
  assert.deepEqual(host.calls.sleeps, []);
  assert.deepEqual(host.calls.syncTimeouts, [60_000]);
  assert.deepEqual(record.sync, { status: "completed", durationMs: 40 });
  assert.deepEqual(record.ioFullAvg10, { start: 0.56, end: 0.7 });
  assert.equal(record.pollCount, 1);
  assert.equal(record.waitedMs, 40);
  assert.equal(record.ioFullStallMs, 2);
  assert.ok(
    host.calls.paths.every((filePath) => filePath === "/proc/pressure/io"),
  );
});

test("(a) the ceiling is strict: exactly 2.00 keeps waiting, 1.99 proceeds", () => {
  const host = fakeHost([psi(30), psi(2), psi(1.99)]);
  const record = settleHostIoBeforeMeasurement(host.options);
  assert.equal(record.status, "settled");
  assert.equal(record.pollCount, 2);
  assert.deepEqual(host.calls.sleeps, [1_000]);
  assert.deepEqual(record.ioFullAvg10, { start: 30, end: 1.99 });
});

test("(b) pressure that stays high waits to the 60 s cap, then measures anyway", () => {
  const host = fakeHost(
    [psi(42.9, { total: 0 }), psi(42.9, { total: 5_000_000 })],
    {
      syncMs: 2_500,
    },
  );
  const record = settleHostIoBeforeMeasurement(host.options);
  assert.equal(record.status, "capped");
  assert.equal(record.reason, "maximum-wait-reached");
  assert.equal(record.capReached, true);
  assert.equal(record.waitedMs, 60_000);
  assert.equal(
    host.calls.sleeps.reduce((sum, value) => sum + value, 0),
    60_000 - 2_500,
  );
  assert.ok(host.calls.sleeps.every((value) => value > 0 && value <= 1_000));
  assert.deepEqual(record.ioFullAvg10, { start: 42.9, end: 42.9 });
  assert.equal(record.ioFullStallMs, 5_000);
  assert.deepEqual(record.sync, { status: "completed", durationMs: 2_500 });
});

test("(b) a sync that consumes the whole cap leaves one poll, then measures", () => {
  const host = fakeHost([psi(64), psi(64)], {
    syncMs: 61_000,
    syncStatus: "timed-out",
  });
  const record = settleHostIoBeforeMeasurement(host.options);
  assert.equal(record.status, "capped");
  assert.equal(record.pollCount, 1);
  assert.deepEqual(host.calls.sleeps, []);
  assert.equal(record.sync.status, "timed-out");
});

test("(b) a clock that never advances still ends the wait by poll count", () => {
  const host = fakeHost([psi(50)]);
  const record = settleHostIoBeforeMeasurement({
    ...host.options,
    now: () => 0,
    sleep: () => {},
  });
  assert.equal(record.status, "capped");
  assert.equal(record.pollCount, 61);
});

test("(c) pressure that drops below the ceiling mid-wait proceeds at that poll", () => {
  const host = fakeHost([
    psi(21),
    psi(21),
    psi(9.6),
    psi(4.5),
    psi(1.4),
    psi(50),
  ]);
  const record = settleHostIoBeforeMeasurement(host.options);
  assert.equal(record.status, "settled");
  assert.equal(record.pollCount, 4);
  assert.deepEqual(host.calls.sleeps, [1_000, 1_000, 1_000]);
  assert.equal(record.waitedMs, 3_000);
  assert.deepEqual(record.ioFullAvg10, { start: 21, end: 1.4 });
});

test("(d) missing PSI, non-Linux hosts, and developer runs skip without sync or wait", () => {
  const enoent = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  for (const [options, reason] of [
    [{ platform: "darwin" }, "platform"],
    [{ platform: "win32" }, "platform"],
    [{ env: {} }, "not-ci"],
    [{ env: { CI: "false" } }, "not-ci"],
    [{ readings: [enoent] }, "pressure-unavailable"],
    [
      {
        readings: [
          Object.assign(new Error("EOPNOTSUPP"), { code: "EOPNOTSUPP" }),
        ],
      },
      "pressure-unavailable",
    ],
    [
      { readings: ["some avg10=1.00 avg60=1.00 avg300=1.00 total=1\n"] },
      "pressure-unavailable",
    ],
  ]) {
    const host = fakeHost(options.readings ?? [psi(50)]);
    const record = settleHostIoBeforeMeasurement({
      ...host.options,
      ...(options.platform ? { platform: options.platform } : {}),
      ...(options.env ? { env: options.env } : {}),
    });
    assert.equal(record.status, "skipped", reason);
    assert.equal(record.reason, reason);
    assert.deepEqual(host.calls.syncTimeouts, [], reason);
    assert.deepEqual(host.calls.sleeps, [], reason);
    assert.equal(record.waitedMs, 0);
    assert.deepEqual(record.sync, { status: "not-run", durationMs: null });
  }
  assert.equal(isRuntimePerformanceIoSettleEnabled({ CI: "true" }), true);
  assert.equal(isRuntimePerformanceIoSettleEnabled({ CI: "1" }), true);
  assert.equal(isRuntimePerformanceIoSettleEnabled({}), false);
});

test("(d) PSI disappearing mid-wait records a failure and stops waiting", () => {
  const host = fakeHost([psi(30), psi(30), new Error("EIO")]);
  const record = settleHostIoBeforeMeasurement(host.options);
  assert.equal(record.status, "failed");
  assert.equal(record.reason, "pressure-unreadable-during-wait");
  assert.deepEqual(host.calls.sleeps, [1_000]);
  assert.deepEqual(record.ioFullAvg10, { start: 30, end: 30 });
});

test("sync runs as a bounded, killable child and maps its outcome", () => {
  const seen = [];
  const spawnSyncImpl = (command, args, options) => {
    seen.push({ command, args, options });
    return { status: 0 };
  };
  assert.equal(runHostSync(60_000, { spawnSyncImpl }), "completed");
  assert.deepEqual(seen[0], {
    command: "sync",
    args: [],
    options: { stdio: "ignore", timeout: 60_000, killSignal: "SIGKILL" },
  });
  assert.equal(
    runHostSync(1, {
      spawnSyncImpl: () => ({ status: null, error: { code: "ETIMEDOUT" } }),
    }),
    "timed-out",
  );
  assert.equal(
    runHostSync(1, { spawnSyncImpl: () => ({ status: 1 }) }),
    "failed",
  );
  assert.equal(
    runHostSync(1, {
      spawnSyncImpl: () => {
        throw new Error("ENOENT");
      },
    }),
    "failed",
  );
});

test("(e) settle and evidence failures never fail or stop the measurement step", () => {
  const attempts = [];
  const logs = [];
  const entry = runRuntimePerformanceIoSettleStep({
    attempt: 1,
    evidencePath: "/nonexistent/evidence.json",
    attempts,
    settle: () => {
      throw new Error("boom");
    },
    writeEvidence: () => {
      throw new Error("disk full");
    },
    log: (line) => logs.push(line),
    warn: (line) => logs.push(line),
    env: {},
  });
  assert.equal(entry.attempt, 1);
  assert.equal(entry.status, "failed");
  assert.equal(entry.reason, "settle-error");
  assert.equal(attempts.length, 1);

  const invalid = runRuntimePerformanceIoSettleStep({
    attempt: 2,
    evidencePath: null,
    attempts,
    settle: () => ({ status: "measure-later" }),
    log: () => {
      throw new Error("closed stdout");
    },
    warn: () => {
      throw new Error("closed stderr");
    },
    env: {},
  });
  assert.equal(invalid.status, "failed");
  assert.equal(invalid.reason, "settle-error");
  assert.deepEqual(
    attempts.map(({ attempt }) => attempt),
    [1, 2],
  );
});

test("the step records every attempt and annotates a reached cap in GitHub Actions", (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grimodex-io-settle-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const evidencePath = buildRuntimePerformanceIoSettlePath(
    path.join(directory, "runtime-metrics.json"),
  );
  assert.equal(
    evidencePath,
    path.join(directory, "runtime-metrics-io-settle.json"),
  );
  const attempts = [];
  const logs = [];
  const warnings = [];
  const capped = fakeHost([psi(40)]);
  runRuntimePerformanceIoSettleStep({
    attempt: 1,
    evidencePath,
    attempts,
    settle: () => settleHostIoBeforeMeasurement(capped.options),
    log: (line) => logs.push(line),
    warn: (line) => warnings.push(line),
    env: { GITHUB_ACTIONS: "true" },
  });
  const settled = fakeHost([psi(0.03)]);
  runRuntimePerformanceIoSettleStep({
    attempt: 2,
    evidencePath,
    attempts,
    settle: () => settleHostIoBeforeMeasurement(settled.options),
    log: (line) => logs.push(line),
    warn: (line) => warnings.push(line),
    env: { GITHUB_ACTIONS: "true" },
  });
  const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
  assert.equal(evidence.schemaVersion, 1);
  assert.deepEqual(
    evidence.attempts.map(({ attempt, status, capReached }) => ({
      attempt,
      status,
      capReached,
    })),
    [
      { attempt: 1, status: "capped", capReached: true },
      { attempt: 2, status: "settled", capReached: false },
    ],
  );
  for (const key of [
    "policy",
    "sync",
    "ioFullAvg10",
    "ioSomeAvg10",
    "ioFullStallMs",
    "waitedMs",
    "pollCount",
    "reason",
  ]) {
    assert.ok(Object.hasOwn(evidence.attempts[0], key), key);
  }
  assert.equal(evidence.attempts[0].waitedMs, 60_000);
  assert.match(warnings[0], /io-settle attempt 1: capped .*measuring anyway/u);
  assert.match(
    warnings[1],
    /^::warning title=Runtime performance I\/O settle cap::/u,
  );
  assert.equal(warnings.length, 2);
  assert.match(
    logs[0],
    /io-settle attempt 2: settled io full avg10 0\.03->0\.03/u,
  );
  assert.match(
    formatRuntimePerformanceIoSettleLine(3, {
      status: "skipped",
      reason: "not-ci",
    }),
    /attempt 3: skipped \(not-ci\)/u,
  );
});

test("evidence writes are atomic and report failure instead of throwing", (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grimodex-io-settle-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const target = path.join(directory, "nested", "evidence.json");
  assert.equal(writeRuntimePerformanceIoSettleEvidence(target, []), true);
  assert.deepEqual(JSON.parse(readFileSync(target, "utf8")), {
    schemaVersion: 1,
    attempts: [],
  });
  // A directory at the target path makes the rename fail.
  const blocked = path.join(directory, "nested");
  assert.equal(writeRuntimePerformanceIoSettleEvidence(blocked, []), false);
});

test("stale io-settle evidence is removed with the other attempt artifacts", (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "grimodex-io-settle-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const metrics = path.join(directory, "runtime-metrics.json");
  const evidencePath = buildRuntimePerformanceIoSettlePath(metrics);
  writeRuntimePerformanceIoSettleEvidence(evidencePath, [{ attempt: 1 }]);
  prepareRuntimePerformanceArtifacts(metrics);
  assert.throws(() => readFileSync(evidencePath), { code: "ENOENT" });
});

test("the benchmark settles before every measured launch and nothing gating reads it", async () => {
  const benchmark = await readFile(
    path.join(repoRoot, "electron/scripts/performance-benchmark.mjs"),
    "utf8",
  );
  const executeStart = benchmark.indexOf("const executeAttempt = (");
  const settleCall = benchmark.indexOf(
    "runRuntimePerformanceIoSettleStep({",
    executeStart,
  );
  const smokeSpawn = benchmark.indexOf(
    "spawnSync(smokeCommand, smokeArguments",
    executeStart,
  );
  assert.ok(executeStart >= 0 && settleCall > executeStart);
  assert.ok(smokeSpawn > settleCall, "settle precedes the measured launch");
  // The step's return value is not used to decide anything.
  assert.match(
    benchmark.slice(settleCall - 40, settleCall),
    /\n\s*$/u,
    "the settle result is not assigned or branched on",
  );

  const settleSource = await readFile(
    path.join(repoRoot, "electron/scripts/runtime-performance-io-settle.mjs"),
    "utf8",
  );
  for (const forbidden of [
    /runtime-performance-budget/u,
    /runtime-performance-retry/u,
    /coldStartMs/u,
    /evaluat/u,
    /process\.argv/u,
  ]) {
    assert.doesNotMatch(settleSource, forbidden);
  }
  for (const gating of [
    "scripts/runtime-performance-budget.mjs",
    "electron/scripts/runtime-performance-retry.mjs",
  ]) {
    const source = await readFile(path.join(repoRoot, gating), "utf8");
    assert.doesNotMatch(source, /io-settle|ioSettle|IoSettle/u, gating);
  }
});
