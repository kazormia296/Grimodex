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
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
// Imported before the harness renderer build: the build's Tailwind loader
// registers module resolution hooks that a later `import("playwright")`
// would go through.
import { _electron } from "playwright";
import {
  analyzeNetLog,
  assertX11Ozone,
  assessSocketSamples,
  parseNetLogText,
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
} from "./launcher.mjs";
import { MAIN_WORKER, WORKER_FILE_NAME } from "./eval-native-build.mjs";

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
}) {
  const problems = [];
  const digest = /^[0-9a-f]{64}$/u;
  if (!digest.test(expectedSha256 ?? ""))
    problems.push("the evaluation build's worker is unreadable");
  else if (atStart !== expectedSha256)
    problems.push("Main's worker differs from the evaluation build's at start");
  if (!digest.test(atEnd ?? "") || atEnd !== atStart)
    problems.push("Main's worker changed during the session");
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
  } = deps;
  assertXvfbWrapperEnv(wrapperEnv);
  const dir = path.join(runDir, label);
  await mkdir(dir, { recursive: true });
  // Chromium's unix sockets live under TMPDIR (108-byte limit): a short
  // scratch root may be given; the default is the session directory.
  const tmpDir = tmpRoot
    ? path.join(tmpRoot, `${path.basename(runDir)}-${label}`)
    : path.join(dir, "tmp");
  await mkdir(tmpDir, { recursive: true });
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
  };
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
  };
  const sampler = sampleSockets({ rootPid: handle.pid });
  const remember = () => {
    for (const row of snapshotPids(handle.pid))
      recorded.set(`${row.pid}:${row.startTime}`, row);
  };
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
    if (handle.addonCheck?.evaluation === true) {
      evidence.mainWorker = assessMainWorker({
        mainPath: mainWorkerPath,
        ...workerPin,
        atEnd: hashFile(mainWorkerPath),
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
    evidence.x11After = listX11();
    if (
      JSON.stringify(evidence.x11After) !== JSON.stringify(evidence.x11Before)
    )
      evidence.problems.push("the /tmp/.X11-unix listing changed");
    return evidence;
  }
}
