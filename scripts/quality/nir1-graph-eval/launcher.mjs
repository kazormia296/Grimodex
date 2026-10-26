// CP-4 S1c-1: launches the product Electron Main behind the NC-1 observer
// (TASK §15.1 D6 (a'), §8, §15.7; DR-CP4-S1C1-1〜4).
//
// Pure parts (node:test): the wrapper-env check, the launch env, the argv,
// the stderr scan for fixed failure codes, the observer record check and the
// process-exit check. IO parts: bundling the observer, preparing a fresh
// evaluation profile, launching through Playwright `_electron`, and stopping
// by pid. Electron must run under `scripts/local-ci-xvfb.mjs` in the host
// network namespace; never under `xvfb-run` or `unshare`.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";
import { placeD2aProfileState } from "../run-nir1-retrieval.mjs";
import { isLaunchAdmission, readNetNamespaces } from "./admission.mjs";
import { parseProcStat, readProcessTree } from "./egress.mjs";
import { scanNativeBinary } from "./native-architecture.mjs";
import { OBSERVER_LINE_PREFIX, OBSERVER_SCHEMA } from "./observer-core.mjs";
import { assertElectronLaunch } from "./receipt.mjs";

export const ROOT = path.resolve(import.meta.dirname, "../../..");
export const OBSERVER_ENTRY =
  "scripts/quality/nir1-graph-eval/electron-observer.entry.mjs";
export const NC1_SOURCES = Object.freeze([
  "electron/main/rendererContainment.ts",
  "electron/main/rendererContainmentListener.ts",
  "electron/main/rendererContainmentStartup.ts",
]);
export const PRODUCT_MAIN = "dist-electron/main.cjs";
/** The addon Main loads without GRIMODEX_NODE_PATH (§15.2). */
export const DEFAULT_ADDON = "electron/native/grimodex-node/grimodex-node.node";
export const ELECTRON_LAUNCH_TIMEOUT_MS = 60_000;

/** Removed from the launch env (desktop, session bus, proxies, node mode). */
export const REMOVED_LAUNCH_ENV = Object.freeze([
  "WAYLAND_DISPLAY",
  "WAYLAND_SOCKET",
  "DBUS_SESSION_BUS_ADDRESS",
  "DBUS_SYSTEM_BUS_ADDRESS",
  "ELECTRON_RUN_AS_NODE",
  "ELECTRON_RENDERER_URL",
  "GRIMODEX_NODE_PATH",
  "GRIMODEX_USER_DATA_DIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  // B-3 (P3): the other proxy variables Chromium reads.
  "auto_proxy",
  "SOCKS_SERVER",
  "ftp_proxy",
  "FTP_PROXY",
  "XDG_CURRENT_DESKTOP",
  "XDG_SESSION_DESKTOP",
  "DESKTOP_SESSION",
  "GDMSESSION",
  "GNOME_DESKTOP_SESSION_ID",
  "KDE_FULL_SESSION",
]);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * The harness runs under the repository's Xvfb wrapper (S1
 * `requireOffscreenDisplay`): the wrapper's marker, a `:N` display that is
 * not `:0`, the wrapper's private cookie, an x11 session type, no Wayland.
 */
export function assertXvfbWrapperEnv(env) {
  const problems = [];
  if (env.GRIMODEX_LOCAL_CI_XVFB !== "1")
    problems.push("not under scripts/local-ci-xvfb.mjs");
  if (!/^:\d+$/u.test(env.DISPLAY ?? "") || env.DISPLAY === ":0")
    problems.push("DISPLAY is not the wrapper's Xvfb display");
  if (
    !env.XAUTHORITY ||
    !path.isAbsolute(env.XAUTHORITY) ||
    !path.basename(path.dirname(env.XAUTHORITY)).startsWith("grimodex-xvfb-")
  )
    problems.push("XAUTHORITY is not the wrapper's private cookie");
  if (env.XDG_SESSION_TYPE !== "x11") problems.push("XDG_SESSION_TYPE!=x11");
  if (env.WAYLAND_DISPLAY !== undefined || env.WAYLAND_SOCKET !== undefined)
    problems.push("a Wayland variable is set");
  if (problems.length > 0)
    throw new Error(
      `[precheck] refusing to launch Electron outside the Xvfb wrapper: ${problems.join("; ")}`,
    );
  return { display: env.DISPLAY };
}

/**
 * B-3: the run's XDG_RUNTIME_DIR (0700, created by the caller). Without
 * DBUS_SESSION_BUS_ADDRESS, libdbus／GDBus connect to `$XDG_RUNTIME_DIR/bus`,
 * the user's real session bus (AT-SPI, libsecret, portals); the run's own
 * directory has none.
 */
