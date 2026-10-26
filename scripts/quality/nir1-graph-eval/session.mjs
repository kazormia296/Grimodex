/* global window */
// CP-4 S1c-2: one Electron session of the setup driver or the runner
// (TASK §8, §15.1, §15.7; DR-CP4-S1C2-2, -6).
//
// A session is the S1c-1 launcher used end to end: a fresh profile, the
// observer bundle, the loopback static server of the harness renderer build,
// Playwright `_electron` under the Xvfb wrapper (host network namespace,
// Wayland/D-Bus removed), the socket sampler for the Electron lifetime, and a
// stop by pid with the evidence (net log, socket samples, X11 listing,
// profile egress files). Nothing here decides a measurement.

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
// Imported before the harness renderer build: the build's Tailwind loader
// registers module resolution hooks that a later `import("playwright")`
// would go through.
import { _electron } from "playwright";
import { addCleanupHook, installCleanupHandlers } from "./signal-cleanup.mjs";
import {
  analyzeNetLog,
  assertX11Ozone,
  assessSocketSamples,
  parseNetLogText,
  parseProcStat,
  readProcessTree,
  startSocketSampler,
} from "./egress.mjs";
import {
  PRODUCT_MAIN,
  ROOT,
  assertXvfbWrapperEnv,
  assessObserverRecord,
  buildElectronLaunchEnv,
  launchGraphEvalElectron,
  prepareEvalProfile,
  snapshotElectronPids,
  stopElectron,
  survivingPids,
  runtimeDirOf,
} from "./launcher.mjs";
import { MAIN_WORKER, WORKER_FILE_NAME } from "./eval-native-build.mjs";
import { assessX11Listing } from "./receipt.mjs";

export const HARNESS_PAGE =
  "/scripts/quality/nir1-graph-eval/renderer/cp4-harness.html";
export const PAGE_READY_TIMEOUT_MS = 120_000;

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function x11Listing() {
  return readdirSync("/tmp/.X11-unix")
    .sort()
    .map((name) => {
      const info = statSync(path.join("/tmp/.X11-unix", name));
      return { name, ino: info.ino, mtimeMs: info.mtimeMs };
    });
}

/**
 * B-5: sessions not stopped yet. Playwright starts Electron `detached` (its
 * own process group); the Xvfb wrapper cancels by SIGTERM to the harness and
 * SIGKILL 500 ms later, which is shorter than Playwright's graceful
 * `app.close()`. On SIGTERM／SIGINT the harness kills every recorded Electron
 * process (the group of the root pid, then each surviving pid) synchronously
 * before it exits; the pid list is also written to the session directory.
 */
const LIVE_SESSIONS = new Set();
let signalCleanupInstalled = false;

export function killLiveSessionsSync(
  live,
  { procRoot = "/proc", kill = process.kill } = {},
) {
  const killed = [];
  for (const session of live) {
    const recorded = session.recorded();
    const alive = survivingPids(recorded, procRoot);
    if (alive.some((row) => row.pid === session.rootPid))
      try {
        kill(-session.rootPid, "SIGKILL");
      } catch {
        // the group is gone
      }
    for (const row of alive) {
      try {
        kill(row.pid, "SIGKILL");
      } catch {
        // already gone
      }
      killed.push(row.pid);
    }
  }
  return killed;
}

/**
 * E-13: Electron the harness launched but has not registered yet (during
 * `_electron.launch`, up to 60 s): Playwright spawns it as a direct child of
 * this process in its own group. Kill the group of every direct child whose
 * comm is electron.
 */
export function killChildElectronGroupsSync({
  procRoot = "/proc",
  parentPid = process.pid,
  kill = process.kill,
} = {}) {
  let entries;
  try {
    entries = readdirSync(procRoot);
  } catch {
    return [];
  }
  const killed = [];
  for (const entry of entries) {
    if (!/^\d+$/u.test(entry)) continue;
    let stat;
    try {
      stat = parseProcStat(
        readFileSync(path.join(procRoot, entry, "stat"), "utf8"),
      );
    } catch {
      continue;
    }
    if (stat.ppid !== parentPid || !/electron/iu.test(stat.comm)) continue;
    try {
      kill(-stat.pid, "SIGKILL");
      killed.push(stat.pid);
    } catch {
      // the group is gone
    }
  }
  return killed;
}

/**
 * B-5 / E-13: installed before the first launch (startSession, smoke), so a
 * cancel during `_electron.launch` also kills Electron.
 */
