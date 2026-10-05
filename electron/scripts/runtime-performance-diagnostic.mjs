#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { rootDir } from "./build.mjs";
import { captureRuntimePerformanceBuildIdentity } from "./performance-benchmark.mjs";
import { buildRuntimePerformanceTimeoutArtifactPath } from "./performance-harness.mjs";
import { buildRuntimePerformanceAttemptPaths } from "./runtime-performance-retry.mjs";

export const RUNTIME_DIAGNOSTIC_SAMPLE_INTERVAL_MS = 250;
export const RUNTIME_DIAGNOSTIC_TIMEOUT_MS = 310_000;
export const RUNTIME_DIAGNOSTIC_TERM_GRACE_MS = 5_000;
export const RUNTIME_DIAGNOSTIC_KILL_GRACE_MS = 5_000;

const NORMAL_METRICS_RELATIVE_PATH =
  ".artifacts/electron-runtime-performance/runtime-metrics.json";
const NORMAL_IDENTITY_RELATIVE_PATH =
  ".artifacts/electron-runtime-performance/build-identity.json";

const LINUX_SUBREAPER_WRAPPER = String.raw`import ctypes
import os
import signal
import subprocess
import sys

libc = ctypes.CDLL(None, use_errno=True)
if libc.prctl(36, 1, 0, 0, 0) != 0:
    sys.exit(125)
value = ctypes.c_int()
if libc.prctl(37, ctypes.byref(value), 0, 0, 0) != 0 or value.value != 1:
    sys.exit(125)

def keep_owner_alive(_signum, _frame):
    pass

signal.signal(signal.SIGINT, keep_owner_alive)
signal.signal(signal.SIGTERM, keep_owner_alive)
try:
    command = subprocess.Popen(sys.argv[1:])
except OSError:
    sys.exit(127)
status = command.wait()
while True:
    try:
        os.waitpid(-1, 0)
    except InterruptedError:
        continue
    except ChildProcessError:
        break
sys.exit(status if status >= 0 else 128 - status)
`;

export function buildRuntimePerformanceDiagnosticPaths({
  projectRoot = rootDir,
  runId,
  attempt,
} = {}) {
  if (!/^\d+$/u.test(String(runId)) || !/^\d+$/u.test(String(attempt))) {
    throw new Error("github-run-identity-unavailable");
  }
  const directory = path.join(
    projectRoot,
    ".artifacts/electron-runtime-performance/diagnostic",
    `${runId}-${attempt}`,
  );
  return Object.freeze({
    directory,
    metrics: path.join(directory, "runtime-metrics.json"),
    profile: path.join(directory, "initial-autosave.cpu-profile.json"),
    report: path.join(directory, "runner-observation.json"),
  });
}

export function buildRunnerDiagnosticInvocation({
  projectRoot,
  paths,
  environment,
}) {
  const childEnvironment = { ...environment };
  delete childEnvironment.GRIMODEX_PERF_CAPTURE_BUILD_IDENTITY;
  delete childEnvironment.GRIMODEX_PERF_BUILD_IDENTITY_PATH;
  childEnvironment.GRIMODEX_PERF_CPU_PROFILE = path.relative(
    projectRoot,
    paths.profile,
  );
  return Object.freeze({
    command: process.execPath,
    args: [
      path.join(projectRoot, "electron/scripts/performance-benchmark.mjs"),
      "--output",
      path.relative(projectRoot, paths.metrics),
    ],
    cwd: projectRoot,
    env: childEnvironment,
  });
}

export function parseLinuxProcStat(contents) {
  const firstSpace = contents.indexOf(" ");
  const closingParenthesis = contents.lastIndexOf(")");
  if (firstSpace < 1 || closingParenthesis < firstSpace) return null;
  const pid = Number(contents.slice(0, firstSpace));
  const fields = contents
    .slice(closingParenthesis + 2)
    .trim()
    .split(/\s+/u);
  if (fields.length < 20) return null;
  const record = {
    pid,
    state: fields[0],
    ppid: Number(fields[1]),
    pgrp: Number(fields[2]),
    userTicks: Number(fields[11]),
    systemTicks: Number(fields[12]),
    startTimeTicks: Number(fields[19]),
  };
  return Number.isSafeInteger(record.pid) &&
    [
      record.ppid,
      record.pgrp,
      record.userTicks,
      record.systemTicks,
      record.startTimeTicks,
    ].every((value) => Number.isSafeInteger(value) && value >= 0)
    ? record
    : null;
}

