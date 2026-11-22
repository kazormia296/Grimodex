#!/usr/bin/env node
// dev 専用（claude/dev-perf-gpu-experiment 枝だけ）。.github/workflows/dev-perf-gpu-experiment.yml の
// 結果を集計する。gh は呼ばない。`gh run download <run id> -D <dir>` で落とした dir を読むだけ。
//
//   node scripts/dev-perf-gpu-experiment-aggregate.mjs <downloaded-dir> [--cold-limit 4000] [--open-limit 3000]
//   node scripts/dev-perf-gpu-experiment-aggregate.mjs --summary-line <artifact-dir> [--outcome <step outcome>]   (workflow の要約 step 用)
//
// <downloaded-dir> の下を再帰で探し、dev-perf-experiment.json がある dir を 1 job の artifact として読む。
// 同じ dir の runtime-metrics*.json と runtime-metrics-io-settle.json を使う。
//
// 「最初の試行」の値を使う：transient retry が起きた job は runtime-metrics-attempt-1.json が最初の試行、
// それ以外は runtime-metrics.json が最初の試行。retry 後の値（2 回目）は集計に入れない。
//
// smoke.mjs は最後の phase まで通ったときだけ metrics file を書く。途中で落ちた job（描画 flag で別の
// 段が壊れた場合など）の coldStart も残すため、workflow は測定の出力を measure.log に tee する。
// metrics が無いときは、その log の `[runtime-perf] INFO open-evidence marks boot= frame= open= ready=`
// の行（最初の 1 行）から boot・frame・open・ready（＝coldStartMs と同じ印）を拾い、log 由来として数える
// （projectOpenMs は log から取れないので空）。

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// scripts/runtime-performance-budget.mjs の BASE_RUNTIME_BUDGETS と同じ値（gate は変えない）。
const DEFAULT_COLD_LIMIT_MS = 4_000;
const DEFAULT_OPEN_LIMIT_MS = 3_000;
const FIRST_FRAME_DELAY_THRESHOLD_MS = 1_000;
const IDENTITY_FILE = "dev-perf-experiment.json";
const VARIANT_ORDER = [
  "baseline",
  "angle-swiftshader",
  "swiftshader-full",
  "in-process-gpu",
];

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function finite(value) {
  return Number.isFinite(value) ? value : null;
}

function round(value) {
  return value === null ? null : Math.round(value * 10) / 10;
}

const MARKS_LINE =
  /\[runtime-perf\] INFO open-evidence marks boot=(\S+) frame=(\S+) open=(\S+) ready=(\S+)/u;

function readMarksFromLog(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const match = MARKS_LINE.exec(text);
  if (!match) return null;
  const [boot, frame, open, ready] = match.slice(1, 5).map((value) => finite(Number(value)));
  return { boot, frame, open, ready };
}

/** 1 job の artifact dir から、集計に要る値だけを取る。 */
export function loadJobRecord(directory) {
  const identity = readJson(path.join(directory, IDENTITY_FILE));
  if (!identity) return null;
  const attempt1Path = path.join(directory, "runtime-metrics-attempt-1.json");
  const canonicalPath = path.join(directory, "runtime-metrics.json");
  const retried = existsSync(attempt1Path);
  const metrics = readJson(retried ? attempt1Path : canonicalPath);
  const logMarks = metrics ? null : readMarksFromLog(path.join(directory, "measure.log"));
  const ioSettle = readJson(path.join(directory, "runtime-metrics-io-settle.json"));
  const ioAttempt = Array.isArray(ioSettle?.attempts) ? ioSettle.attempts[0] : null;
  const marks = metrics?.openEvidence?.rendererMarks ?? {};
  const bootstrapMs = finite(metrics?.coldStartBootstrapMs ?? logMarks?.boot);
  const firstFrameMs = finite(metrics?.coldStartFirstFrameMs ?? logMarks?.frame);
  const ioBefore = metrics?.openEvidence?.host?.beforeLaunch?.pressure?.io?.full?.avg10;
  return {
    variant: identity.variant ?? "unknown",
    rep: identity.rep ?? null,
    sysVendor: (identity.sysVendor ?? "").trim(),
    productName: (identity.productName ?? "").trim(),
    nproc: identity.nproc ?? null,
    retried,
    hasMetrics: metrics !== null,
    fromLog: logMarks !== null,
    coldStartMs: finite(metrics?.coldStartMs ?? logMarks?.ready),
    projectOpenMs: finite(metrics?.projectOpenMs),
    bootstrapMs,
    firstFrameMs,
    firstFrameDelayMs:
      bootstrapMs !== null && firstFrameMs !== null ? firstFrameMs - bootstrapMs : null,
    workspaceOpenStartMs: finite(marks.workspaceOpenStartMs ?? logMarks?.open),
    gpuChannelFailureCount: Array.isArray(metrics?.coldStartGpuChannelFailureOffsetsMs)
      ? metrics.coldStartGpuChannelFailureOffsetsMs.length
      : null,
    ioFullAvg10Start: finite(ioAttempt?.ioFullAvg10?.start),
    ioFullAvg10End: finite(ioAttempt?.ioFullAvg10?.end),
    ioSettleStatus: ioAttempt?.status ?? null,
    ioSettleWaitedMs: finite(ioAttempt?.waitedMs),
    psiIoFullAvg10BeforeLaunch: finite(ioBefore),
  };
}