export function runtimeDirOf(tmpDir) {
  return path.join(tmpDir, "xdg-runtime");
}

/**
 * The `_electron.launch` env, built from the wrapper env: the desktop,
 * session-bus, proxy and node-mode variables are removed; the x11 ozone hint,
 * the run's TMPDIR, profile, addon, renderer URL and product main are set.
 */
export function buildElectronLaunchEnv(
  baseEnv,
  { userData, nativePath, rendererUrl, productMain, tmpDir },
) {
  for (const [name, value] of Object.entries({
    userData,
    nativePath,
    productMain,
    tmpDir,
  }))
    if (typeof value !== "string" || !path.isAbsolute(value))
      throw new Error(`[precheck] ${name} must be an absolute path`);
  const env = { ...baseEnv };
  for (const name of REMOVED_LAUNCH_ENV) delete env[name];
  return {
    ...env,
    ELECTRON_OZONE_PLATFORM_HINT: "x11",
    TMPDIR: tmpDir,
    XDG_RUNTIME_DIR: runtimeDirOf(tmpDir),
    NO_AT_BRIDGE: "1",
    GRIMODEX_USER_DATA_DIR: userData,
    GRIMODEX_NODE_PATH: nativePath,
    ELECTRON_RENDERER_URL: rendererUrl,
    GRIMODEX_CP4_PRODUCT_MAIN: productMain,
  };
}

/** Electron argv: the net log switch, then the observer as the app entry. */
export function buildElectronArgs({ observerPath, netLogPath }) {
  for (const value of [observerPath, netLogPath])
    if (typeof value !== "string" || !path.isAbsolute(value))
      throw new Error("[precheck] observer and net log paths must be absolute");
  return [`--log-net-log=${netLogPath}`, observerPath];
}

const FAILURE_LINE =
  /\[grimodex-electron\] (NC-[A-Z-]+)|\[cp4-observer\] (CP4-OBS-[A-Z-]+)/gu;

/** NC-1 fixed codes and observer codes found in the Main's stderr. */
export function findFailureCodes(stderr) {
  const codes = [];
  for (const match of String(stderr).matchAll(FAILURE_LINE))
    codes.push(match[1] ?? match[2]);
  return codes;
}

/**
 * The observer record read back with `app.evaluate` must show the product
 * order: the switch and the policy handler before the product main, the
 * first default-session touch at setProxy before the release, start() true,
 * the read-back of the one bypass, the spellchecker off, no failure line.
 */
export function assessObserverRecord(record, { stderr = "" } = {}) {
  const problems = [];
  if (record?.schema !== OBSERVER_SCHEMA) problems.push("no observer record");
  const at = Object.fromEntries(
    (record?.marks ?? []).map((row, index) => [row.name, index]),
  );
  const order = [
    "appendSwitch host-resolver-rules",
    "registerWebContentsPolicy",
    "product main require",
    "ready",
    "listener up",
    "defaultSession first touch",
    "setProxy start",
    "setProxy done",
    "nc1 start done",
    "released",
  ];
  for (let index = 0; index < order.length; index++)
    if (at[order[index]] === undefined)
      problems.push(`mark ${order[index]} missing`);
    else if (index > 0 && at[order[index - 1]] > at[order[index]])
      problems.push(`${order[index - 1]} is not before ${order[index]}`);
  if (record?.startOk !== true) problems.push("NC-1 start() did not succeed");
  if (record?.released !== true) problems.push("the product was not released");
  if (record?.spellcheckerEnabledAfter !== false)
    problems.push("the spellchecker is not off");
  const origin = record?.staticOrigin;
  if (
    record?.proxyConfig?.proxyBypassRules !== `<-loopback>;${origin}` ||
    record?.proxyConfig?.proxyRules !==
      `socks5://127.0.0.1:${record?.blackholePort}`
  )
    problems.push("the proxy config is not the product config plus one bypass");
  if (
    record?.readBack?.staticOrigin !== "DIRECT" ||
    [
      record?.readBack?.otherLoopbackPort,
      record?.readBack?.loopbackPort1,
      record?.readBack?.external,
    ].some((value) => value !== record?.readBack?.expectedBlackhole)
  )
    problems.push("the bypass read-back differs");
  if (!/MAP \* ~NOTFOUND/u.test(record?.hostResolverRules ?? ""))
    problems.push("host-resolver-rules is not the product value");
  const codes = findFailureCodes(stderr);
  if (codes.length > 0)
    problems.push(`failure codes in stderr: ${codes.join(",")}`);
  if ((record?.failures ?? []).length > 0)
    problems.push(`observer failures: ${record.failures.join(",")}`);
  return { ok: problems.length === 0, problems, failureCodes: codes };
}

