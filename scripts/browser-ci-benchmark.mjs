#!/usr/bin/env node

import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const VALID_SUITES = new Set(["browser", "storybook", "webgl"]);
export const DEFAULT_SAMPLE_INTERVAL_MS = 2_000;
export const DEFAULT_TIMEOUT_MS = 300_000;
const TERM_GRACE_MS = 1_000;
const TERMINATION_GRACE_MS = 5_000;
export const FINAL_SAMPLE_TIMEOUT_MS = 5_000;
const SUPERVISOR_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "browser-ci-supervisor.mjs",
);

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function validateShard(shard) {
  if (shard === undefined) return;
  const match = /^(\d+)\/(\d+)$/.exec(shard);
  if (!match) throw new Error("shard must use the <index>/<count> format");
  const index = Number(match[1]);
  const count = Number(match[2]);
  if (index < 1 || count < 1 || index > count) {
    throw new Error("shard index must be between 1 and count");
  }
}

export function buildVitestCommand({
  suite,
  fileParallelism,
  maxWorkers,
  shard,
}) {
  if (!VALID_SUITES.has(suite)) {
    throw new Error(`suite must be one of: ${[...VALID_SUITES].join(", ")}`);
  }
  if (maxWorkers !== undefined) {
    positiveInteger(maxWorkers, "maxWorkers");
  }
  if (fileParallelism !== undefined && typeof fileParallelism !== "boolean") {
    throw new Error("fileParallelism must be a boolean when specified");
  }
  validateShard(shard);

  const args = [`test:${suite}`, "--run"];
  if (fileParallelism === false) {
    args.push("--browser.fileParallelism=false");
  } else if (fileParallelism === true) {
    args.push("--browser.fileParallelism=true");
  }
  if (maxWorkers !== undefined) args.push(`--maxWorkers=${maxWorkers}`);
  if (shard !== undefined) args.push(`--shard=${shard}`);

  return { executable: "pnpm", args };
}

export function buildBenchmarkConfiguration(options) {
  const sampleIntervalMs = positiveInteger(
    options.sampleIntervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS,
    "sampleIntervalMs",
  );
  return {
    fileParallelism: options.fileParallelism ?? "auto",
    maxWorkers: options.maxWorkers ?? "auto",
    shard: options.shard ?? null,
    retry: 0,
    collectPss: options.collectPss ?? false,
    sampleIntervalMs,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
}

function selectProcessTree(records, rootPid) {
  const selectedPids = new Set([rootPid]);

  for (const record of records) {
    if (record.pgrp === rootPid) selectedPids.add(record.pid);
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const record of records) {
      if (!selectedPids.has(record.pid) && selectedPids.has(record.ppid)) {
        selectedPids.add(record.pid);
        changed = true;
      }
    }
  }

  return records.filter((record) => selectedPids.has(record.pid));
}

export function aggregateProcessTree(records, rootPid, pageSize) {
  const selected = selectProcessTree(records, rootPid);
  return selected.reduce(
    (aggregate, record) => ({
      processCount: aggregate.processCount + 1,
      rssBytes: aggregate.rssBytes + Math.max(0, record.rssPages) * pageSize,
      cpuTicks: aggregate.cpuTicks + Math.max(0, record.cpuTicks),
    }),
    { processCount: 0, rssBytes: 0, cpuTicks: 0 },
  );
}

function parseProcStat(contents) {
  const firstSpace = contents.indexOf(" ");
  const closingParenthesis = contents.lastIndexOf(")");
  if (firstSpace < 1 || closingParenthesis < firstSpace) return undefined;

  const pid = Number(contents.slice(0, firstSpace));
  const fields = contents
    .slice(closingParenthesis + 2)
    .trim()
    .split(/\s+/);
  if (fields.length < 22) return undefined;

  const userTicks = Number(fields[11]);
  const systemTicks = Number(fields[12]);
  return {
    pid,
    state: fields[0],
    ppid: Number(fields[1]),
    pgrp: Number(fields[2]),
    userTicks,
    systemTicks,
    cpuTicks: userTicks + systemTicks,
    startTimeTicks: Number(fields[19]),
    rssPages: Number(fields[21]),
  };
}

async function readProcRecords() {
  if (process.platform !== "linux") return [];
  // Numeric /proc entries can disappear between readdir and Dirent type
  // resolution. Read names only so every process-exit race is contained by the
  // per-stat try/catch below instead of rejecting the whole measurement.
  const entries = await readdir("/proc");
  const records = await Promise.all(
    entries
      .filter((entry) => /^\d+$/.test(entry))
      .map(async (entry) => {
        try {
          return parseProcStat(
            await readFile(path.join("/proc", entry, "stat"), "utf8"),
          );
        } catch {
          return undefined;
        }
      }),
  );
  return records.filter(Boolean);
}

async function readPssBytes(pid) {
  try {
    const rollup = await readFile(`/proc/${pid}/smaps_rollup`, "utf8");
    const match = /^Pss:\s+(\d+)\s+kB$/m.exec(rollup);
    return match ? Number(match[1]) * 1_024 : null;
  } catch {
    return null;
  }
}

