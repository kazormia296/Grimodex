/**
 * Evidence-only diagnostics for the measured runtime-performance launch.
 *
 * Nothing here participates in budgets, retry classification, or pass/fail.
 * Every reader degrades to an explicit `unavailable` record so a missing
 * /proc source, an older renderer, or a non-Linux host never fails the gate.
 * Output is an allowlist: span names, static participant ids, numbers, and
 * enum-like statuses only (no paths, titles, entity ids, or exception text).
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import {
  parseLinuxProcIo,
  parseLinuxProcStat,
  parsePressure,
} from "./runtime-performance-diagnostic.mjs";

export const RUNTIME_OPEN_EVIDENCE_SCHEMA_VERSION = 1;
export const RUNTIME_OPEN_EVIDENCE_MAX_SPANS = 96;
export const RUNTIME_OPEN_EVIDENCE_LINE_SPAN_COUNT = 6;
export const RUNTIME_OPEN_EVIDENCE_MAX_PROCESS_TYPES = 12;
export const RUNTIME_OPEN_EVIDENCE_PRESSURE_KINDS = ["cpu", "io", "memory"];

const TRACE_TOKEN = /^[a-z][a-z0-9-]{0,47}$/u;
const TRACE_SOURCES = new Set([
  "startup-auto",
  "launcher-card",
  "workspace-menu-recent",
  "folder-picker",
  "direct",
  "trust-confirmed",
]);
const TRACE_RESULTS = new Set(["ready", "failed"]);
const SPAN_STATUSES = new Set(["finished", "failed"]);
const PROCESS_TYPE = /^[A-Za-z][A-Za-z0-9 _-]{0,31}$/u;

function finiteOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function round(value, digits = 1) {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function token(value) {
  return typeof value === "string" && TRACE_TOKEN.test(value) ? value : null;
}

function validTraceRecord(record) {
  const summary = record?.summary;
  return (
    Number.isFinite(record?.startedAtMs) &&
    summary &&
    typeof summary === "object" &&
    TRACE_RESULTS.has(summary.result) &&
    Array.isArray(summary.spans)
  );
}

/**
 * Select the measured workspace-open trace and project it onto the
 * `grimodex.workspaceOpen.start` timeline. Span offsets are relative to that
 * mark (negative = before the native open began, e.g. path validation).
 */
export function summarizeWorkspaceOpenTraceRecords(
  records,
  { workspaceOpenStartMs = null } = {},
) {
  if (!Array.isArray(records)) {
    return { status: "unavailable", reason: "trace-not-exposed" };
  }
  const valid = records.filter(validTraceRecord);
  if (valid.length === 0) {
    return {
      status: "unavailable",
      reason: records.length === 0 ? "no-terminal-trace" : "invalid-trace",
    };
  }
  const anchor = finiteOrNull(workspaceOpenStartMs);
  const selected =
    (anchor === null
      ? null
      : valid.findLast((record) => record.startedAtMs <= anchor + 0.001)) ??
    valid.at(-1);
  const { summary } = selected;
  const origin = anchor ?? selected.startedAtMs;
  const spans = [];
  let droppedSpanCount = 0;
  for (const span of summary.spans) {
    const name = token(span?.name);
    const startOffsetMs = finiteOrNull(span?.startOffsetMs);
    const durationMs = finiteOrNull(span?.durationMs);
    if (
      !name ||
      !SPAN_STATUSES.has(span?.status) ||
      startOffsetMs === null ||
      durationMs === null
    ) {
      droppedSpanCount += 1;
      continue;
    }
    if (spans.length >= RUNTIME_OPEN_EVIDENCE_MAX_SPANS) {
      droppedSpanCount += 1;
      continue;
    }
    const participantId = token(span.participantId);
    spans.push({
      name,
      ...(participantId ? { participantId } : {}),
      status: span.status,
      startMs: round(selected.startedAtMs + startOffsetMs - origin),
      durationMs: round(durationMs),
    });
  }
  return {
    status: "captured",
    source: TRACE_SOURCES.has(summary.source) ? summary.source : null,
    result: summary.result,
    traceCount: valid.length,
    origin: anchor === null ? "trace-start" : "workspace-open-start",
    traceStartMs: round(selected.startedAtMs - origin),
    totalDurationMs: round(finiteOrNull(summary.totalDurationMs)),
    requestToInputReadyMs: round(finiteOrNull(summary.requestToInputReadyMs)),
    spanCount: spans.length,
    droppedSpanCount,
    spans,
  };
}

function parseLoadAverage(contents) {
  const values = contents.trim().split(/\s+/u).slice(0, 3).map(Number);
  return values.length === 3 && values.every(Number.isFinite) ? values : null;
}