/** Bundles the observer entry (electron and `*.node` external). */
export async function bundleObserver({ root = ROOT, outDir }) {
  const { build } = await import("esbuild");
  await mkdir(outDir, { recursive: true });
  const outfile = path.join(outDir, "observer.cjs");
  const result = await build({
    entryPoints: [path.join(root, OBSERVER_ENTRY)],
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    external: ["electron", "*.node"],
    logLevel: "error",
    metafile: true,
  });
  const inputs = Object.keys(result.metafile.inputs).sort();
  for (const source of NC1_SOURCES)
    assert.ok(
      inputs.includes(source),
      `[precheck] the observer bundle lacks the product NC-1 module ${source}`,
    );
  const sources = {};
  for (const input of inputs)
    sources[input] = sha256(await readFile(path.join(root, input)));
  return {
    path: outfile,
    sha256: sha256(await readFile(outfile)),
    entry: OBSERVER_ENTRY,
    sources,
  };
}

/**
 * A fresh evaluation profile: the D2a state for the mode, the pinned models
 * verified against the manifest (never downloaded), no legacy key import, no
 * recent workspace.
 */
export async function prepareEvalProfile({
  userData,
  d2aMode,
  models,
  root = ROOT,
}) {
  await mkdir(userData, { recursive: true });
  const manifest = JSON.parse(
    readFileSync(path.join(root, "evals/nir1-retrieval/manifest.json"), "utf8"),
  );
  const placed = {};
  for (const language of ["ja", "en"]) {
    const spec = manifest.models[language];
    const source = models?.[language];
    if (!source || !existsSync(source))
      throw new Error(`[precheck] the pinned ${language} model is required`);
    const modelBytes = await readFile(source);
    if (sha256(modelBytes) !== spec.artifactSha256)
      throw new Error(
        `[precheck] ${language} model SHA mismatch (no download)`,
      );
    const tokenizer = path.join(
      root,
      "src-tauri/resources/semantic",
      spec.directory,
      "tokenizer.json",
    );
    if (sha256(await readFile(tokenizer)) !== spec.tokenizerSha256)
      throw new Error(`[precheck] ${language} tokenizer SHA mismatch`);
    const destination = path.join(userData, "models", spec.directory);
    await mkdir(destination, { recursive: true });
    await copyFile(source, path.join(destination, "model_int8.onnx"));
    await copyFile(tokenizer, path.join(destination, "tokenizer.json"));
    await writeFile(
      path.join(destination, "model_int8.onnx.sha256"),
      spec.artifactSha256,
    );
    placed[language] = {
      modelSha256: spec.artifactSha256,
      tokenizerSha256: spec.tokenizerSha256,
    };
  }
  await writeFile(
    path.join(userData, "legacy-keyring-migration-v1.json"),
    JSON.stringify({
      version: 1,
      completedAt: new Date().toISOString(),
      imported: 0,
      skippedExisting: 0,
      fixtureOnly: true,
    }),
  );
  await writeFile(
    path.join(userData, "global-settings.json"),
    JSON.stringify({
      recentWorkspaces: [],
      lastActiveWorkspace: null,
      theme: "system",
      uiLanguage: "en",
      uiScale: 100,
      showLauncherOnStartup: false,
      userPreferences: { "data.autoBackup": "false" },
    }),
  );
  const d2aStateFile = await placeD2aProfileState(userData, d2aMode);
  return {
    userData,
    d2aMode,
    d2aStateFile: d2aStateFile ?? null,
    models: placed,
  };
}

function readProcStart(pid, procRoot) {
  try {
    const text = readFileSync(path.join(procRoot, String(pid), "stat"), "utf8");
    const fields = text
      .slice(text.lastIndexOf(")") + 2)
      .trim()
      .split(" ");
    parseProcStat(text);
    return fields[19] ?? null;
  } catch {
    return null;
  }
}

/** The pids (with their start times) of the Electron tree right now. */
export function snapshotElectronPids(rootPid, procRoot = "/proc") {
  return readProcessTree(rootPid, procRoot).map((row) => ({
    pid: row.pid,
    startTime: readProcStart(row.pid, procRoot),
    type: row.type,
  }));
}

/** The recorded pids still alive (same pid and same start time). */
export function survivingPids(recorded, procRoot = "/proc") {
  return recorded.filter(
    (row) =>
      row.startTime !== null &&
      readProcStart(row.pid, procRoot) === row.startTime,
  );
}