export function parseLinuxProcIo(contents) {
  const values = new Map();
  for (const line of contents.split(/\r?\n/u)) {
    const match = /^(rchar|wchar|read_bytes|write_bytes):\s*(\d+)$/u.exec(line);
    if (match) values.set(match[1], Number(match[2]));
  }
  const keys = ["rchar", "wchar", "read_bytes", "write_bytes"];
  if (!keys.every((key) => Number.isSafeInteger(values.get(key)))) return null;
  return {
    rchar: values.get("rchar"),
    wchar: values.get("wchar"),
    readBytes: values.get("read_bytes"),
    writeBytes: values.get("write_bytes"),
  };
}

function parsePressure(contents) {
  const result = {};
  for (const line of contents.split(/\r?\n/u)) {
    const [kind, ...values] = line.trim().split(/\s+/u);
    if (kind !== "some" && kind !== "full") continue;
    const fields = Object.fromEntries(
      values.map((value) => {
        const separator = value.indexOf("=");
        return [value.slice(0, separator), Number(value.slice(separator + 1))];
      }),
    );
    if (
      [fields.avg10, fields.avg60, fields.avg300, fields.total].every(
        Number.isFinite,
      )
    ) {
      result[kind] = fields;
    }
  }
  return Object.keys(result).length > 0 ? result : null;
}

function readPressure(procRoot, kind) {
  try {
    return parsePressure(
      readFileSync(path.join(procRoot, "pressure", kind), "utf8"),
    );
  } catch {
    return null;
  }
}

function processGroupProbe(groupId) {
  if (
    !Number.isSafeInteger(groupId) ||
    groupId <= 0 ||
    groupId === process.pid
  ) {
    return "unknown";
  }
  try {
    process.kill(-groupId, 0);
    return "present";
  } catch (error) {
    if (error?.code === "ESRCH") return "absent";
    if (error?.code === "EPERM") return "present";
    return "unknown";
  }
}

function readProcStat(procRoot, pid) {
  try {
    return parseLinuxProcStat(
      readFileSync(path.join(procRoot, String(pid), "stat"), "utf8"),
    );
  } catch {
    return null;
  }
}

function inspectProcessIdentity(identity, procRoot) {
  let contents;
  try {
    contents = readFileSync(
      path.join(procRoot, String(identity.pid), "stat"),
      "utf8",
    );
  } catch (error) {
    return error?.code === "ENOENT"
      ? { status: "absent" }
      : { status: "unknown" };
  }
  const record = parseLinuxProcStat(contents);
  if (!record) return { status: "unknown" };
  if (record.startTimeTicks !== identity.startTimeTicks) {
    return { status: "absent" };
  }
  return { status: "present", record };
}