/** Host PSI (cpu/io/memory) and load average; Linux only, never throws. */
export function readHostPressureSnapshot({
  procRoot = "/proc",
  readFile = readFileSync,
  platform = process.platform,
  atMs = null,
} = {}) {
  const snapshot = {
    atMs: round(finiteOrNull(atMs)),
    pressure: { cpu: null, io: null, memory: null },
    loadavg: null,
    unavailable: [],
  };
  if (platform !== "linux") {
    snapshot.unavailable.push("platform");
    return snapshot;
  }
  for (const kind of RUNTIME_OPEN_EVIDENCE_PRESSURE_KINDS) {
    try {
      snapshot.pressure[kind] = parsePressure(
        String(readFile(path.join(procRoot, "pressure", kind), "utf8")),
      );
    } catch {
      snapshot.pressure[kind] = null;
    }
    if (!snapshot.pressure[kind]) snapshot.unavailable.push(`pressure.${kind}`);
  }
  try {
    snapshot.loadavg = parseLoadAverage(
      String(readFile(path.join(procRoot, "loadavg"), "utf8")),
    );
  } catch {
    snapshot.loadavg = null;
  }
  if (!snapshot.loadavg) snapshot.unavailable.push("loadavg");
  return snapshot;
}

/** CPU ticks and I/O counters of one owned process; never throws. */
export function readProcessResourceSnapshot(
  pid,
  {
    procRoot = "/proc",
    readFile = readFileSync,
    platform = process.platform,
    atMs = null,
  } = {},
) {
  const snapshot = {
    atMs: round(finiteOrNull(atMs)),
    cpu: null,
    io: null,
    unavailable: [],
  };
  if (platform !== "linux") {
    snapshot.unavailable.push("platform");
    return snapshot;
  }
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    snapshot.unavailable.push("pid");
    return snapshot;
  }
  try {
    const stat = parseLinuxProcStat(
      String(readFile(path.join(procRoot, String(pid), "stat"), "utf8")),
    );
    snapshot.cpu =
      stat && stat.pid === pid
        ? { userTicks: stat.userTicks, systemTicks: stat.systemTicks }
        : null;
  } catch {
    snapshot.cpu = null;
  }
  if (!snapshot.cpu) snapshot.unavailable.push("stat");
  try {
    snapshot.io = parseLinuxProcIo(
      String(readFile(path.join(procRoot, String(pid), "io"), "utf8")),
    );
  } catch {
    snapshot.io = null;
  }
  if (!snapshot.io) snapshot.unavailable.push("io");
  return snapshot;
}

export function readClockTicksPerSecond({
  platform = process.platform,
  spawnSyncImpl = spawnSync,
} = {}) {
  if (platform !== "linux") return { value: null, source: "unavailable" };
  try {
    const result = spawnSyncImpl("getconf", ["CLK_TCK"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2_000,
      killSignal: "SIGKILL",
      maxBuffer: 64,
    });
    const value = Number(String(result?.stdout ?? "").trim());
    if (result?.status === 0 && Number.isSafeInteger(value) && value > 0) {
      return { value, source: "getconf" };
    }
  } catch {
    // Fall through to the Linux USER_HZ default.
  }
  return { value: 100, source: "assumed-user-hz" };
}

export function diffProcessResourceSnapshots(start, end, clockTicksPerSecond) {
  if (!start || !end) return null;
  const elapsedMs =
    Number.isFinite(start.atMs) && Number.isFinite(end.atMs)
      ? round(end.atMs - start.atMs)
      : null;
  const ticksToMs = (ticks) =>
    Number.isFinite(clockTicksPerSecond) && clockTicksPerSecond > 0
      ? round((ticks * 1000) / clockTicksPerSecond)
      : null;
  const cpu =
    start.cpu && end.cpu
      ? {
          userMs: ticksToMs(end.cpu.userTicks - start.cpu.userTicks),
          systemMs: ticksToMs(end.cpu.systemTicks - start.cpu.systemTicks),
        }
      : null;
  const io =
    start.io && end.io
      ? {
          readBytes: end.io.readBytes - start.io.readBytes,
          writeBytes: end.io.writeBytes - start.io.writeBytes,
          rchar: end.io.rchar - start.io.rchar,
          wchar: end.io.wchar - start.io.wchar,
        }
      : null;
  return { elapsedMs, cpu, io };
}

/** Bounded per-type aggregate of Electron `getAppMetrics()` cumulative CPU. */
export function aggregateAppProcessCpu(metrics) {
  if (!Array.isArray(metrics)) {
    return { status: "unavailable", reason: "metrics-unavailable" };
  }
  const byType = new Map();
  for (const metric of metrics) {
    const type = PROCESS_TYPE.test(metric?.type ?? "") ? metric.type : "other";
    const entry = byType.get(type) ?? {
      type,
      processCount: 0,
      cumulativeCpuSeconds: 0,
      cumulativeCpuMissing: 0,
    };
    entry.processCount += 1;
    const cumulative = finiteOrNull(metric?.cumulativeCpuSeconds);
    if (cumulative === null) entry.cumulativeCpuMissing += 1;
    else entry.cumulativeCpuSeconds += cumulative;
    byType.set(type, entry);
  }
  const processes = [...byType.values()]
    .sort(
      (left, right) => right.cumulativeCpuSeconds - left.cumulativeCpuSeconds,
    )
    .slice(0, RUNTIME_OPEN_EVIDENCE_MAX_PROCESS_TYPES)
    .map((entry) => ({
      ...entry,
      cumulativeCpuSeconds: round(entry.cumulativeCpuSeconds, 3),
    }));
  return { status: "captured", processes };
}

