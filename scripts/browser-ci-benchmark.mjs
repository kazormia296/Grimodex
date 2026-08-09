#!/usr/bin/env node

import { execFileSync, spawn } from "node:child_process";
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
const DEFAULT_SAMPLE_INTERVAL_MS = 100;

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
  return {
    fileParallelism: options.fileParallelism ?? "auto",
    maxWorkers: options.maxWorkers ?? "auto",
    shard: options.shard ?? null,
    retry: 0,
    collectPss: options.collectPss ?? false,
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
    ppid: Number(fields[1]),
    pgrp: Number(fields[2]),
    userTicks,
    systemTicks,
    cpuTicks: userTicks + systemTicks,
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

export async function measureCommand(
  executable,
  args,
  {
    cwd = process.cwd(),
    env = process.env,
    sampleIntervalMs = DEFAULT_SAMPLE_INTERVAL_MS,
    stdio = "inherit",
    collectPss = false,
  } = {},
) {
  positiveInteger(sampleIntervalMs, "sampleIntervalMs");
  if (typeof collectPss !== "boolean") {
    throw new Error("collectPss must be a boolean");
  }
  const startedAt = new Date();
  const startedNs = process.hrtime.bigint();
  const pageSize = sysconf("PAGESIZE", 4096);
  const clockTicks = sysconf("CLK_TCK", 100);
  const invocation = await commandInvocation(executable, args);
  const child = spawn(invocation.executable, invocation.args, {
    cwd,
    env,
    stdio,
    detached: process.platform === "linux",
  });
  // Subscribe before the initial /proc sample. A very short command can close
  // while that asynchronous scan is still running; attaching afterward misses
  // the event and leaves the benchmark Promise pending forever.
  const childCompletion = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
  });

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
      const records = await readProcRecords();
      const selected = selectProcessTree(records, child.pid);
      const aggregate = aggregateProcessTree(records, child.pid, pageSize);
      peakRssBytes = Math.max(peakRssBytes, aggregate.rssBytes);
      peakProcessCount = Math.max(peakProcessCount, aggregate.processCount);
      if (collectPss) {
        const pssValues = (
          await Promise.all(selected.map((record) => readPssBytes(record.pid)))
        ).filter((value) => value !== null);
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
    if (sampleInFlight !== undefined) await sampleInFlight;
    await sample();
  };

  await sample();
  const interval = setInterval(() => {
    void sample();
  }, sampleIntervalMs);
  let forwardedSignal = null;
  const forwardSignal = (signal) => {
    forwardedSignal = signal;
    try {
      if (process.platform === "linux" && child.pid !== undefined) {
        process.kill(-child.pid, signal);
      } else {
        child.kill(signal);
      }
    } catch {
      // The measured process may have exited between signal delivery and here.
    }
  };
  const forwardInterrupt = () => forwardSignal("SIGINT");
  const forwardTermination = () => forwardSignal("SIGTERM");
  process.once("SIGINT", forwardInterrupt);
  process.once("SIGTERM", forwardTermination);

  let completion;
  try {
    completion = await childCompletion;
  } catch (error) {
    if (invocation.temporaryDirectory !== null) {
      await rm(invocation.temporaryDirectory, { recursive: true, force: true });
    }
    throw error;
  } finally {
    clearInterval(interval);
    await finalSample();
    process.off("SIGINT", forwardInterrupt);
    process.off("SIGTERM", forwardTermination);
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

  return {
    executable,
    args,
    exitCode: completion.exitCode ?? 1,
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
    resourceMetricsAvailable: process.platform === "linux",
    memoryMetricDefinition: collectPss
      ? "peakRssBytes sums sampled process RSS and may double-count shared pages; peakPssBytes sums sampled process PSS"
      : "peakRssBytes sums sampled process RSS and may double-count shared pages; pass --collect-pss for sampled PSS",
    forwardedSignal,
    sampleIntervalMs,
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
  const passed = runs.filter((run) => run.exitCode === 0);
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
    : [];
  return {
    numTotalTestSuites: report.numTotalTestSuites ?? null,
    numPassedTestSuites: report.numPassedTestSuites ?? null,
    numFailedTestSuites: report.numFailedTestSuites ?? null,
    numTotalTests: report.numTotalTests ?? null,
    numPassedTests: report.numPassedTests ?? null,
    numFailedTests: report.numFailedTests ?? null,
    success: report.success ?? null,
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

async function readVitestEvidence(reportPath) {
  try {
    return extractVitestEvidence(
      JSON.parse(await readFile(reportPath, "utf8")),
    );
  } catch {
    return null;
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
      `${safeFilename(candidate)}-run-${run}.json`,
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
    try {
      const measured = await measureCommand(command.executable, measuredArgs, {
        sampleIntervalMs: options.sampleIntervalMs,
        collectPss: options.collectPss ?? false,
      });
      report.runs.push({
        run,
        ...measured,
        vitest: await readVitestEvidence(vitestReportPath),
      });
    } catch (error) {
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
        vitest: await readVitestEvidence(vitestReportPath),
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