function sysconf(name, fallback) {
  try {
    return positiveInteger(
      execFileSync("getconf", [name], { encoding: "utf8" }).trim(),
      name,
    );
  } catch {
    return fallback;
  }
}

async function commandInvocation(executable, args) {
  const gnuTime = "/usr/bin/time";
  if (process.platform !== "linux") {
    return { executable, args, timeOutput: null, temporaryDirectory: null };
  }

  try {
    await access(gnuTime);
  } catch {
    return { executable, args, timeOutput: null, temporaryDirectory: null };
  }

  const temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), "grimodex-browser-time-"),
  );
  const timeOutput = path.join(temporaryDirectory, "resource-usage.txt");
  return {
    executable: gnuTime,
    args: [
      "-f",
      "user_seconds=%U\nsystem_seconds=%S\nmax_rss_kib=%M",
      "-o",
      timeOutput,
      "--",
      executable,
      ...args,
    ],
    timeOutput,
    temporaryDirectory,
  };
}

async function readGnuTimeMetrics(timeOutput) {
  if (timeOutput === null) return null;
  try {
    const values = Object.fromEntries(
      (await readFile(timeOutput, "utf8"))
        .trim()
        .split("\n")
        .map((line) => line.split("=", 2)),
    );
    const userCpuMs = Number(values.user_seconds) * 1_000;
    const systemCpuMs = Number(values.system_seconds) * 1_000;
    const maxRssBytes = Number(values.max_rss_kib) * 1_024;
    if (![userCpuMs, systemCpuMs, maxRssBytes].every(Number.isFinite)) {
      return null;
    }
    return { userCpuMs, systemCpuMs, maxRssBytes };
  } catch {
    return null;
  }
}

const serializeError = (error) => ({
  name: error instanceof Error ? error.name : "Error",
  message: error instanceof Error ? error.message : String(error),
  stack: error instanceof Error ? error.stack : null,
});
const remainingMs = (deadlineNs, cap = Number.POSITIVE_INFINITY) =>
  Math.max(
    0,
    Math.min(
      cap,
      Math.ceil(Number(deadlineNs - process.hrtime.bigint()) / 1_000_000),
    ),
  );

async function bounded(operation, deadlineNs, cap = Number.POSITIVE_INFINITY) {
  const timeoutMs = remainingMs(deadlineNs, cap);
  if (timeoutMs <= 0) return { timedOut: true, value: null, error: null };
  let timer;
  const pending = Promise.resolve()
    .then(operation)
    .then(
      (value) => ({ timedOut: false, value, error: null }),
      (error) => ({ timedOut: false, value: null, error }),
    );
  const timeout = new Promise((resolve) => {
    timer = setTimeout(
      () => resolve({ timedOut: true, value: null, error: null }),
      timeoutMs,
    );
  });
  const result = await Promise.race([pending, timeout]);
  clearTimeout(timer);
  return result;
}

const processToken = (record) =>
  record &&
  Number.isSafeInteger(record.pid) &&
  Number.isSafeInteger(record.startTimeTicks)
    ? { pid: record.pid, startTimeTicks: record.startTimeTicks }
    : null;
const sameIdentity = (left, right) =>
  left?.pid === right?.pid && left?.startTimeTicks === right?.startTimeTicks;

async function readProcessIdentity(pid, platform) {
  if (platform !== "linux") return { state: "unsupported", identity: null };
  try {
    const record = parseProcStat(await readFile(`/proc/${pid}/stat`, "utf8"));
    if (record === undefined || processToken(record) === null) {
      return {
        state: "unverified",
        identity: null,
        error: new Error("invalid process identity"),
      };
    }
    return {
      state: record.state === "Z" ? "gone" : "alive",
      identity: processToken(record),
      pgrp: record.pgrp,
    };
  } catch (error) {
    return error?.code === "ENOENT" || error?.code === "ESRCH"
      ? { state: "gone", identity: null }
      : { state: "unverified", identity: null, error };
  }
}

function runtimeFor({
  runtime = {},
  platform,
  spawnImpl,
  killImpl,
  watchdogTimeoutMs,
}) {
  const selectedPlatform = runtime.platform ?? platform ?? process.platform;
  return {
    platform: selectedPlatform,
    spawn: runtime.spawn ?? spawnImpl ?? spawn,
    kill: runtime.kill ?? killImpl ?? process.kill,
    readProcRecords: runtime.readProcRecords ?? readProcRecords,
    readIdentity:
      runtime.readIdentity ??
      runtime.readProcessIdentity ??
      ((pid) => readProcessIdentity(pid, selectedPlatform)),
    supervisorPath: runtime.supervisorPath ?? SUPERVISOR_PATH,
    watchdogMs:
      runtime.watchdogTimeoutMs ?? watchdogTimeoutMs ?? DEFAULT_TIMEOUT_MS,
    cleanupMs: runtime.cleanupTimeoutMs ?? TERMINATION_GRACE_MS,
  };
}

