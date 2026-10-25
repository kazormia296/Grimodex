// CP-4 S1c-2: the D3 measurement-window samples (TASK §4.1 D3, §15.10;
// DR-CP4-S1C2-6).
//
// Every 20 s and before/after a run the harness records, without taking any
// lock: the heavy.sh slots in use (read from /proc/locks, never by flock), the
// build and test processes on the host (/proc/*/cmdline, the harness's own
// process tree excluded by pid), other CP-4/P measurements, whether a build
// runs in this worktree, and the host snapshot (load average, PSI). No load
// threshold is applied (GDX-PRECHECK-001); `receipt.mjs`
// `assessMeasurementWindow` decides only on what was observed.
//
// The parsers are pure (node:test); `readWindowSample` and
// `startWindowSampler` read /proc.

import { readFileSync, readdirSync, readlinkSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { clearInterval, setInterval } from "node:timers";
import { WINDOW_SAMPLE_INTERVAL_MS } from "./constants.mjs";

export const HEAVY_SLOT_DIR = "/tmp/claude-1000/cargo-slots";
export const HEAVY_SLOT_NAMES = Object.freeze(["slot1", "slot2", "slot3"]);

/**
 * `/proc/locks` lines → the inodes that hold a lock. A line reads
 * `1: FLOCK  ADVISORY  WRITE 1234 00:2a:5678 0 EOF`; blocked waiters
 * (`->`) are not holders.
 */
export function lockedInodes(text) {
  const inodes = new Set();
  for (const line of String(text).split("\n")) {
    if (line.includes("->")) continue;
    const match =
      /^\d+:\s+\S+\s+\S+\s+\S+\s+\d+\s+[0-9a-f]+:[0-9a-f]+:(\d+)\s/iu.exec(
        line,
      );
    if (match) inodes.add(Number(match[1]));
  }
  return inodes;
}

/** The heavy.sh slots in use: slot files whose inode holds a lock. */
export function heavySlotsInUse({ locksText, slotInodes }) {
  const locked = lockedInodes(locksText);
  return slotInodes.filter((inode) => locked.has(inode)).length;
}

const BUILD_BINARIES = new Set([
  "cargo",
  "rustc",
  "cargo-clippy",
  "clippy-driver",
  "rustdoc",
]);

/**
 * One process's argv → the build, test or measurement it is (or null).
 * `kind` is `build` (D3 (1)/(4)), `test` (D3 (2)) or `measurement` (D3 (3)).
 */
export function classifyProcess(argv) {
  if (!Array.isArray(argv) || argv.length === 0) return null;
  const binary = path.basename(argv[0]);
  const joined = argv.join(" ");
  if (BUILD_BINARIES.has(binary)) return { kind: "build", command: binary };
  if (/(^|[\s/])napi(\.js)?\s+build\b/u.test(joined))
    return { kind: "build", command: "napi build" };
  if (/(^|[\s/])vite(\.js|\.mjs)?\s+build\b/u.test(joined))
    return { kind: "build", command: "vite build" };
  if (/electron\/scripts\/build\.mjs/u.test(joined))
    return { kind: "build", command: "electron build" };
  if (/electron-builder/u.test(joined))
    return { kind: "build", command: "electron-builder" };
  if (/(^|[\s/])(vitest|playwright)(\.js|\.mjs)?(\s|$)/u.test(joined))
    return {
      kind: "test",
      command: binary === "node" ? "vitest/playwright" : binary,
    };
  if (
    /local-ci-(quick|full)|product-journeys?\.mjs|scripts\/local-ci\.mjs/u.test(
      joined,
    )
  )
    return { kind: "test", command: "local-ci/journey" };
  if (/run-nir1-retrieval\.mjs/u.test(joined))
    return { kind: "measurement", command: "nir1-retrieval" };
  if (/nir1-graph-eval\/(runner|setup-driver)\.mjs/u.test(joined))
    return { kind: "measurement", command: "cp4" };
  return null;
}

/**
 * The window fields of one sample from a process listing
 * (`[{pid, argv, cwd}]`). Processes in `ownPids` are excluded (the harness,
 * its Electron tree); a build whose cwd is inside `root` is a same-worktree
 * build.
 */
export function windowFields({ processes, ownPids, root, heavySlots }) {
  const own = new Set(ownPids);
  const buildProcesses = [];
  const otherMeasurements = [];
  let sameWorktreeBuild = false;
  for (const row of processes) {
    if (own.has(row.pid)) continue;
    const kind = classifyProcess(row.argv);
    if (!kind) continue;
    if (kind.kind === "build") {
      buildProcesses.push({ pid: row.pid, command: kind.command });
      if (
        typeof row.cwd === "string" &&
        (row.cwd === root || row.cwd.startsWith(`${root}${path.sep}`))
      )
        sameWorktreeBuild = true;
    } else otherMeasurements.push(`${kind.kind}:${kind.command}:${row.pid}`);
  }
  return {
    heavySlotsInUse: heavySlots,
    buildProcesses,
    otherMeasurements,
    sameWorktreeBuild,
  };
}

function readMaybe(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function listProcesses(procRoot) {
  const rows = [];
  for (const name of readdirSync(procRoot)) {
    if (!/^\d+$/u.test(name)) continue;
    const cmdline = readMaybe(path.join(procRoot, name, "cmdline"));
    if (!cmdline) continue;
    let cwd;
    try {
      cwd = readlinkSync(path.join(procRoot, name, "cwd"));
    } catch {
      cwd = null;
    }
    rows.push({
      pid: Number(name),
      argv: cmdline.split("\0").filter(Boolean),
      cwd,
    });
  }
  return rows;
}

function slotInodes(dir) {
  const inodes = [];
  for (const name of HEAVY_SLOT_NAMES)
    try {
      inodes.push(statSync(path.join(dir, name)).ino);
    } catch {
      // a slot file that does not exist yet cannot be held
    }
  return inodes;
}

/** Host snapshot (the shape of `run-nir1-retrieval.mjs` `snapshotHost`). */
export function hostSnapshot() {
  return {
    timestamp: new Date().toISOString(),
    os: os.type(),
    kernel: os.release(),
    arch: os.arch(),
    cpuModel: os.cpus()[0]?.model,
    logicalCpus: os.cpus().length,
    totalMemory: os.totalmem(),
    freeMemory: os.freemem(),
    loadAverage: os.loadavg(),
    node: process.version,
    cpuPressure: readMaybe("/proc/pressure/cpu"),
    ioPressure: readMaybe("/proc/pressure/io"),
    memoryPressure: readMaybe("/proc/pressure/memory"),
  };
}

/** One window sample now. `ownPids()` returns the pids to exclude. */
export function readWindowSample({
  root,
  ownPids,
  procRoot = "/proc",
  slotDir = HEAVY_SLOT_DIR,
}) {
  const heavySlots = heavySlotsInUse({
    locksText: readMaybe(path.join(procRoot, "locks")) ?? "",
    slotInodes: slotInodes(slotDir),
  });
  return {
    atMs: Date.now(),
    ...windowFields({
      processes: listProcesses(procRoot),
      ownPids: ownPids(),
      root,
      heavySlots,
    }),
    loadAverage: os.loadavg(),
    cpuPressure: readMaybe(path.join(procRoot, "pressure/cpu")),
  };
}

/**
 * Samples every 20 s from now until `stop()`, which takes the final sample
 * and returns all of them (the window covers the whole run).
 */
export function startWindowSampler(options) {
  const samples = [readWindowSample(options)];
  const timer = setInterval(() => {
    samples.push(readWindowSample(options));
  }, WINDOW_SAMPLE_INTERVAL_MS);
  timer.unref();
  return {
    samples,
    stop() {
      clearInterval(timer);
      samples.push(readWindowSample(options));
      return samples;
    },
  };
}
