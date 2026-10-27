/**
 * Host I/O settling before each measured runtime-performance launch.
 *
 * On Linux CI only, flush dirty pages with `sync` and then poll
 * `/proc/pressure/io` until `full avg10` is below a fixed ceiling or a fixed
 * wait cap expires. Reaching the cap never fails the gate: the benchmark
 * measures anyway and the unchanged budgets decide. Nothing here reads
 * metrics, budgets, or retry decisions, so the wait cannot select a sample;
 * it only changes *when* the single measured launch starts.
 *
 * Every step degrades to an explicit record (`skipped` / `failed`) instead of
 * throwing, so a missing /proc source, a non-Linux host, a sandbox, or a
 * developer machine never fails or delays the gate.
 * See docs/plans/nir1-lane-decisions/perf-io-settle-decisions.md.
 */
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";

import { parsePressure } from "./runtime-performance-diagnostic.mjs";

export const RUNTIME_PERFORMANCE_IO_SETTLE_SCHEMA_VERSION = 1;

/**
 * Fixed before any result is seen (DR-PIS-1). The ceiling and the cap are not
 * inputs: no flag or environment variable changes them.
 */
export const RUNTIME_PERFORMANCE_IO_SETTLE_POLICY = Object.freeze({
  metric: "io.full.avg10",
  maximumFullAvg10Percent: 2,
  maximumWaitMs: 60_000,
  pollIntervalMs: 1_000,
});

export const RUNTIME_PERFORMANCE_IO_SETTLE_STATUSES = Object.freeze([
  "settled",
  "capped",
  "skipped",
  "failed",
]);

function round(value, digits = 1) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

/** The wait runs only where CI declares itself; developer runs never wait. */
export function isRuntimePerformanceIoSettleEnabled(env = process.env) {
  return env?.CI === "true" || env?.CI === "1";
}

/** Parsed `some`/`full` io PSI, or null when unreadable or incomplete. */
export function readHostIoPressure({
  procRoot = "/proc",
  readFile = readFileSync,
} = {}) {
  try {
    const parsed = parsePressure(
      String(readFile(path.join(procRoot, "pressure", "io"), "utf8")),
    );
    return parsed?.some && parsed?.full ? parsed : null;
  } catch {
    return null;
  }
}

/** Blocking `sync(1)`; returns a status string and never throws. */
export function runHostSync(
  timeoutMs = RUNTIME_PERFORMANCE_IO_SETTLE_POLICY.maximumWaitMs,
  { spawnSyncImpl = spawnSync } = {},
) {
  try {
    const result = spawnSyncImpl("sync", [], {
      stdio: "ignore",
      timeout: timeoutMs,
      killSignal: "SIGKILL",
    });
    if (result?.error?.code === "ETIMEDOUT") return "timed-out";
    if (result?.error || result?.status !== 0) return "failed";
    return "completed";
  } catch {
    return "failed";
  }
}

const sleepCell = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(milliseconds) {
  if (milliseconds > 0) Atomics.wait(sleepCell, 0, 0, milliseconds);
}

function baseRecord() {
  const policy = RUNTIME_PERFORMANCE_IO_SETTLE_POLICY;
  return {
    schemaVersion: RUNTIME_PERFORMANCE_IO_SETTLE_SCHEMA_VERSION,
    policy: { ...policy },
    status: "skipped",
    reason: null,
    sync: { status: "not-run", durationMs: null },
    ioFullAvg10: { start: null, end: null },
    ioSomeAvg10: { start: null, end: null },
    ioFullStallMs: null,
    waitedMs: 0,
    pollCount: 0,
    capReached: false,
  };
}

/**
 * Settle host I/O before one measured launch. Returns the evidence record;
 * the caller measures regardless of the returned status.
 */