/**
 * D-6 / A-4 (§15.2), checked at every launch: the default addon path holds
 * no evaluation build (no evaluation string, and not the bytes launched),
 * and an evaluation `.node` (it carries the evaluation strings) launches only
 * with an admission (admitGraphCaseRun or admitDevPreview).
 */
export function assertLaunchAdmitted({
  root = ROOT,
  nativePath,
  admission,
  read = readFileSync,
}) {
  if (typeof nativePath !== "string" || !path.isAbsolute(nativePath))
    throw new Error("[precheck] the launched addon path must be absolute");
  const bytes = read(nativePath);
  const evaluation = scanNativeBinary(bytes, "eval").length === 0;
  const defaultPath = path.join(root, DEFAULT_ADDON);
  let defaultAddon = null;
  if (existsSync(defaultPath)) {
    const defaultBytes = read(defaultPath);
    const digest = sha256(defaultBytes);
    if (
      scanNativeBinary(defaultBytes, "product").length > 0 ||
      (evaluation && digest === sha256(bytes))
    )
      throw new Error(
        "[precheck] the default addon path holds an evaluation build; refusing to launch",
      );
    defaultAddon = { sha256: digest, product: true };
  }
  if (evaluation && !isLaunchAdmission(admission))
    throw new Error(
      "[precheck] launching the evaluation .node needs the admission of admitGraphCaseRun or admitDevPreview",
    );
  return {
    evaluation,
    nativeSha256: sha256(bytes),
    defaultAddon,
    admission: evaluation ? (admission.kind ?? "graph-case") : null,
  };
}

/**
 * Launches the product Main behind the observer. Checks the wrapper env and
 * `assertElectronLaunch` before launching, captures the Main's stdout and
 * stderr, and returns the handle. The caller stops it with `stopElectron`.
 */
export async function launchGraphEvalElectron({
  root = ROOT,
  observer,
  env,
  netLogPath,
  netns = readNetNamespaces(),
  electron,
  admission,
}) {
  assertXvfbWrapperEnv(process.env);
  const addonCheck = assertLaunchAdmitted({
    root,
    nativePath: env?.GRIMODEX_NODE_PATH,
    admission,
  });
  const args = buildElectronArgs({ observerPath: observer.path, netLogPath });
  const launch = assertElectronLaunch({
    env,
    argv: args,
    xvfbDisplay: process.env.DISPLAY,
    netns,
  });
  const { _electron } = electron ?? (await import("playwright"));
  const require = createRequire(import.meta.url);
  const app = await _electron.launch({
    executablePath: require("electron"),
    args,
    cwd: root,
    env,
    timeout: ELECTRON_LAUNCH_TIMEOUT_MS,
  });
  const child = app.process();
  let stderr = "";
  let stdout = "";
  child.stderr?.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdout?.on("data", (chunk) => {
    stdout += chunk;
  });
  return {
    app,
    pid: child.pid,
    // B-2: the names this launch env actually lacks from the wrapper env,
    // besides the desktop names assertElectronLaunch checked absent.
    launch: {
      ...launch,
      checkedAbsent: launch.removedEnv,
      removedEnv: Object.keys(process.env)
        .filter((name) => !Object.hasOwn(env, name))
        .sort(),
    },
    addonCheck,
    args,
    stderr: () => stderr,
    stdout: () => stdout,
  };
}

/**
 * Stops Electron: `app.close()` (bounded), then confirms every recorded pid
 * is gone. Survivors are signalled by pid (SIGTERM, then SIGKILL); a name
 * pattern is never used. Returns the evidence.
 */
export async function stopElectron(
  handle,
  recordedPids,
  {
    closeTimeoutMs = 15_000,
    signalWaitMs = 2_000,
    procRoot = "/proc",
    kill = process.kill,
  } = {},
) {
  let closed = false;
  let timer;
  try {
    await Promise.race([
      handle.app.close().then(() => {
        closed = true;
      }),
      new Promise((resolve) => {
        timer = setTimeout(resolve, closeTimeoutMs);
      }),
    ]);
  } catch {
    // fall through to the pid check
  } finally {
    clearTimeout(timer);
  }
  const signalled = [];
  for (const signal of ["SIGTERM", "SIGKILL"]) {
    const alive = survivingPids(recordedPids, procRoot);
    if (alive.length === 0) break;
    for (const row of alive) {
      try {
        kill(row.pid, signal);
        signalled.push({ pid: row.pid, signal });
      } catch {
        // already gone
      }
    }
    await new Promise((resolve) => setTimeout(resolve, signalWaitMs));
  }
  return {
    closed,
    signalled,
    remaining: survivingPids(recordedPids, procRoot).map((row) => row.pid),
  };
}

export { OBSERVER_LINE_PREFIX };