async function signalLinuxGroup(root, signal, runtime, deadlineNs) {
  const result = {
    signal,
    target: "supervisor-process-group",
    pid: root?.pid ?? null,
    identityVerified: false,
    delivered: false,
    error: null,
  };
  if (root === null) {
    result.error = serializeError(
      new Error("supervisor identity unavailable; refusing signal"),
    );
    return result;
  }
  const current = await bounded(
    () => runtime.readIdentity(root.pid),
    deadlineNs,
  );
  if (current.value?.state === "gone") {
    result.identityVerified = true;
    return result;
  }
  if (
    current.timedOut ||
    current.error !== null ||
    current.value?.state !== "alive"
  ) {
    result.error = serializeError(
      current.error ??
        current.value?.error ??
        new Error("supervisor identity unavailable"),
    );
    return result;
  }
  const currentIdentity = processToken(current.value.identity);
  if (
    currentIdentity === null ||
    !sameIdentity(root, currentIdentity) ||
    current.value.pgrp !== root.pid
  ) {
    result.error = serializeError(
      new Error("supervisor PID/PGID identity changed; refusing signal"),
    );
    return result;
  }
  try {
    runtime.kill(-root.pid, signal);
    result.identityVerified = true;
    result.delivered = true;
  } catch (error) {
    result.error = serializeError(error);
  }
  return result;
}

async function terminateProcess({
  child,
  childClose,
  root,
  runtime,
  initialSignal = "SIGTERM",
}) {
  const deadlineNs =
    process.hrtime.bigint() + BigInt(runtime.cleanupMs) * 1_000_000n;
  const result = {
    attempted: true,
    pid: child.pid ?? null,
    platform: runtime.platform,
    termSignal: initialSignal,
    killSignal: null,
    escalated: false,
    actions: [],
    childCloseAfterTerm: false,
    childCloseAfterKill: false,
    closeTimedOut: false,
    terminationVerified: false,
    survivingPids: [],
    errors: [],
  };
  const send = async (signal) => {
    if (runtime.platform === "linux") {
      result.actions.push(
        await signalLinuxGroup(root, signal, runtime, deadlineNs),
      );
      return;
    }
    const action = {
      signal,
      target: "direct-child",
      identityVerified: false,
      delivered: false,
      error: null,
    };
    try {
      action.delivered = child.kill(signal) !== false;
    } catch (error) {
      action.error = serializeError(error);
    }
    result.actions.push(action);
  };
  await send(initialSignal);
  let close = await bounded(() => childClose, deadlineNs, TERM_GRACE_MS);
  result.childCloseAfterTerm = close.value?.observed === true;
  if (!result.childCloseAfterTerm) {
    result.escalated = true;
    result.killSignal = "SIGKILL";
    await send("SIGKILL");
    close = await bounded(() => childClose, deadlineNs);
    result.childCloseAfterKill = close.value?.observed === true;
  }
  result.closeTimedOut = !close.value?.observed;
  if (runtime.platform === "linux") {
    const scan = await bounded(() => runtime.readProcRecords(), deadlineNs);
    if (scan.timedOut || scan.error !== null || !Array.isArray(scan.value)) {
      result.errors.push(
        serializeError(
          scan.error ?? new Error("process group scan unavailable"),
        ),
      );
    } else {
      const groupPid = root?.pid;
      result.survivingPids = scan.value
        .filter(
          (record) => record.pid !== child.pid && record.pgrp === groupPid,
        )
        .map((record) => record.pid);
    }
  }
  result.errors.push(
    ...result.actions.map((action) => action.error).filter(Boolean),
  );
  result.terminationVerified =
    close.value?.observed === true &&
    runtime.platform === "linux" &&
    result.survivingPids.length === 0 &&
    result.errors.length === 0;
  return { terminationResult: result, close: close.value ?? null };
}

function noTermination(pid, platform, completion = null) {
  const observed = completion?.observed === true;
  const clean =
    observed && completion.exitCode === 0 && completion.signal === null;
  return {
    attempted: false,
    pid: pid ?? null,
    platform,
    termSignal: null,
    killSignal: null,
    escalated: false,
    actions: [],
    childCloseAfterTerm: false,
    childCloseAfterKill: false,
    closeTimedOut: false,
    supervisorEnforced: platform === "linux" && observed && !clean,
    terminationVerified: clean,
    survivingPids: [],
    errors: [],
  };
}