export function readLinuxProcessGroupSnapshot(
  groupId,
  { procRoot = "/proc", leaderIdentity = null } = {},
) {
  const startedNs = process.hrtime.bigint();
  const wallBeforeMs = Date.now();
  const clockBeforeNs = process.hrtime.bigint();
  const clockAfterNs = process.hrtime.bigint();
  const wallAfterMs = Date.now();
  const wallEpochMs = (wallBeforeMs + wallAfterMs) / 2;
  const monotonicNs = (clockBeforeNs + clockAfterNs) / 2n;
  let entries;
  try {
    entries = readdirSync(procRoot).filter((entry) => /^\d+$/u.test(entry));
  } catch {
    const pressure = {
      systemCpu: readPressure(procRoot, "cpu"),
      systemIo: readPressure(procRoot, "io"),
    };
    return {
      status: "unavailable",
      observerDurationMs: Number(process.hrtime.bigint() - startedNs) / 1e6,
      clock: null,
      groupProbe: processGroupProbe(groupId),
      leaderStartTimeTicks: null,
      processCount: null,
      liveProcessCount: null,
      zombieProcessCount: null,
      userCpuTicks: null,
      systemCpuTicks: null,
      cpuTicks: null,
      io: null,
      ioComplete: false,
      ownedProcesses: [],
      processGroups: [],
      pressure,
    };
  }

  const processTable = new Map();
  let processTableIncomplete = false;
  for (const entry of entries) {
    let contents;
    try {
      contents = readFileSync(path.join(procRoot, entry, "stat"), "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") processTableIncomplete = true;
      continue;
    }
    const record = parseLinuxProcStat(contents);
    if (record) processTable.set(record.pid, record);
    else processTableIncomplete = true;
  }

  const leader = processTable.get(groupId);
  const leaderMatches =
    leaderIdentity?.pid === groupId &&
    leader?.pid === groupId &&
    leader?.pgrp === groupId &&
    leader.startTimeTicks === leaderIdentity.startTimeTicks;
  const childrenByParent = new Map();
  for (const record of processTable.values()) {
    const children = childrenByParent.get(record.ppid) ?? [];
    children.push(record);
    childrenByParent.set(record.ppid, children);
  }
  const owned = [];
  if (leaderMatches) {
    const queue = [leader];
    const visited = new Set();
    while (queue.length > 0) {
      const record = queue.shift();
      if (visited.has(record.pid)) continue;
      visited.add(record.pid);
      owned.push(record);
      queue.push(...(childrenByParent.get(record.pid) ?? []));
    }
  }
  owned.sort((left, right) => left.pid - right.pid);

  const io = { rchar: 0, wchar: 0, readBytes: 0, writeBytes: 0 };
  let ioUnavailable = 0;
  for (const record of owned) {
    try {
      const counters = parseLinuxProcIo(
        readFileSync(path.join(procRoot, String(record.pid), "io"), "utf8"),
      );
      if (!counters) {
        ioUnavailable += 1;
        continue;
      }
      for (const key of Object.keys(io)) io[key] += counters[key];
    } catch {
      ioUnavailable += 1;
    }
  }

  const groupProbe = processGroupProbe(groupId);
  const pressure = {
    systemCpu: readPressure(procRoot, "cpu"),
    systemIo: readPressure(procRoot, "io"),
  };
  const live = owned.filter(
    (record) => record.state !== "Z" && record.state !== "X",
  );
  const groups = new Map();
  for (const record of owned) {
    const group = groups.get(record.pgrp) ?? [];
    group.push(record);
    groups.set(record.pgrp, group);
  }
  const processGroups = [...groups.entries()]
    .map(([ownedGroupId, records]) => ({
      groupId: ownedGroupId,
      processCount: records.length,
      liveProcessCount: records.filter(
        (record) => record.state !== "Z" && record.state !== "X",
      ).length,
      leaderStartTimeTicks:
        records.find((record) => record.pid === ownedGroupId)?.startTimeTicks ??
        null,
    }))
    .sort((left, right) => left.groupId - right.groupId);
  const durationMs = Number(process.hrtime.bigint() - startedNs) / 1e6;
  return {
    status:
      !leaderMatches ||
      processTableIncomplete ||
      groupProbe === "unknown" ||
      (groupProbe === "present" &&
        !owned.some((record) => record.pgrp === groupId))
        ? "incomplete"
        : "complete",
    observerDurationMs: durationMs,
    clock: {
      wallEpochMs,
      monotonicNs: monotonicNs.toString(),
      uncertaintyMs:
        0.5 +
        Number(clockAfterNs - clockBeforeNs) / 2e6 +
        (wallAfterMs - wallBeforeMs) / 2,
    },
    groupProbe,
    leaderStartTimeTicks: leaderMatches ? leader.startTimeTicks : null,
    processCount: owned.length,
    liveProcessCount: live.length,
    zombieProcessCount: owned.length - live.length,
    userCpuTicks: owned.reduce((total, record) => total + record.userTicks, 0),
    systemCpuTicks: owned.reduce(
      (total, record) => total + record.systemTicks,
      0,
    ),
    cpuTicks: owned.reduce(
      (total, record) => total + record.userTicks + record.systemTicks,
      0,
    ),
    io,
    ioComplete: ioUnavailable === 0,
    ioUnavailableProcessCount: ioUnavailable,
    ownedProcesses: owned.map(({ pid, ppid, pgrp, state, startTimeTicks }) => ({
      pid,
      ppid,
      pgrp,
      state,
      startTimeTicks,
    })),
    processGroups,
    pressure,
  };
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForCloseOrDelay(closePromise, getClose, timeoutMs) {
  if (getClose()) return;
  let timer;
  try {
    await Promise.race([
      closePromise,
      new Promise((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function rememberOwnedIdentities(snapshot, identities) {
  for (const identity of snapshot.ownedProcesses ?? []) {
    identities.set(`${identity.pid}:${identity.startTimeTicks}`, identity);
  }
}

function ownedIdentitiesAbsent(identities, procRoot) {
  let unknown = false;
  for (const identity of identities.values()) {
    const inspection = inspectProcessIdentity(identity, procRoot);
    if (inspection.status === "present") return false;
    if (inspection.status === "unknown") unknown = true;
  }
  return !unknown;
}

export function signalOwnedProcess(
  identity,
  signal,
  { procRoot = "/proc", killImpl = process.kill } = {},
) {
  if (
    !Number.isSafeInteger(identity?.pid) ||
    identity.pid <= 0 ||
    identity.pid === process.pid ||
    !Number.isSafeInteger(identity?.startTimeTicks)
  ) {
    return "refused-invalid-owner";
  }
  const inspection = inspectProcessIdentity(identity, procRoot);
  if (inspection.status === "absent") return "already-gone";
  if (inspection.status !== "present") return "refused-owner-identity";
  if (inspection.record.state === "Z" || inspection.record.state === "X") {
    return "already-gone";
  }
  try {
    killImpl(identity.pid, signal);
    return "sent";
  } catch (error) {
    return error?.code === "ESRCH" ? "already-gone" : "failed";
  }
}

export function signalOwnedGroup(
  groupId,
  leaderIdentity,
  signal,
  { procRoot = "/proc", killImpl = process.kill } = {},
) {
  if (
    !Number.isSafeInteger(groupId) ||
    groupId <= 0 ||
    groupId === process.pid ||
    leaderIdentity?.pid !== groupId ||
    !Number.isSafeInteger(leaderIdentity?.startTimeTicks)
  ) {
    return "refused-invalid-owner";
  }
  const inspection = inspectProcessIdentity(leaderIdentity, procRoot);
  if (
    inspection.status !== "present" ||
    inspection.record.pgrp !== groupId ||
    inspection.record.state === "Z" ||
    inspection.record.state === "X"
  ) {
    return "refused-owner-identity";
  }
  try {
    killImpl(-groupId, signal);
    return "sent";
  } catch (error) {
    return error?.code === "ESRCH" ? "already-gone" : "failed";
  }
}

function signalOwnedDescendantGroups(
  snapshot,
  ownerGroupId,
  signal,
  signaledGroups,
  procRoot,
) {
  const results = [];
  for (const group of snapshot.processGroups ?? []) {
    if (group.groupId === ownerGroupId || group.liveProcessCount === 0) {
      continue;
    }
    const leaderIdentity = Number.isSafeInteger(group.leaderStartTimeTicks)
      ? {
          pid: group.groupId,
          pgrp: group.groupId,
          startTimeTicks: group.leaderStartTimeTicks,
        }
      : null;
    const key = leaderIdentity
      ? `${group.groupId}:${leaderIdentity.startTimeTicks}`
      : `${group.groupId}:members`;
    if (signaledGroups.has(key)) continue;
    signaledGroups.add(key);
    if (leaderIdentity) {
      const result = signalOwnedGroup(group.groupId, leaderIdentity, signal, {
        procRoot,
      });
      results.push(result);
      if (result === "sent") continue;
    }
    for (const identity of (snapshot.ownedProcesses ?? []).filter(
      (processIdentity) =>
        processIdentity.pgrp === group.groupId &&
        processIdentity.state !== "Z" &&
        processIdentity.state !== "X",
    )) {
      results.push(signalOwnedProcess(identity, signal, { procRoot }));
    }
  }
  if (results.includes("sent")) return "sent";
  if (results.includes("failed")) return "failed";
  if (results.includes("refused-owner-identity")) return "identity-rejected";
  return results.length > 0 ? "already-gone" : "not-needed";
}

async function waitForOwnedTermination({
  getClose,
  leaderIdentity,
  identities,
  timeoutMs,
  procRoot,
  samples,
  signal,
}) {
  const deadline = performance.now() + timeoutMs;
  const signaledGroups = new Set();
  let lastSnapshot = null;
  let descendantSignal = "not-needed";
  while (true) {
    lastSnapshot = readLinuxProcessGroupSnapshot(leaderIdentity.pid, {
      procRoot,
      leaderIdentity,
    });
    if (!getClose() || lastSnapshot.status === "complete") {
      samples.push(lastSnapshot);
    }
    rememberOwnedIdentities(lastSnapshot, identities);
    if (signal) {
      const result = signalOwnedDescendantGroups(
        lastSnapshot,
        leaderIdentity.pid,
        signal,
        signaledGroups,
        procRoot,
      );
      if (result === "sent") descendantSignal = "sent";
      else if (result === "failed" && descendantSignal !== "sent") {
        descendantSignal = "failed";
      } else if (
        result === "identity-rejected" &&
        descendantSignal === "not-needed"
      ) {
        descendantSignal = "identity-rejected";
      }
    }
    if (
      getClose() &&
      processGroupProbe(leaderIdentity.pid) === "absent" &&
      ownedIdentitiesAbsent(identities, procRoot)
    ) {
      return { complete: true, lastSnapshot, descendantSignal };
    }
    if (performance.now() >= deadline) {
      return { complete: false, lastSnapshot, descendantSignal };
    }
    await delay(Math.min(50, Math.max(1, deadline - performance.now())));
  }
}

export async function runObservedRuntimeCommand({
  command,
  args,
  cwd,
  env,
  procRoot = "/proc",
  sampleIntervalMs = RUNTIME_DIAGNOSTIC_SAMPLE_INTERVAL_MS,
  timeoutMs = RUNTIME_DIAGNOSTIC_TIMEOUT_MS,
  termGraceMs = RUNTIME_DIAGNOSTIC_TERM_GRACE_MS,
  killGraceMs = RUNTIME_DIAGNOSTIC_KILL_GRACE_MS,
  spawnImpl = spawn,
} = {}) {
  const limits = { sampleIntervalMs, timeoutMs, termGraceMs, killGraceMs };
  if (process.platform !== "linux") {
    return {
      exit: null,
      spawnError: "unsupported-platform",
      stopReason: "precheck",
      samples: [],
      limits,
      cleanup: { status: "not-started", actualTermination: false },
    };
  }
  let child;
  try {
    child = spawnImpl(
      "python3",
      ["-c", LINUX_SUBREAPER_WRAPPER, command, ...(args ?? [])],
      {
        cwd,
        env,
        detached: true,
        stdio: "inherit",
        shell: false,
      },
    );
  } catch (error) {
    return {
      exit: null,
      spawnError: error?.code ?? error?.name ?? "spawn-error",
      stopReason: "spawn-error",
      samples: [],
      limits,
      cleanup: { status: "not-started", actualTermination: false },
    };
  }

  let close = null;
  let spawnError = null;
  let interrupted = null;
  let resolveClose;
  const closePromise = new Promise((resolve) => {
    resolveClose = resolve;
  });
  child.once("error", (error) => {
    spawnError = error?.code ?? error?.name ?? "spawn-error";
  });
  child.once("close", (code, signal) => {
    close = { code, signal };
    resolveClose(close);
  });
  const onInterrupt = (signal) => {
    interrupted ??= signal;
  };
  const onSigint = () => onInterrupt("SIGINT");
  const onSigterm = () => onInterrupt("SIGTERM");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);

  const groupId = Number.isSafeInteger(child.pid) ? child.pid : null;
  const samples = [];
  const ownedIdentities = new Map();
  const startedAt = new Date().toISOString();
  const deadline = performance.now() + timeoutMs;
  let leaderIdentity = null;
  let stopReason = null;
  const captureLeaderIdentity = () => {
    if (leaderIdentity || groupId === null) return;
    const record = readProcStat(procRoot, groupId);
    if (
      record?.pid === groupId &&
      record.pgrp === groupId &&
      record.state !== "Z" &&
      record.state !== "X"
    ) {
      leaderIdentity = {
        pid: groupId,
        pgrp: groupId,
        startTimeTicks: record.startTimeTicks,
      };
      ownedIdentities.set(
        `${groupId}:${record.startTimeTicks}`,
        leaderIdentity,
      );
    }
  };
  const observe = () => {
    captureLeaderIdentity();
    const snapshot = readLinuxProcessGroupSnapshot(groupId, {
      procRoot,
      leaderIdentity,
    });
    rememberOwnedIdentities(snapshot, ownedIdentities);
    return snapshot;
  };
  try {
    while (!close && !stopReason) {
      if (interrupted) {
        stopReason = `signal-${interrupted}`;
        break;
      }
      const remainingMs = deadline - performance.now();
      if (remainingMs <= 0) {
        stopReason = "diagnostic-timeout";
        break;
      }
      const snapshot = observe();
      if (!close || snapshot.status === "complete") samples.push(snapshot);
      if (close) break;
      await waitForCloseOrDelay(
        closePromise,
        () => close,
        Math.min(sampleIntervalMs, Math.max(1, remainingMs)),
      );
    }

    let termResult = "not-needed";
    let killResult = "not-needed";
    let forcedOwnerKill = false;
    let groupProbe = processGroupProbe(groupId);
    const knownOwnersAbsent = () =>
      ownedIdentitiesAbsent(ownedIdentities, procRoot);
    if (!close || groupProbe !== "absent" || !knownOwnersAbsent()) {
      if (leaderIdentity) {
        termResult = signalOwnedGroup(groupId, leaderIdentity, "SIGTERM", {
          procRoot,
        });
        const termWait = await waitForOwnedTermination({
          getClose: () => close,
          leaderIdentity,
          identities: ownedIdentities,
          timeoutMs: termGraceMs,
          procRoot,
          samples,
          signal: "SIGTERM",
        });
        if (termWait.descendantSignal !== "not-needed") {
          termResult =
            termWait.descendantSignal === "sent" || termResult === "sent"
              ? "sent"
              : termWait.descendantSignal;
        }
        groupProbe = processGroupProbe(groupId);
        if (!termWait.complete) {
          const killGroups = new Set();
          const descendantKill = signalOwnedDescendantGroups(
            termWait.lastSnapshot,
            groupId,
            "SIGKILL",
            killGroups,
            procRoot,
          );
          if (descendantKill !== "not-needed") killResult = descendantKill;
          if (groupProbe !== "absent") {
            const ownerKill = signalOwnedGroup(
              groupId,
              leaderIdentity,
              "SIGKILL",
              { procRoot },
            );
            if (ownerKill === "sent") forcedOwnerKill = true;
            if (ownerKill !== "not-needed") {
              killResult =
                ownerKill === "sent" || killResult === "sent"
                  ? "sent"
                  : ownerKill;
            }
          }
          const killWait = await waitForOwnedTermination({
            getClose: () => close,
            leaderIdentity,
            identities: ownedIdentities,
            timeoutMs: killGraceMs,
            procRoot,
            samples,
            signal: "SIGKILL",
          });
          if (killWait.descendantSignal !== "not-needed") {
            killResult =
              killWait.descendantSignal === "sent" || killResult === "sent"
                ? "sent"
                : killWait.descendantSignal;
          }
        }
      } else if (!close) {
        await waitForCloseOrDelay(
          closePromise,
          () => close,
          termGraceMs + killGraceMs,
        );
      }
    }

    groupProbe = processGroupProbe(groupId);
    const actualTermination =
      leaderIdentity !== null &&
      close !== null &&
      groupProbe === "absent" &&
      knownOwnersAbsent() &&
      !forcedOwnerKill;
    return {
      startedAt,
      finishedAt: new Date().toISOString(),
      leaderPid: groupId,
      leaderStartTimeTicks: leaderIdentity?.startTimeTicks ?? null,
      exit: close,
      spawnError,
      stopReason: stopReason ?? (interrupted ? `signal-${interrupted}` : null),
      samples,
      limits,
      cleanup: {
        status: actualTermination ? "complete" : "unproven",
        termSignal: termResult,
        killSignal: killResult,
        groupProbe,
        closeObserved: close !== null,
        trackedOwnedProcessCount: ownedIdentities.size,
        finalOwnedIdentitiesAbsent: knownOwnersAbsent(),
        forcedOwnerKill,
        actualTermination,
      },
    };
  } finally {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
  }
}

function quantile(values, probability) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.ceil(sorted.length * probability) - 1,
  );
  return sorted[index];
}

function summarizeObservation(samples) {
  const durations = samples
    .map((sample) => sample.observerDurationMs)
    .filter(Number.isFinite);
  const monotonicTimes = samples.map((sample) => {
    try {
      return BigInt(sample.clock.monotonicNs);
    } catch {
      return null;
    }
  });
  const intervals = [];
  for (let index = 1; index < monotonicTimes.length; index += 1) {
    const previous = monotonicTimes[index - 1];
    const current = monotonicTimes[index];
    if (previous !== null && current !== null) {
      intervals.push(Number(current - previous) / 1e6);
    }
  }
  return {
    sampleCount: samples.length,
    requestedSampleDelayMs: RUNTIME_DIAGNOSTIC_SAMPLE_INTERVAL_MS,
    observedStartIntervalMs: {
      median: quantile(intervals, 0.5),
      p95: quantile(intervals, 0.95),
      max: intervals.length ? Math.max(...intervals) : null,
    },
    observerDurationMs: {
      median: quantile(durations, 0.5),
      p95: quantile(durations, 0.95),
      max: durations.length ? Math.max(...durations) : null,
      total: durations.reduce((sum, value) => sum + value, 0),
    },
    completeSamples: samples.filter(
      (sample) => sample.status === "complete" && sample.ioComplete,
    ).length,
    pressureSamples: samples.filter(
      (sample) => sample.pressure.systemCpu && sample.pressure.systemIo,
    ).length,
    clockUncertaintyMsMax: samples.reduce(
      (maximum, sample) =>
        Number.isFinite(sample.clock?.uncertaintyMs)
          ? Math.max(maximum, sample.clock.uncertaintyMs)
          : maximum,
      0,
    ),
  };
}

function fingerprint(filePath, projectRoot) {
  try {
    const bytes = readFileSync(filePath);
    return {
      path: path.relative(projectRoot, filePath).split(path.sep).join("/"),
      status: "present",
      size: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  } catch (error) {
    return {
      path: path.relative(projectRoot, filePath).split(path.sep).join("/"),
      status: error?.code === "ENOENT" ? "missing" : "unavailable",
      reason: error?.code ?? "read-error",
    };
  }
}

function fingerprintNormalEvidence(projectRoot) {
  const attempts = buildRuntimePerformanceAttemptPaths(
    path.join(projectRoot, NORMAL_METRICS_RELATIVE_PATH),
  );
  const files = [
    path.join(projectRoot, NORMAL_IDENTITY_RELATIVE_PATH),
    attempts.canonical,
    attempts.firstEvidence,
    attempts.secondEvidence,
    buildRuntimePerformanceTimeoutArtifactPath(attempts.canonical),
    buildRuntimePerformanceTimeoutArtifactPath(attempts.firstEvidence),
    buildRuntimePerformanceTimeoutArtifactPath(attempts.secondEvidence),
  ];
  return Promise.all(
    files.map((filePath) => fingerprint(filePath, projectRoot)),
  );
}

async function writeReport(filePath, report) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}`;
  writeFileSync(temporaryPath, `${JSON.stringify(report, null, 2)}\n`, {
    mode: 0o600,
  });
  renameSync(temporaryPath, filePath);
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export async function runRunnerBoundRuntimeDiagnostic({
  env = process.env,
  projectRoot = rootDir,
  spawnImpl = spawn,
  procRoot = "/proc",
} = {}) {
  if (
    env.GITHUB_ACTIONS !== "true" ||
    env.GRIMODEX_REQUIRED_RUNTIME_GATE_OUTCOME !== "failure"
  ) {
    console.error(
      "[electron:perf:diagnostic] not invoked by a failed hosted runtime gate",
    );
    return 1;
  }
  const paths = buildRuntimePerformanceDiagnosticPaths({
    projectRoot,
    runId: env.GITHUB_RUN_ID,
    attempt: env.GITHUB_RUN_ATTEMPT,
  });
  if (existsSync(paths.directory)) {
    console.error(
      "[electron:perf:diagnostic] refusing to overwrite prior run evidence",
    );
    return 1;
  }
  mkdirSync(path.dirname(paths.directory), { recursive: true });
  try {
    mkdirSync(paths.directory);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    console.error(
      "[electron:perf:diagnostic] refusing to overwrite prior run evidence",
    );
    return 1;
  }

  const report = {
    schemaVersion: 1,
    kind: "electron-runtime-performance-runner-diagnostic",
    requiredRuntimeGateOutcome: "failure",
    status: "not-run",
    normalBuildIdentity: null,
    diagnosticBuildIdentity: null,
    normalEvidenceBefore: await fingerprintNormalEvidence(projectRoot),
    diagnostic: null,
  };
  let diagnosticExitCode = 1;
  try {
    if (process.platform !== "linux") {
      report.reason = "ubuntu-linux-required";
    } else {
      const normalIdentity = JSON.parse(
        readFileSync(
          path.join(projectRoot, NORMAL_IDENTITY_RELATIVE_PATH),
          "utf8",
        ),
      );
      report.normalBuildIdentity = normalIdentity;
      if (normalIdentity?.status !== "captured" || !normalIdentity.identity) {
        report.reason = "normal-build-identity-unavailable";
      } else if (
        normalIdentity?.run?.id !== env.GITHUB_RUN_ID ||
        normalIdentity?.run?.attempt !== env.GITHUB_RUN_ATTEMPT
      ) {
        report.reason = "normal-build-identity-run-mismatch";
      } else {
        const currentIdentityArtifact = captureRuntimePerformanceBuildIdentity(
          path.join(paths.directory, "diagnostic-build-identity.json"),
        );
        const currentIdentity = currentIdentityArtifact?.identity ?? null;
        report.diagnosticBuildIdentity = currentIdentity;
        if (!currentIdentity) {
          report.reason = "diagnostic-build-identity-unavailable";
        } else if (!sameJson(normalIdentity.identity, currentIdentity)) {
          report.reason = "normal-and-diagnostic-build-identity-mismatch";
        } else {
          const invocation = buildRunnerDiagnosticInvocation({
            projectRoot,
            paths,
            environment: env,
          });
          const observation = await runObservedRuntimeCommand({
            ...invocation,
            procRoot,
            spawnImpl,
          });
          const profileArtifact = await fingerprint(paths.profile, projectRoot);
          const metricsArtifact = await fingerprint(paths.metrics, projectRoot);
          report.diagnostic = {
            output: metricsArtifact,
            cpuProfile: profileArtifact,
            observation: summarizeObservation(observation.samples),
            samples: observation.samples,
            process: {
              leaderPid: observation.leaderPid ?? null,
              leaderStartTimeTicks: observation.leaderStartTimeTicks ?? null,
              exit: observation.exit,
              spawnError: observation.spawnError ?? null,
              stopReason: observation.stopReason,
              limits: observation.limits ?? null,
              cleanup: observation.cleanup,
            },
          };
          const evidenceComplete =
            observation.cleanup?.actualTermination === true &&
            observation.cleanup.termSignal === "not-needed" &&
            observation.cleanup.killSignal === "not-needed" &&
            observation.stopReason === null &&
            (observation.spawnError === null ||
              observation.spawnError === undefined) &&
            observation.exit?.code === 0 &&
            profileArtifact.status === "present" &&
            metricsArtifact.status === "present" &&
            observation.samples.length > 0 &&
            observation.samples.every(
              (sample) =>
                sample.status === "complete" &&
                sample.ioComplete &&
                sample.pressure.systemCpu &&
                sample.pressure.systemIo,
            );
          report.status = evidenceComplete
            ? "diagnostic-only-pass"
            : "diagnostic-only-failure-or-incomplete";
          diagnosticExitCode = evidenceComplete ? 0 : 1;
        }
      }
    }
  } catch (error) {
    report.reason = error?.code ?? error?.name ?? "diagnostic-error";
  }

  try {
    report.normalEvidenceAfter = await fingerprintNormalEvidence(projectRoot);
    report.normalEvidenceUnchanged = sameJson(
      report.normalEvidenceBefore,
      report.normalEvidenceAfter,
    );
    if (report.normalEvidenceUnchanged === false) {
      report.status = "diagnostic-only-failure-or-incomplete";
      diagnosticExitCode = 1;
    }
    report.finishedAt = new Date().toISOString();
    await writeReport(paths.report, report);
  } catch {
    console.error(
      "[electron:perf:diagnostic] could not retain diagnostic report",
    );
    diagnosticExitCode = 1;
  }
  return diagnosticExitCode;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await runRunnerBoundRuntimeDiagnostic();
}