export function installSignalCleanup() {
  if (signalCleanupInstalled) return;
  signalCleanupInstalled = true;
  // P2-4 (d): one handler per process (signal-cleanup.mjs), shared with the
  // keep test's process group.
  addCleanupHook(() => {
    killLiveSessionsSync(LIVE_SESSIONS);
    killChildElectronGroupsSync();
  });
  installCleanupHandlers();
}

/**
 * E-9: a unix socket path is at most 107 bytes. Chromium puts its sockets at
 * `<TMPDIR>/.org.chromium.Chromium.XXXXXX/SingletonSocket` (46 bytes after
 * TMPDIR).
 */
export const SOCKET_PATH_MAX_BYTES = 107;
export const SOCKET_SUFFIX_BYTES =
  "/.org.chromium.Chromium.XXXXXX/SingletonSocket".length;
const MKDTEMP_BYTES = "/cp4-XXXXXX".length;

function shortTmpBase(candidates) {
  const fits = candidates.find(
    (base) =>
      Buffer.byteLength(base) + MKDTEMP_BYTES + SOCKET_SUFFIX_BYTES <=
      SOCKET_PATH_MAX_BYTES,
  );
  if (!fits)
    throw new Error(
      `[precheck] no temp directory keeps Chromium's unix socket path within the 108-byte limit (${candidates.join(", ")})`,
    );
  return fits;
}

function statFileOrNull(file) {
  try {
    const info = statSync(file);
    return { ino: info.ino, mtimeMs: info.mtimeMs };
  } catch {
    return null;
  }
}

function hashFileOrNull(file) {
  return existsSync(file) ? sha256(readFileSync(file)) : null;
}

/**
 * A-3: the registration compares Main's worker with the evaluation build's
 * once, when the Backend is built, but the owner spawns Main's path on every
 * prepare. A build in the same worktree during the run would sample another
 * worker than the receipt's. The worker at Main's path is hashed at the
 * start and the end of the session and must equal the evaluation build's
 * (`.node`'s sibling); every worker process seen ran Main's path (a replaced
 * file reads "(deleted)").
 */
export function assessMainWorker({
  mainPath,
  expectedSha256,
  atStart,
  atEnd,
  exes,
  statStart = null,
  statEnd = null,
}) {
  const problems = [];
  const digest = /^[0-9a-f]{64}$/u;
  if (!digest.test(expectedSha256 ?? ""))
    problems.push("the evaluation build's worker is unreadable");
  else if (atStart !== expectedSha256)
    problems.push("Main's worker differs from the evaluation build's at start");
  if (!digest.test(atEnd ?? "") || atEnd !== atStart)
    problems.push("Main's worker changed during the session");
  // E-12: rebuilt twice back to the same bytes is still a replaced file.
  if (
    !statStart ||
    !statEnd ||
    statStart.ino !== statEnd.ino ||
    statStart.mtimeMs !== statEnd.mtimeMs
  )
    problems.push(
      "Main's worker file was replaced during the session (inode or mtime)",
    );
  const others = [...new Set(exes)].filter((exe) => exe !== mainPath);
  if (others.length > 0)
    problems.push(`a worker ran from another file: ${others.join(", ")}`);
  return {
    ok: problems.length === 0,
    path: mainPath,
    expectedSha256,
    atStart,
    atEnd,
    exes: [...new Set(exes)],
    statStart,
    statEnd,
    problems: problems.map((row) => `[precheck] A-3: ${row}`),
  };
}

/**
 * Starts one session. `extraEnv` carries only the documented Main seams
 * (maintenance / body declaration); it is added after the launch env is
 * built and still passes `assertElectronLaunch`.
 */