export async function measureCommand(
  executable,
  args,
  {
    cwd = process.cwd(),
    env = process.env,
    sampleIntervalMs = DEFAULT_SAMPLE_INTERVAL_MS,
    runtime: runtimeOptions = {},
    platform,
    timeoutMs,
    spawn: spawnImpl,
    kill: killImpl,
    stdio = "inherit",
    collectPss = false,
  } = {},
) {
  sampleIntervalMs = positiveInteger(sampleIntervalMs, "sampleIntervalMs");
  if (typeof collectPss !== "boolean") {
    throw new Error("collectPss must be a boolean");
  }
  if (timeoutMs !== undefined) positiveInteger(timeoutMs, "timeoutMs");
  const runtime = runtimeFor({
    runtime: runtimeOptions,
    platform,
    spawnImpl,
    killImpl,
    watchdogTimeoutMs: timeoutMs,
  });
  const watchdogMs = positiveInteger(runtime.watchdogMs, "watchdogMs");
  const startedAt = new Date();
  const startedNs = process.hrtime.bigint();
  const pageSize = sysconf("PAGESIZE", 4096);
  const clockTicks = sysconf("CLK_TCK", 100);
  const invocation = await commandInvocation(executable, args);
  const linux = runtime.platform === "linux";
  const child = runtime.spawn(
    linux ? process.execPath : invocation.executable,
    linux
      ? [runtime.supervisorPath, invocation.executable, ...invocation.args]
      : invocation.args,
    { cwd, env, stdio, detached: linux },
  );
  const deadlineNs = process.hrtime.bigint() + BigInt(watchdogMs) * 1_000_000n;
  let root = null;
  let identityPending = linux && child.pid !== undefined;
  let timedOut = false;
  let firstFailure = null;
  let finalSampleTimedOut = false;
  const rememberFailure = (error) => {
    if (firstFailure !== null) return;
    firstFailure =
      error &&
      typeof error === "object" &&
      typeof error.name === "string" &&
      typeof error.message === "string"
        ? {
            name: error.name,
            message: error.message,
            stack: typeof error.stack === "string" ? error.stack : null,
          }
        : serializeError(error);
  };
  let resolveWatchdog;
  const watchdog = new Promise((resolve) => {
    resolveWatchdog = resolve;
  });
  let terminationPromise = null;
  let resolveClose;
  let childError = null;
  const childClose = new Promise((resolve) => {
    resolveClose = resolve;
  });
  const onError = (error) => {
    childError = error;
    resolveClose({ observed: false, exitCode: null, signal: null, error });
  };
  const onClose = (exitCode, signal) => {
    resolveClose({ observed: true, exitCode, signal });
  };
  child.once("error", onError);
  child.once("close", onClose);
  let terminationRequestedSignal = null;
  function beginTermination(
    initialSignal = "SIGTERM",
    { allowUnverified = false } = {},
  ) {
    terminationRequestedSignal ??= initialSignal;
    if (terminationPromise !== null) return;
    // An external signal may arrive while the initial identity read is still
    // pending. Defer termination so a later verified identity can still make
    // the group cleanup safe. The watchdog uses allowUnverified only once its
    // bounded deadline has expired, producing a fail-closed result instead of
    // hanging forever.
    if (linux && root === null && identityPending && !allowUnverified) return;
    terminationPromise = terminateProcess({
      child,
      childClose,
      root,
      runtime,
      initialSignal: terminationRequestedSignal,
    }).catch((error) => ({
      terminationResult: {
        ...noTermination(child.pid, runtime.platform),
        attempted: true,
        terminationVerified: false,
        errors: [serializeError(error)],
      },
      close: null,
    }));
    terminationPromise.then(resolveWatchdog);
  }
  let forwardedSignal = null;
  const forwardSignal = (signal) => {
    forwardedSignal = signal;
    rememberFailure(
      Object.assign(new Error(`benchmark interrupted by ${signal}`), {
        name: "InterruptedError",
      }),
    );
    beginTermination(signal === "SIGINT" ? "SIGINT" : "SIGTERM");
  };
  const forwardInterrupt = () => forwardSignal("SIGINT");
  const forwardTermination = () => forwardSignal("SIGTERM");
  process.once("SIGINT", forwardInterrupt);
  process.once("SIGTERM", forwardTermination);
  // Arm synchronously after spawn; every later measurement/identity operation
  // is bounded by this fixed deadline.
  const watchdogTimer = setTimeout(() => {
    timedOut = true;
    rememberFailure(
      Object.assign(
        new Error(`benchmark child exceeded ${watchdogMs}ms watchdog`),
        {
          name: "TimeoutError",
        },
      ),
    );
    beginTermination(undefined, { allowUnverified: true });
  }, watchdogMs);

  if (linux && child.pid !== undefined) {
    const identity = await bounded(
      () => runtime.readIdentity(child.pid),
      deadlineNs,
    );
    const value = identity.value;
    const identityToken = processToken(value?.identity);
    if (
      !identity.timedOut &&
      identity.error === null &&
      value?.state === "alive" &&
      identityToken?.pid === child.pid &&
      value.pgrp === child.pid
    ) {
      root = { ...identityToken, pgrp: value.pgrp };
    } else if (value?.state !== "gone") {
      rememberFailure(
        identity.error ??
          value?.error ??
          new Error("supervisor identity unavailable"),
      );
    }
    identityPending = false;
  }
  if (terminationRequestedSignal !== null) {
    beginTermination(terminationRequestedSignal);
  }

  let peakRssBytes = 0;
  let peakPssBytes = 0;
  let peakProcessCount = 0;
  let peakPssProcessCount = 0;
  const cpuByPid = new Map();
  let sampleInFlight;

  const sample = () => {
    if (sampleInFlight !== undefined) return sampleInFlight;
    if (child.pid === undefined) return Promise.resolve();
    const currentSample = (async () => {
      const result = await bounded(
        async () => {
          const records = await runtime.readProcRecords();
          const selected = selectProcessTree(records, child.pid);
          const aggregate = aggregateProcessTree(records, child.pid, pageSize);
          const pssValues = collectPss
            ? (
                await Promise.all(
                  selected.map((record) => readPssBytes(record.pid)),
                )
              ).filter((value) => value !== null)
            : null;
          return { selected, aggregate, pssValues };
        },
        deadlineNs,
        FINAL_SAMPLE_TIMEOUT_MS,
      );
      if (result.timedOut || result.error !== null || result.value === null) {
        rememberFailure(
          result.error ?? new Error("process measurement timed out"),
        );
        return;
      }
      const { selected, aggregate, pssValues } = result.value;
      peakRssBytes = Math.max(peakRssBytes, aggregate.rssBytes);
      peakProcessCount = Math.max(peakProcessCount, aggregate.processCount);
      if (collectPss) {
        peakPssBytes = Math.max(
          peakPssBytes,
          pssValues.reduce((total, value) => total + value, 0),
        );
        peakPssProcessCount = Math.max(peakPssProcessCount, pssValues.length);
      }
      for (const record of selected) {
        const previous = cpuByPid.get(record.pid) ?? {
          userTicks: 0,
          systemTicks: 0,
        };
        cpuByPid.set(record.pid, {
          userTicks: Math.max(previous.userTicks, record.userTicks),
          systemTicks: Math.max(previous.systemTicks, record.systemTicks),
        });
      }
    })();
    const trackedSample = currentSample.finally(() => {
      if (sampleInFlight === trackedSample) sampleInFlight = undefined;
    });
    sampleInFlight = trackedSample;
    return sampleInFlight;
  };

  const finalSample = async () => {
    const result = await bounded(
      async () => {
        if (sampleInFlight !== undefined) await sampleInFlight;
        await sample();
      },
      deadlineNs,
      FINAL_SAMPLE_TIMEOUT_MS,
    );
    if (result.timedOut) finalSampleTimedOut = true;
    if (result.error !== null) rememberFailure(result.error);
  };

  const initialSample = await bounded(() => sample(), deadlineNs);
  if (initialSample.timedOut)
    rememberFailure(new Error("initial process sample timed out"));
  const interval = initialSample.timedOut
    ? null
    : setInterval(() => {
        void sample();
      }, sampleIntervalMs);
  const outcome = await Promise.race([
    childClose.then((value) => ({ source: "child", value })),
    watchdog.then((value) => ({ source: "watchdog", value })),
  ]);
  let completion = outcome.value;
  let watchdogResult = null;
  if (terminationPromise !== null) {
    watchdogResult = await terminationPromise;
    completion = watchdogResult.close ?? {
      observed: false,
      exitCode: null,
      signal: null,
      error: new Error("child close was not observed"),
    };
  } else if (outcome.source === "watchdog") {
    watchdogResult = outcome.value;
    completion = watchdogResult.close ?? {
      observed: false,
      exitCode: null,
      signal: null,
      error: new Error("child close was not observed"),
    };
  }
  clearTimeout(watchdogTimer);
  clearInterval(interval);
  try {
    await finalSample();
  } finally {
    process.off("SIGINT", forwardInterrupt);
    process.off("SIGTERM", forwardTermination);
    child.off("error", onError);
    child.off("close", onClose);
  }

  const endedNs = process.hrtime.bigint();
  let userTicks = 0;
  let systemTicks = 0;
  for (const cpu of cpuByPid.values()) {
    userTicks += cpu.userTicks;
    systemTicks += cpu.systemTicks;
  }

  const sampledUserCpuMs = (userTicks / clockTicks) * 1_000;
  const sampledSystemCpuMs = (systemTicks / clockTicks) * 1_000;
  const gnuTime = await readGnuTimeMetrics(invocation.timeOutput);
  if (invocation.temporaryDirectory !== null) {
    await rm(invocation.temporaryDirectory, { recursive: true, force: true });
  }

  const terminationResult =
    watchdogResult?.terminationResult ??
    noTermination(child.pid, runtime.platform, completion);
  for (const error of terminationResult.errors) rememberFailure(error);
  if (!completion.observed) {
    rememberFailure(
      completion.error ?? new Error("child close was not observed"),
    );
  }
  if (
    runtime.platform === "linux" &&
    completion.observed &&
    (completion.exitCode !== 0 || completion.signal !== null)
  ) {
    rememberFailure(
      new Error("supervisor enforced cleanup after a non-clean child exit"),
    );
  }
  const failed =
    timedOut ||
    finalSampleTimedOut ||
    firstFailure !== null ||
    !completion.observed ||
    childError !== null;
  return {
    executable,
    args,
    exitCode: failed ? 1 : (completion.exitCode ?? 1),
    signal: completion.signal,
    startedAt: startedAt.toISOString(),
    endedAt: new Date().toISOString(),
    wallMs: Number(endedNs - startedNs) / 1_000_000,
    userCpuMs: gnuTime?.userCpuMs ?? sampledUserCpuMs,
    systemCpuMs: gnuTime?.systemCpuMs ?? sampledSystemCpuMs,
    cpuMetricSource: gnuTime === null ? "proc-sampling" : "gnu-time",
    peakRssBytes,
    peakPssBytes: collectPss ? peakPssBytes : null,
    singleProcessMaxRssBytes: gnuTime?.maxRssBytes ?? null,
    peakProcessCount,
    peakPssProcessCount: collectPss ? peakPssProcessCount : null,
    resourceMetricsAvailable: runtime.platform === "linux",
    memoryMetricDefinition: collectPss
      ? "peakRssBytes sums sampled process RSS and may double-count shared pages; peakPssBytes sums sampled process PSS"
      : "peakRssBytes sums sampled process RSS and may double-count shared pages; pass --collect-pss for sampled PSS",
    forwardedSignal,
    sampleIntervalMs,
    timeoutMs: watchdogMs,
    timedOut,
    finalSampleTimedOut,
    firstFailure,
    childClose: {
      observed: completion.observed === true,
      exitCode: completion.exitCode ?? null,
      signal: completion.signal ?? null,
      error: completion.error ? serializeError(completion.error) : null,
    },
    terminationResult,
  };
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function percentile(values, quantile) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)];
}