function findIdentityDirectories(root) {
  const found = [];
  const walk = (directory) => {
    let entries;
    try {
      entries = readdirSync(directory);
    } catch {
      return;
    }
    if (entries.includes(IDENTITY_FILE)) found.push(directory);
    for (const entry of entries) {
      const child = path.join(directory, entry);
      let isDirectory = false;
      try {
        isDirectory = statSync(child).isDirectory();
      } catch {
        // 読めない entry は飛ばす。
      }
      if (isDirectory) walk(child);
    }
  };
  walk(root);
  return found.sort();
}

export function vendorGroup(record) {
  return /amazon/i.test(record.sysVendor) ? "AWS(Amazon EC2)" : "other";
}

function stats(values) {
  const sorted = values.filter((value) => value !== null).sort((a, b) => a - b);
  if (sorted.length === 0) return { n: 0, min: null, median: null, max: null };
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  return { n: sorted.length, min: sorted[0], median, max: sorted[sorted.length - 1] };
}

function formatStats(s) {
  return s.n === 0 ? "n/a" : `${round(s.min)}/${round(s.median)}/${round(s.max)}`;
}

function countOver(values, limit) {
  return values.filter((value) => value !== null && value > limit).length;
}

export function buildTable(records, { coldLimit, openLimit }) {
  const groups = new Map();
  for (const record of records) {
    const key = `${record.variant}\u0000${vendorGroup(record)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  }
  const variantRank = (variant) => {
    const index = VARIANT_ORDER.indexOf(variant);
    return index === -1 ? VARIANT_ORDER.length : index;
  };
  const rows = [...groups.entries()]
    .map(([key, group]) => {
      const [variant, vendor] = key.split("\u0000");
      const cold = group.map((record) => record.coldStartMs);
      const open = group.map((record) => record.projectOpenMs);
      const delay = group.map((record) => record.firstFrameDelayMs);
      return {
        variant,
        vendor,
        jobs: group.length,
        logOnly: group.filter((record) => !record.hasMetrics && record.fromLog).length,
        noData: group.filter((record) => !record.hasMetrics && !record.fromLog).length,
        retried: group.filter((record) => record.retried).length,
        cold: stats(cold),
        coldOver: countOver(cold, coldLimit),
        open: stats(open),
        openOver: countOver(open, openLimit),
        delayOver: countOver(delay, FIRST_FRAME_DELAY_THRESHOLD_MS),
        delayN: delay.filter((value) => value !== null).length,
      };
    })
    .sort(
      (a, b) =>
        variantRank(a.variant) - variantRank(b.variant) ||
        a.variant.localeCompare(b.variant) ||
        a.vendor.localeCompare(b.vendor),
    );
  const header = [
    "variant",
    "runner",
    "jobs",
    "log-only",
    "no-data",
    "retried",
    "coldStartMs min/med/max",
    `cold>${coldLimit}`,
    "projectOpenMs min/med/max",
    `open>${openLimit}`,
    `frame-boot>${FIRST_FRAME_DELAY_THRESHOLD_MS}ms`,
  ];
  const body = rows.map((row) => [
    row.variant,
    row.vendor,
    String(row.jobs),
    String(row.logOnly),
    String(row.noData),
    String(row.retried),
    formatStats(row.cold),
    `${row.coldOver}/${row.cold.n}`,
    formatStats(row.open),
    `${row.openOver}/${row.open.n}`,
    `${row.delayOver}/${row.delayN}`,
  ]);
  const widths = header.map((cell, index) =>
    Math.max(cell.length, ...body.map((row) => row[index].length)),
  );
  const line = (cells) => cells.map((cell, index) => cell.padEnd(widths[index])).join("  ");
  return [line(header), line(widths.map((width) => "-".repeat(width))), ...body.map(line)].join("\n");
}

/** workflow の $GITHUB_STEP_SUMMARY 用の 1 行。 */
export function formatSummaryLine(record, outcome = null) {
  if (!record) return "- dev-perf-experiment.json not found (no result)";
  const value = (v) => (v === null || v === undefined ? "n/a" : String(round(v)));
  const io =
    record.ioFullAvg10Start === null && record.ioFullAvg10End === null
      ? "n/a"
      : `${value(record.ioFullAvg10Start)}->${value(record.ioFullAvg10End)} ${record.ioSettleStatus ?? "?"} waited ${value(record.ioSettleWaitedMs)}ms`;
  return (
    `- ${record.variant} rep${record.rep}: vendor=${record.sysVendor || "?"} nproc=${record.nproc ?? "?"} ` +
    `cold=${value(record.coldStartMs)} open=${value(record.projectOpenMs)} ` +
    `boot=${value(record.bootstrapMs)} frame=${value(record.firstFrameMs)} ` +
    `openStart=${value(record.workspaceOpenStartMs)} io(full avg10)=${io} ` +
    `gpuFailLines=${record.gpuChannelFailureCount ?? "n/a"} retried=${record.retried}` +
    (outcome ? ` step=${outcome}` : "") +
    (record.hasMetrics ? "" : record.fromLog ? " (metrics file missing; values from log)" : " (NO DATA)")
  );
}

function parseArguments(argv) {
  const options = {
    directory: null,
    summaryLine: null,
    outcome: null,
    coldLimit: DEFAULT_COLD_LIMIT_MS,
    openLimit: DEFAULT_OPEN_LIMIT_MS,
  };
  for (let index = 2; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--summary-line" || argument === "--outcome" || argument === "--cold-limit" || argument === "--open-limit") {
      const value = argv[index + 1];
      if (!value) throw new Error(`${argument} requires a value`);
      index += 1;
      if (argument === "--summary-line") options.summaryLine = value;
      else if (argument === "--outcome") options.outcome = value;
      else {
        const parsed = Number(value);
        if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${argument} must be a positive number`);
        if (argument === "--cold-limit") options.coldLimit = parsed;
        else options.openLimit = parsed;
      }
      continue;
    }
    if (argument.startsWith("--")) throw new Error(`unknown argument: ${argument}`);
    if (options.directory) throw new Error("only one directory may be given");
    options.directory = argument;
  }
  return options;
}