export async function startSession({
  runDir,
  label,
  server,
  observer,
  nativePath,
  d2aMode,
  models,
  extraEnv = {},
  tmpRoot = null,
  admission,
  deps = {},
}) {
  const {
    launch = launchGraphEvalElectron,
    prepareProfile = prepareEvalProfile,
    sampleSockets = startSocketSampler,
    snapshotPids = snapshotElectronPids,
    stopApp = stopElectron,
    listX11 = x11Listing,
    wrapperEnv = process.env,
    hashFile = hashFileOrNull,
    statFile = statFileOrNull,
    tmpBase = os.tmpdir(),
    tmpFallback = "/tmp",
  } = deps;
  assertXvfbWrapperEnv(wrapperEnv);
  const dir = path.join(runDir, label);
  await mkdir(dir, { recursive: true });
  // Chromium's unix sockets live under TMPDIR (108-byte limit): the given
  // root, or a fresh directory under the OS temp dir, else /tmp, whichever
  // keeps the socket path within the limit (B P3, E-9). Removed after the stop.
  const tmpDir = tmpRoot
    ? path.join(tmpRoot, `${path.basename(runDir)}-${label}`)
    : await mkdtemp(path.join(shortTmpBase([tmpBase, tmpFallback]), "cp4-"));
  if (Buffer.byteLength(tmpDir) + SOCKET_SUFFIX_BYTES > SOCKET_PATH_MAX_BYTES)
    throw new Error(
      `[precheck] TMPDIR ${tmpDir} leaves no room for Chromium's unix socket path (108-byte limit)`,
    );
  await mkdir(tmpDir, { recursive: true });
  // B-3: the run's own XDG_RUNTIME_DIR (0700), never the user's /run/user.
  await mkdir(runtimeDirOf(tmpDir), { recursive: true, mode: 0o700 });
  await chmod(runtimeDirOf(tmpDir), 0o700);
  const userData = path.join(dir, "user-data");
  const profile = await prepareProfile({ userData, d2aMode, models });
  const netLogPath = path.join(dir, "netlog.json");
  const productMain = path.join(ROOT, PRODUCT_MAIN);
  const env = {
    ...buildElectronLaunchEnv(wrapperEnv, {
      userData,
      nativePath,
      rendererUrl: server.url(HARNESS_PAGE),
      productMain,
      tmpDir,
    }),
    ...extraEnv,
  };
  const evidence = {
    label,
    x11Before: listX11(),
    profile: { d2aMode, d2aStateFile: profile.d2aStateFile },
    extraEnvNames: Object.keys(extraEnv).sort(),
    problems: [],
  };
  const recorded = new Map();
  const mainWorkerPath = path.join(ROOT, MAIN_WORKER);
  const workerPin = {
    expectedSha256: hashFile(
      path.join(path.dirname(nativePath), WORKER_FILE_NAME),
    ),
    atStart: hashFile(mainWorkerPath),
    statStart: statFile(mainWorkerPath),
  };
  // E-13: before the launch, not after it.
  if (deps.signals !== false) installSignalCleanup();
  const handle = await launch({
    observer,
    env,
    netLogPath,
    electron: { _electron },
    admission,
  });
  evidence.launch = {
    removedEnv: handle.launch?.removedEnv ?? null,
    checkedAbsent: handle.launch?.checkedAbsent ?? null,
    netns: handle.launch?.netns ?? null,
  };
  const sampler = sampleSockets({ rootPid: handle.pid });
  const remember = () => {
    for (const row of snapshotPids(handle.pid))
      recorded.set(`${row.pid}:${row.startTime}`, row);
    try {
      writeFileSync(
        path.join(dir, "electron-pids.json"),
        `${JSON.stringify([...recorded.values()])}\n`,
      );
    } catch {
      // the list is a convenience for a check after the wrapper
    }
  };
  const live = { rootPid: handle.pid, recorded: () => [...recorded.values()] };
  if (deps.signals !== false) LIVE_SESSIONS.add(live);
  remember();
  let page;
  try {
    page = await handle.app.firstWindow();
    await page.waitForFunction(() => window.cp4Harness?.ready === true, null, {
      timeout: PAGE_READY_TIMEOUT_MS,
    });
    remember();
    evidence.observer = await handle.app.evaluate(
      () => globalThis.__cp4Observer,
    );
    evidence.observerCheck = assessObserverRecord(evidence.observer, {
      stderr: handle.stderr(),
    });
    if (!evidence.observerCheck.ok)
      evidence.problems.push(
        `observer: ${evidence.observerCheck.problems.join("; ")}`,
      );
    evidence.ozone = assertX11Ozone(readProcessTree(handle.pid));
    evidence.instrumentation = await page.evaluate(() =>
      window.cp4Harness.instrument(),
    );
  } catch (error) {
    evidence.problems.push(`start: ${error?.stack ?? error}`);
  }
  // Only the free evaluation entries are called, in the Main, on the module
  // the Main loaded (V-9).
  let stopping = null;
  const addon = (name, ...args) => {
    if (!/^nir1GraphEval[A-Za-z0-9]+$/u.test(name))
      throw new Error(`[precheck] ${name} is not an evaluation entry`);
    return handle.app.evaluate(
      async (_electron, [file, entry, input]) => {
        const Module = process.getBuiltinModule("node:module");
        const native = Module.createRequire(file)(file);
        return String(await native[entry](...input));
      },
      [nativePath, name, args],
    );
  };
  return {
    dir,
    userData,
    page,
    app: handle.app,
    pid: handle.pid,
    evidence,
    addon,
    remember,
    pids: () => [...recorded.values()].map((row) => row.pid),
    // Main の stderr の全体（D′ の確認で固定の失敗の code を数える）。
    stderr: () => handle.stderr(),
    // Memoized: a caller that stops a session a failed check already
    // stopped gets the same evidence (B-1).
    stop() {
      stopping ??= stopOnce();
      return stopping;
    },
  };
  async function stopOnce() {
    remember();
    const socketSamples = sampler.stop();
    evidence.stop = await stopApp(handle, [...recorded.values()]);
    LIVE_SESSIONS.delete(live);
    if (handle.addonCheck?.evaluation === true) {
      evidence.mainWorker = assessMainWorker({
        mainPath: mainWorkerPath,
        ...workerPin,
        atEnd: hashFile(mainWorkerPath),
        statEnd: statFile(mainWorkerPath),
        exes: socketSamples
          .flatMap((sample) => sample.processes ?? [])
          .map((row) => row.exe)
          .filter(
            (exe) =>
              typeof exe === "string" &&
              path.basename(exe).startsWith(WORKER_FILE_NAME),
          ),
      });
      evidence.problems.push(...evidence.mainWorker.problems);
    }
    evidence.recordedPids = [...recorded.values()];
    evidence.stderrTail = handle.stderr().slice(-4000);
    if (evidence.stop.remaining.length > 0)
      evidence.problems.push(
        `processes left: ${evidence.stop.remaining.join(",")}`,
      );
    evidence.socketSamples = socketSamples;
    evidence.socketCheck = assessSocketSamples({
      samples: socketSamples,
      run: {
        startedAtMs: socketSamples[0]?.atMs ?? Date.now(),
        finishedAtMs: socketSamples.at(-1)?.atMs ?? Date.now(),
      },
    });
    if (evidence.socketCheck.violations.length > 0)
      evidence.problems.push(
        `sockets: ${evidence.socketCheck.violations.join("; ")}`,
      );
    if (existsSync(netLogPath)) {
      const text = await readFile(netLogPath, "utf8");
      const { log, truncated } = parseNetLogText(text);
      evidence.netLog = {
        path: path.relative(ROOT, netLogPath),
        sha256: sha256(Buffer.from(text)),
        truncated,
        ...analyzeNetLog(log, {
          blackholePort: evidence.observer?.blackholePort ?? null,
        }),
      };
      if (evidence.netLog.nonLoopbackAttempts !== 0)
        evidence.problems.push(
          `net log: ${JSON.stringify(evidence.netLog.attempts)}`,
        );
    } else evidence.problems.push("no net log was written");
    const dictionaries = path.join(userData, "Dictionaries");
    evidence.dictionaries = existsSync(dictionaries)
      ? readdirSync(dictionaries)
      : [];
    if (evidence.dictionaries.some((name) => name.endsWith(".bdic")))
      evidence.problems.push("dictionaries were fetched");
    try {
      const state = JSON.parse(
        await readFile(path.join(userData, "Network Persistent State"), "utf8"),
      );
      evidence.networkPersistentServers = (
        state?.net?.http_server_properties?.servers ?? []
      ).map((entry) => entry.server);
    } catch (error) {
      evidence.networkPersistentServers =
        error?.code === "ENOENT" ? [] : [`unreadable: ${error?.code}`];
    }
    if (
      evidence.networkPersistentServers.some(
        (entry) => !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/u.test(entry),
      )
    )
      evidence.problems.push("persisted non-loopback servers");
    // B P3: the scratch TMPDIR (sockets, the run's XDG_RUNTIME_DIR) goes.
    evidence.tmp = { path: tmpDir, removed: false };
    try {
      await rm(tmpDir, { recursive: true, force: true });
      evidence.tmp.removed = true;
    } catch (error) {
      evidence.problems.push(
        `the session TMPDIR was not removed: ${error?.code}`,
      );
    }
    evidence.x11After = listX11();
    // E-15: the run's side effects only; another process's new entry is
    // recorded for the retake decision.
    evidence.x11Assessment = assessX11Listing(
      evidence.x11Before,
      evidence.x11After,
    );
    if (evidence.x11Assessment.sideEffects.length > 0)
      evidence.problems.push(
        `X11 entries present before changed or vanished: ${evidence.x11Assessment.sideEffects.join(", ")}`,
      );
    return evidence;
  }
}