function distribution(values) {
  if (values.length === 0) {
    return { min: null, median: null, p90: null, max: null };
  }
  return {
    min: Math.min(...values),
    median: median(values),
    p90: percentile(values, 0.9),
    max: Math.max(...values),
  };
}

export function summarizeRuns(runs) {
  const passed = runs.filter(
    (run) =>
      run.exitCode === 0 &&
      run.timedOut !== true &&
      run.childClose?.observed === true &&
      run.terminationResult?.terminationVerified === true &&
      run.vitestReport?.status === "valid" &&
      run.vitestReport.fresh === true &&
      run.vitestReport.boundToRun === true &&
      run.vitest?.success === true &&
      run.vitest.allTestsPassed === true,
  );
  const failedRuns = runs.length - passed.length;
  return {
    totalRuns: runs.length,
    passedRuns: passed.length,
    failedRuns,
    failureRate: runs.length === 0 ? null : failedRuns / runs.length,
    isFlaky: passed.length > 0 && failedRuns > 0,
    wallMs: distribution(passed.map((run) => run.wallMs)),
    cpuMs: distribution(passed.map((run) => run.userCpuMs + run.systemCpuMs)),
    peakRssBytes: distribution(passed.map((run) => run.peakRssBytes)),
  };
}

export function estimateSplitImpact({ sharedSetupMs, browserMs, storybookMs }) {
  for (const [label, value] of Object.entries({
    sharedSetupMs,
    browserMs,
    storybookMs,
  })) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`${label} must be a non-negative number`);
    }
  }

  const combinedCriticalPathMs = sharedSetupMs + browserMs + storybookMs;
  const splitCriticalPathMs = sharedSetupMs + Math.max(browserMs, storybookMs);
  const splitRunnerMs = sharedSetupMs * 2 + browserMs + storybookMs;
  const criticalPathSavingsMs = combinedCriticalPathMs - splitCriticalPathMs;
  const runnerCostIncreaseMs = splitRunnerMs - combinedCriticalPathMs;

  return {
    combinedCriticalPathMs,
    splitCriticalPathMs,
    criticalPathSavingsMs,
    criticalPathSavingsRate:
      combinedCriticalPathMs === 0
        ? 0
        : criticalPathSavingsMs / combinedCriticalPathMs,
    combinedRunnerMs: combinedCriticalPathMs,
    splitRunnerMs,
    runnerCostIncreaseMs,
    runnerCostIncreaseRate:
      combinedCriticalPathMs === 0
        ? 0
        : runnerCostIncreaseMs / combinedCriticalPathMs,
  };
}