export function buildRuntimeOpenEvidence({
  rendererMarks = null,
  workspaceOpen = null,
  hostBeforeLaunch = null,
  hostAfterMeasurement = null,
  clockTicks = null,
  mainBridgeReady = null,
  mainAfterMeasurement = null,
  appProcessCpu = null,
} = {}) {
  const marks = {};
  for (const key of [
    "rendererBootstrapMs",
    "rendererFirstFrameMs",
    "workspaceOpenStartMs",
    "editorInputReadyMs",
  ]) {
    marks[key] = round(finiteOrNull(rendererMarks?.[key]));
  }
  return {
    schemaVersion: RUNTIME_OPEN_EVIDENCE_SCHEMA_VERSION,
    rendererMarks: marks,
    workspaceOpen: workspaceOpen ?? {
      status: "unavailable",
      reason: "not-collected",
    },
    host: {
      beforeLaunch: hostBeforeLaunch,
      afterMeasurement: hostAfterMeasurement,
    },
    mainProcess: {
      clockTicksPerSecond: clockTicks?.value ?? null,
      clockTicksSource: clockTicks?.source ?? "unavailable",
      bridgeReady: mainBridgeReady,
      afterMeasurement: mainAfterMeasurement,
      delta: diffProcessResourceSnapshots(
        mainBridgeReady,
        mainAfterMeasurement,
        clockTicks?.value ?? null,
      ),
      totalSinceStart: mainAfterMeasurement?.cpu
        ? diffProcessResourceSnapshots(
            {
              atMs: null,
              cpu: { userTicks: 0, systemTicks: 0 },
              io: mainAfterMeasurement.io
                ? { readBytes: 0, writeBytes: 0, rchar: 0, wchar: 0 }
                : null,
            },
            mainAfterMeasurement,
            clockTicks?.value ?? null,
          )
        : null,
    },
    appProcessCpu: appProcessCpu ?? {
      status: "unavailable",
      reason: "not-collected",
    },
  };
}

function formatPressure(snapshot) {
  if (!snapshot) return "n/a";
  return RUNTIME_OPEN_EVIDENCE_PRESSURE_KINDS.map((kind) => {
    const value = snapshot.pressure?.[kind];
    if (!value?.some) return `${kind}=n/a`;
    const full = value.full ? `/${value.full.avg10}` : "";
    return `${kind}=${value.some.avg10}${full}`;
  }).join(",");
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "n/a";
  return `${round(bytes / (1024 * 1024))}MiB`;
}

/** One informational `[runtime-perf]` line; never a PASS/FAIL verdict. */
export function formatRuntimeOpenEvidenceLine(evidence) {
  if (!evidence) return "[runtime-perf] INFO open-evidence unavailable";
  const parts = [];
  const marks = evidence.rendererMarks ?? {};
  parts.push(
    `marks boot=${marks.rendererBootstrapMs ?? "n/a"} frame=${marks.rendererFirstFrameMs ?? "n/a"} open=${marks.workspaceOpenStartMs ?? "n/a"} ready=${marks.editorInputReadyMs ?? "n/a"}`,
  );
  const open = evidence.workspaceOpen;
  if (open?.status === "captured") {
    const top = [...open.spans]
      .sort((left, right) => right.durationMs - left.durationMs)
      .slice(0, RUNTIME_OPEN_EVIDENCE_LINE_SPAN_COUNT)
      .map(
        (span) =>
          `${span.name}${span.participantId ? `:${span.participantId}` : ""}@${span.startMs}+${span.durationMs}${span.status === "failed" ? "!" : ""}`,
      );
    parts.push(
      `trace=${open.result} total=${open.totalDurationMs} spans[${open.spanCount}] ${top.join(" ") || "none"}`,
    );
  } else {
    parts.push(`trace=unavailable(${open?.reason ?? "unknown"})`);
  }
  parts.push(
    `psi10(some/full) before ${formatPressure(evidence.host?.beforeLaunch)} after ${formatPressure(evidence.host?.afterMeasurement)}`,
  );
  const load = evidence.host?.afterMeasurement?.loadavg;
  parts.push(`load=${load ? load.join("/") : "n/a"}`);
  const total = evidence.mainProcess?.totalSinceStart;
  parts.push(
    total?.cpu
      ? `main cpu=${total.cpu.userMs}u+${total.cpu.systemMs}s ms io=r${formatBytes(total.io?.readBytes)} w${formatBytes(total.io?.writeBytes)}`
      : "main=n/a",
  );
  const appCpu = evidence.appProcessCpu;
  if (appCpu?.status === "captured") {
    parts.push(
      `appcpu ${appCpu.processes
        .map((entry) => `${entry.type}=${entry.cumulativeCpuSeconds}s`)
        .join(",")}`,
    );
  }
  return `[runtime-perf] INFO open-evidence ${parts.join(" | ")}`;
}
