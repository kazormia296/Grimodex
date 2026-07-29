import { readFile } from "node:fs/promises";
import process from "node:process";

const KIBIBYTE = 1_024;

export const APP_MEMORY_MEASUREMENT_BY_PLATFORM = Object.freeze({
  linux: "sumProcessPssWithRssFallbackBytes",
  win32: "sumProcessPrivateWithRssFallbackBytes",
  darwin: "sumProcessWorkingSetBytes",
});

export function appMemoryMeasurement(platform = process.platform) {
  const measurement = APP_MEMORY_MEASUREMENT_BY_PLATFORM[platform];
  if (!measurement) {
    throw new Error(`unsupported app memory measurement platform: ${platform}`);
  }
  return measurement;
}

function nonNegativeKibibytes(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new Error(`${label} must be a non-negative KiB value`);
  }
  return number * KIBIBYTE;
}

export function parseLinuxSmapsRollup(source) {
  const values = new Map();
  for (const line of String(source).split(/\r?\n/u)) {
    const match = /^([A-Za-z_]+):\s+(\d+)\s+kB$/u.exec(line);
    if (match) values.set(match[1], Number(match[2]));
  }
  if (!values.has("Pss")) {
    throw new Error("Linux smaps_rollup is missing Pss");
  }
  return {
    proportionalSetBytes: nonNegativeKibibytes(
      values.get("Pss"),
      "Linux smaps_rollup Pss",
    ),
    residentSetBytes: values.has("Rss")
      ? nonNegativeKibibytes(values.get("Rss"), "Linux smaps_rollup Rss")
      : null,
  };
}

function deduplicateProcessMetrics(processMetrics) {
  const byPid = new Map();
  for (const metric of processMetrics ?? []) {
    const pid = Number(metric?.pid);
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      throw new Error("Electron app metric pid must be a positive integer");
    }
    const current = byPid.get(pid);
    const creationTime = Number(metric?.creationTime ?? 0);
    const currentCreationTime = Number(current?.creationTime ?? 0);
    if (!current || creationTime >= currentCreationTime) {
      byPid.set(pid, metric);
    }
  }
  return [...byPid.values()];
}

function processIdentity(metric) {
  return {
    pid: Number(metric.pid),
    type: String(metric.type ?? "unknown"),
    creationTime: Number(metric.creationTime ?? 0),
  };
}

function fallbackReason(error) {
  if (error && typeof error === "object" && "code" in error) {
    return String(error.code);
  }
  return error instanceof Error ? error.message : String(error);
}

async function defaultReadLinuxSmapsRollup(pid) {
  return readFile(`/proc/${pid}/smaps_rollup`, "utf8");
}

/**
 * Aggregate one Electron app instance without counting the same Chromium
 * shared pages once per process on Linux.
 *
 * `getAppMetrics()` exposes only RSS (`workingSetSize`) on Linux. PSS from
 * `smaps_rollup` proportionally attributes shared mappings; a process that
 * exits between the Electron snapshot and `/proc` read falls back to its
 * captured RSS and is explicitly marked in the evidence.
 */
export async function aggregateAppProcessMemory(
  processMetrics,
  {
    platform = process.platform,
    readLinuxSmapsRollup = defaultReadLinuxSmapsRollup,
  } = {},
) {
  const uniqueMetrics = deduplicateProcessMetrics(processMetrics);
  if (uniqueMetrics.length === 0) {
    throw new Error(
      "app memory snapshot must contain at least one Electron app process",
    );
  }
  const measurement = appMemoryMeasurement(platform);
  const processes = await Promise.all(
    uniqueMetrics.map(async (metric) => {
      const identity = processIdentity(metric);
      const workingSetBytes = nonNegativeKibibytes(
        metric.memory?.workingSetSize,
        `Electron process ${identity.pid} workingSetSize`,
      );

      if (platform === "linux") {
        try {
          const rollup = parseLinuxSmapsRollup(
            await readLinuxSmapsRollup(identity.pid),
          );
          return {
            ...identity,
            measuredBytes: rollup.proportionalSetBytes,
            workingSetBytes,
            source: "pss",
            fallbackReason: null,
          };
        } catch (error) {
          return {
            ...identity,
            measuredBytes: workingSetBytes,
            workingSetBytes,
            source: "rss-fallback",
            fallbackReason: fallbackReason(error),
          };
        }
      }

      if (platform === "win32" && metric.memory?.privateBytes != null) {
        return {
          ...identity,
          measuredBytes: nonNegativeKibibytes(
            metric.memory.privateBytes,
            `Electron process ${identity.pid} privateBytes`,
          ),
          workingSetBytes,
          source: "private",
          fallbackReason: null,
        };
      }

      return {
        ...identity,
        measuredBytes: workingSetBytes,
        workingSetBytes,
        source: platform === "win32" ? "rss-fallback" : "rss",
        fallbackReason:
          platform === "win32" ? "privateBytes-unavailable" : null,
      };
    }),
  );

  return {
    measuredBytes: processes.reduce(
      (total, metric) => total + metric.measuredBytes,
      0,
    ),
    workingSetBytes: processes.reduce(
      (total, metric) => total + metric.workingSetBytes,
      0,
    ),
    measurement,
    processCount: processes.length,
    fallbackProcessCount: processes.filter((metric) =>
      metric.source.endsWith("fallback"),
    ).length,
    processes,
  };
}