function nextValue(argv, index, option) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

function parseCli(argv) {
  const options = {
    runs: 1,
    sampleIntervalMs: DEFAULT_SAMPLE_INTERVAL_MS,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    switch (option) {
      case "--":
        break;
      case "--suite":
        options.suite = nextValue(argv, index, option);
        index += 1;
        break;
      case "--runs":
        options.runs = positiveInteger(nextValue(argv, index, option), "runs");
        index += 1;
        break;
      case "--output":
        options.output = nextValue(argv, index, option);
        index += 1;
        break;
      case "--candidate":
        options.candidate = nextValue(argv, index, option);
        index += 1;
        break;
      case "--max-workers":
        options.maxWorkers = positiveInteger(
          nextValue(argv, index, option),
          "maxWorkers",
        );
        index += 1;
        break;
      case "--file-parallelism": {
        const value = nextValue(argv, index, option);
        if (!new Set(["auto", "true", "false"]).has(value)) {
          throw new Error("file-parallelism must be auto, true, or false");
        }
        options.fileParallelism =
          value === "auto" ? undefined : value === "true";
        index += 1;
        break;
      }
      case "--shard":
        options.shard = nextValue(argv, index, option);
        validateShard(options.shard);
        index += 1;
        break;
      case "--sample-interval-ms":
        options.sampleIntervalMs = positiveInteger(
          nextValue(argv, index, option),
          "sampleIntervalMs",
        );
        index += 1;
        break;
      case "--collect-pss":
        options.collectPss = true;
        break;
      case "--help":
        options.help = true;
        break;
      default:
        throw new Error(`unknown option: ${option}`);
    }
  }

  return options;
}