export function settleHostIoBeforeMeasurement({
  platform = process.platform,
  env = process.env,
  procRoot = "/proc",
  readFile = readFileSync,
  runSync = runHostSync,
  now = () => performance.now(),
  sleep = sleepSync,
} = {}) {
  const policy = RUNTIME_PERFORMANCE_IO_SETTLE_POLICY;
  const record = baseRecord();
  if (platform !== "linux") {
    record.reason = "platform";
    return record;
  }
  if (!isRuntimePerformanceIoSettleEnabled(env)) {
    record.reason = "not-ci";
    return record;
  }
  const startedAt = now();
  const first = readHostIoPressure({ procRoot, readFile });
  if (!first) {
    record.reason = "pressure-unavailable";
    return record;
  }
  record.ioFullAvg10.start = first.full.avg10;
  record.ioSomeAvg10.start = first.some.avg10;

  const syncStartedAt = now();
  record.sync = {
    status: runSync(policy.maximumWaitMs),
    durationMs: round(now() - syncStartedAt),
  };

  // Bounded structurally by poll count as well as by the clock, so a stalled
  // or faulty clock still ends the wait.
  const maximumPolls =
    Math.ceil(policy.maximumWaitMs / policy.pollIntervalMs) + 1;
  let last = first;
  for (let poll = 1; poll <= maximumPolls; poll += 1) {
    const current = readHostIoPressure({ procRoot, readFile });
    if (!current) {
      record.status = "failed";
      record.reason = "pressure-unreadable-during-wait";
      break;
    }
    last = current;
    record.pollCount = poll;
    if (current.full.avg10 < policy.maximumFullAvg10Percent) {
      record.status = "settled";
      break;
    }
    const elapsedMs = now() - startedAt;
    if (!(elapsedMs < policy.maximumWaitMs) || poll === maximumPolls) {
      record.status = "capped";
      record.reason = "maximum-wait-reached";
      record.capReached = true;
      break;
    }
    sleep(Math.min(policy.pollIntervalMs, policy.maximumWaitMs - elapsedMs));
  }
  record.ioFullAvg10.end = last.full.avg10;
  record.ioSomeAvg10.end = last.some.avg10;
  // PSI `total` is cumulative stall time in microseconds.
  record.ioFullStallMs = round((last.full.total - first.full.total) / 1000);
  record.waitedMs = round(now() - startedAt);
  return record;
}

export function buildRuntimePerformanceIoSettlePath(metricsPath) {
  const parsed = path.parse(path.resolve(metricsPath));
  return path.join(parsed.dir, `${parsed.name}-io-settle${parsed.ext}`);
}

/** Atomic best-effort write; returns false instead of throwing. */
export function writeRuntimePerformanceIoSettleEvidence(
  evidencePath,
  attempts,
) {
  const temporaryPath = `${evidencePath}.tmp-${process.pid}`;
  try {
    mkdirSync(path.dirname(evidencePath), { recursive: true });
    writeFileSync(
      temporaryPath,
      `${JSON.stringify(
        {
          schemaVersion: RUNTIME_PERFORMANCE_IO_SETTLE_SCHEMA_VERSION,
          attempts,
        },
        null,
        2,
      )}\n`,
    );
    renameSync(temporaryPath, evidencePath);
    return true;
  } catch {
    try {
      rmSync(temporaryPath, { force: true });
    } catch {
      // Evidence is diagnostic only.
    }
    return false;
  }
}

export function formatRuntimePerformanceIoSettleLine(attempt, record) {
  const policy = record?.policy ?? RUNTIME_PERFORMANCE_IO_SETTLE_POLICY;
  if (record?.status === "skipped" || record?.status === "failed") {
    return `[electron:perf] io-settle attempt ${attempt}: ${record.status} (${record.reason ?? "unknown"})`;
  }
  const seconds = (value) =>
    typeof value === "number" ? `${round(value / 1000)}s` : "n/a";
  return (
    `[electron:perf] io-settle attempt ${attempt}: ${record?.status} ` +
    `io full avg10 ${record?.ioFullAvg10?.start ?? "n/a"}->${record?.ioFullAvg10?.end ?? "n/a"} ` +
    `(ceiling <${policy.maximumFullAvg10Percent}) waited ${seconds(record?.waitedMs)} ` +
    `of ${seconds(policy.maximumWaitMs)}; sync ${record?.sync?.status} ${seconds(record?.sync?.durationMs)}`
  );
}

/**
 * The benchmark's single entry point. Never throws: a settle or evidence
 * failure is recorded and the measurement proceeds unchanged.
 */
export function runRuntimePerformanceIoSettleStep({
  attempt,
  evidencePath,
  attempts,
  settle = settleHostIoBeforeMeasurement,
  writeEvidence = writeRuntimePerformanceIoSettleEvidence,
  log = console.log,
  warn = console.warn,
  env = process.env,
}) {
  let record;
  try {
    record = settle();
    if (
      !record ||
      !RUNTIME_PERFORMANCE_IO_SETTLE_STATUSES.includes(record.status)
    ) {
      throw new Error("invalid io settle record");
    }
  } catch {
    record = { ...baseRecord(), status: "failed", reason: "settle-error" };
  }
  const entry = { attempt, ...record };
  try {
    attempts.push(entry);
    if (evidencePath && !writeEvidence(evidencePath, attempts)) {
      warn("[electron:perf] io-settle evidence could not be written");
    }
    const line = formatRuntimePerformanceIoSettleLine(attempt, record);
    if (record.capReached) {
      warn(`${line}; measuring anyway`);
      if (env?.GITHUB_ACTIONS === "true") {
        warn(
          `::warning title=Runtime performance I/O settle cap::Host io full avg10 stayed at or above ${record.policy.maximumFullAvg10Percent}% for ${record.policy.maximumWaitMs} ms before attempt ${attempt}; measured anyway.`,
        );
      }
    } else {
      log(line);
    }
  } catch {
    // Logging and evidence are diagnostic only.
  }
  return entry;
}