function main(argv) {
  let options;
  try {
    options = parseArguments(argv);
  } catch (error) {
    console.error(`[dev-perf-gpu] ${error.message}`);
    return 2;
  }
  if (options.summaryLine) {
    console.log(formatSummaryLine(loadJobRecord(options.summaryLine), options.outcome));
    return 0;
  }
  if (!options.directory) {
    console.error(
      "usage: node scripts/dev-perf-gpu-experiment-aggregate.mjs <dir from gh run download> [--cold-limit N] [--open-limit N]",
    );
    return 2;
  }
  const directories = findIdentityDirectories(path.resolve(options.directory));
  const records = directories.map(loadJobRecord).filter(Boolean);
  if (records.length === 0) {
    console.error(`[dev-perf-gpu] no ${IDENTITY_FILE} under ${options.directory}`);
    return 1;
  }
  console.log(`jobs: ${records.length} (first attempt values; retry の 2 回目は含めない)`);
  console.log(buildTable(records, options));
  const vendors = new Map();
  for (const record of records) {
    const key = `${record.sysVendor || "(empty)"} / ${record.productName || "(empty)"}`;
    vendors.set(key, (vendors.get(key) ?? 0) + 1);
  }
  console.log("\nsys_vendor / product_name:");
  for (const [key, count] of vendors) console.log(`  ${count} x ${key}`);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv));
}