function commandOutput(executable, args) {
  try {
    return execFileSync(executable, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function environmentMetadata() {
  return {
    platform: process.platform,
    release: os.release(),
    architecture: process.arch,
    cpuModel: os.cpus()[0]?.model ?? null,
    availableParallelism:
      typeof os.availableParallelism === "function"
        ? os.availableParallelism()
        : os.cpus().length,
    totalMemoryBytes: os.totalmem(),
    nodeVersion: process.version,
    pnpmVersion: commandOutput("pnpm", ["--version"]),
    vitestVersion: commandOutput("pnpm", ["exec", "vitest", "--version"]),
    playwrightVersion: commandOutput("pnpm", [
      "exec",
      "playwright",
      "--version",
    ]),
    gitSha:
      process.env.GITHUB_SHA ?? commandOutput("git", ["rev-parse", "HEAD"]),
    github: process.env.GITHUB_ACTIONS
      ? {
          runId: process.env.GITHUB_RUN_ID ?? null,
          runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
          job: process.env.GITHUB_JOB ?? null,
          runnerName: process.env.RUNNER_NAME ?? null,
          runnerOs: process.env.RUNNER_OS ?? null,
          runnerArch: process.env.RUNNER_ARCH ?? null,
        }
      : null,
  };
}

function candidateName(options) {
  if (options.candidate) return options.candidate;
  const parts = [options.suite, `workers-${options.maxWorkers ?? "auto"}`];
  if (options.fileParallelism !== undefined) {
    parts.push(`parallel-${options.fileParallelism}`);
  }
  if (options.shard) parts.push(`shard-${options.shard.replace("/", "-")}`);
  return parts.join("-");
}

function safeFilename(value) {
  return value.replace(/[^a-zA-Z0-9_.-]+/g, "-");
}

function extractVitestEvidence(report) {
  if (!report || typeof report !== "object") return null;
  const testResults = Array.isArray(report.testResults)
    ? report.testResults
    : null;
  const countKeys = [
    "numTotalTestSuites",
    "numPassedTestSuites",
    "numFailedTestSuites",
    "numPendingTestSuites",
    "numTotalTests",
    "numPassedTests",
    "numFailedTests",
    "numPendingTests",
    "numTodoTests",
  ];
  if (
    typeof report.success !== "boolean" ||
    testResults === null ||
    !countKeys.every(
      (key) => Number.isSafeInteger(report[key]) && report[key] >= 0,
    ) ||
    report.numPassedTestSuites +
      report.numFailedTestSuites +
      report.numPendingTestSuites !==
      report.numTotalTestSuites ||
    report.numPassedTests +
      report.numFailedTests +
      report.numPendingTests +
      report.numTodoTests !==
      report.numTotalTests
  ) {
    return null;
  }
  if (
    testResults.length === 0 ||
    testResults.some((result) => !Array.isArray(result.assertionResults))
  ) {
    return null;
  }
  const assertions = testResults.flatMap((result) => result.assertionResults);
  const assertionCounts = assertions.reduce(
    (counts, assertion) => {
      if (assertion.status in counts) counts[assertion.status] += 1;
      return counts;
    },
    { passed: 0, failed: 0, pending: 0, todo: 0 },
  );
  const assertionCount = assertions.length;
  if (
    assertionCount !== report.numTotalTests ||
    report.numPassedTests !== assertionCounts.passed ||
    report.numFailedTests !== assertionCounts.failed ||
    report.numPendingTests !== assertionCounts.pending ||
    report.numTodoTests !== assertionCounts.todo
  ) {
    return null;
  }
  const allTestsPassed =
    testResults.every(
      (result) =>
        typeof result.name === "string" &&
        result.status === "passed" &&
        Array.isArray(result.assertionResults) &&
        result.assertionResults.every(
          (assertion) => assertion.status === "passed",
        ),
    ) &&
    report.numFailedTestSuites === 0 &&
    report.numPendingTestSuites === 0 &&
    report.numFailedTests === 0 &&
    report.numPendingTests === 0 &&
    report.numTodoTests === 0;
  return {
    numTotalTestSuites: report.numTotalTestSuites,
    numPassedTestSuites: report.numPassedTestSuites,
    numFailedTestSuites: report.numFailedTestSuites,
    numPendingTestSuites: report.numPendingTestSuites,
    numTotalTests: report.numTotalTests,
    numPassedTests: report.numPassedTests,
    numFailedTests: report.numFailedTests,
    numPendingTests: report.numPendingTests,
    numTodoTests: report.numTodoTests,
    success: report.success,
    allTestsPassed,
    testFiles: testResults
      .map((result) => result.name)
      .filter((name) => typeof name === "string")
      .sort(),
    failedTests: testResults.flatMap((result) =>
      (result.assertionResults ?? [])
        .filter((assertion) => assertion.status === "failed")
        .map((assertion) => ({
          file: result.name ?? null,
          title: [...(assertion.ancestorTitles ?? []), assertion.title]
            .filter(Boolean)
            .join(" > "),
          failureMessages: assertion.failureMessages ?? [],
        })),
    ),
  };
}

export async function preflightVitestReport(reportPath) {
  try {
    await access(reportPath);
    await rm(reportPath, { force: true });
    return {
      existed: true,
      removed: true,
      status: "stale-removed",
      stale: true,
    };
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return { existed: false, removed: false, status: "absent", stale: false };
  }
}

export async function inspectVitestReport(reportPath, { run, preflight } = {}) {
  const base = {
    path: reportPath,
    run,
    reportRun: null,
    evidence: null,
    fresh: false,
    stale: false,
    boundToRun: false,
  };
  try {
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    const evidence = extractVitestEvidence(report);
    const reportRun = report?.run ?? null;
    const preflightBound =
      preflight?.status === "absent" || preflight?.status === "stale-removed";
    if (evidence === null || (reportRun !== null && reportRun !== run)) {
      return { ...base, status: "invalid", reportRun };
    }
    if (!preflightBound) {
      return { ...base, status: "stale", stale: true, reportRun };
    }
    return {
      ...base,
      status:
        evidence.success === true && evidence.allTestsPassed
          ? "valid"
          : "failed",
      reportRun,
      evidence,
      fresh: true,
      boundToRun: true,
    };
  } catch (error) {
    return {
      ...base,
      status: error?.code === "ENOENT" ? "missing" : "invalid",
    };
  }
}

async function writeBenchmark(output, report) {
  report.generatedAt = new Date().toISOString();
  report.summary = summarizeRuns(report.runs);
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

function usage() {
  return [
    "Usage:",
    "  pnpm benchmark:browser-ci -- --suite <browser|storybook|webgl> --runs <n> --output <path>",
    "",
    "Candidate options:",
    "  --max-workers <n>",
    "  --file-parallelism <auto|true|false>",
    "  --shard <index/count>",
    "  --candidate <label>",
    "  --sample-interval-ms <n>",
    "  --collect-pss",
  ].join("\n");
}

async function main() {
  const options = parseCli(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const command = buildVitestCommand(options);
  const candidate = candidateName(options);
  const output = path.resolve(
    options.output ?? `.artifacts/browser-ci/${options.suite}.json`,
  );
  const vitestReportDirectory = path.join(path.dirname(output), "vitest");
  const reportNonce = randomUUID();
  const report = {
    schemaVersion: 1,
    suite: options.suite,
    candidate,
    configuration: buildBenchmarkConfiguration(options),
    environment: environmentMetadata(),
    runs: [],
  };
  await writeBenchmark(output, report);

  for (let run = 1; run <= options.runs; run += 1) {
    const vitestReportPath = path.join(
      vitestReportDirectory,
      `${safeFilename(candidate)}-run-${run}-${reportNonce}.json`,
    );
    await mkdir(path.dirname(vitestReportPath), { recursive: true });
    console.log(
      `[browser-ci-benchmark] suite=${options.suite} candidate=${candidate} run=${run}/${options.runs}`,
    );
    const measuredArgs = [
      ...command.args,
      "--reporter=default",
      "--reporter=json",
      `--outputFile.json=${vitestReportPath}`,
    ];
    let preflight;
    try {
      preflight = await preflightVitestReport(vitestReportPath);
      const measured = await measureCommand(command.executable, measuredArgs, {
        sampleIntervalMs: options.sampleIntervalMs,
        collectPss: options.collectPss ?? false,
      });
      const vitestReport = await inspectVitestReport(vitestReportPath, {
        run,
        preflight,
      });
      report.runs.push({
        run,
        ...measured,
        vitest: vitestReport.evidence,
        vitestReport: { ...vitestReport, preflight },
      });
    } catch (error) {
      const vitestReport = await inspectVitestReport(vitestReportPath, {
        run,
        preflight,
      });
      report.runs.push({
        run,
        executable: command.executable,
        args: measuredArgs,
        exitCode: 1,
        signal: null,
        error: {
          name: error instanceof Error ? error.name : "Error",
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : null,
        },
        vitest: vitestReport.evidence,
        vitestReport: { ...vitestReport, preflight },
      });
      await writeBenchmark(output, report);
      break;
    }
    await writeBenchmark(output, report);
  }

  const summary = summarizeRuns(report.runs);
  console.log(
    `[browser-ci-benchmark] ${JSON.stringify({
      output,
      suite: options.suite,
      candidate,
      ...summary,
    })}`,
  );
  if (summary.failedRuns > 0) process.exitCode = 1;
}

const isEntrypoint =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isEntrypoint) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  });
}
