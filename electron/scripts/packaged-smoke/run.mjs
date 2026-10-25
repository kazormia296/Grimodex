/**
 * CP-2b P2 の packaged smoke（K3/3 `nir1-d2a-activation-proposal/3` の Negative (34)。G-pub の道具）。OS 非依存。
 *
 *   node electron/scripts/packaged-smoke/run.mjs --out-dir <dir> [--app <packaged の dir>] [--os <名前>]
 *        [--configs baseline,toolcheck,packaged] [--dns-log <dnslog.so>（Linux だけ。参考）] [--keep]
 *
 * 1 つの OS で 3 構成を直列に走らせる（cp2b-decisions DR-CP2B-P2-2）:
 *   baseline : probe の main（`webrtc-block-probe-main.mjs` を read-only で束ねる）を node_modules の Electron で、閉じ込めなし。
 *              DoH の canary（名前の試みの観測）、net log、UDP 5353 の受信 socket。(34) の正の対照と行の区分の対照
 *   toolcheck: 同じ probe の main に製品の NC-1 の orchestrator（`cm.nc1 = {}`）。Main の listener の実数と net log の接続数を照合する
 *   packaged : `electron-builder --dir` の実行体。与えるのは一時の userData（`GRIMODEX_USER_DATA_DIR`）・HOME・TMPDIR と Chromium の
 *              switch（`--remote-debugging-port`、`--log-net-log`、`--net-log-capture-mode=Everything`）だけ。攻撃 JS
 *              （`webrtc-block-probe-renderer.js`。read-only）は CDP の `Runtime.evaluate` で `app://bundle` の窓に注入する
 * 出力: `<out-dir>/<os>/{baseline,toolcheck,packaged,package-check,verdict}.json`、`verdict.txt`、`SHA256SUMS`。記録は nonce を `<n>`、
 * LAN の IPv4 を `<lan>`、hostname を `<host>` に伏せる。raw の net log は出力に置かない（SHA-256 と派生の要約だけ。DR-CP2B-P2-7）。
 * 終了コード: 0 合格、1 不合格、3 観測の道具なし（その OS は (34) 不通過）、2 使い方の誤り。
 *
 * 子 process の起動と終了は `process-tree.mjs`（kill の要求を終了の証拠にしない。cp2b-decisions §8.4）。Linux は
 * `scripts/local-ci-xvfb.mjs` を host の namespace で前に置く（`unshare` を使わない）。製品・NC-1・Y-1 の file は変えない。
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import esbuild from "esbuild";

import { connectCdp, evaluate, waitForTarget } from "./cdp.mjs";
import { connectsInWindow, parseNetLog, sha256, summarizeNetLog } from "./netlog.mjs";
import { freePort, lanAddress, startCanary, startCtlSocket, startDohCanary, startHttp, startMdnsObserver } from "./observers.mjs";
import { checkPackage } from "./package-check.mjs";
import { launchOwned, terminateOwned } from "./process-tree.mjs";
import { CONFIGS, MATRIX_FLAGS, formatVerdict, judgeOs } from "./verdict.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const scriptsDir = path.resolve(here, "..");
const root = path.resolve(here, "..", "..", "..");
const RENDERER_SCRIPT = path.join(scriptsDir, "webrtc-block-probe-renderer.js");
const PROBE_MAIN = path.join(scriptsDir, "webrtc-block-probe-main.mjs");
const XVFB_WRAPPER = path.join(root, "scripts", "local-ci-xvfb.mjs");

const LIMITS = Object.freeze({ targetMs: 120_000, pageReadyMs: 60_000, rendererMs: 15 * 60_000, probeMainMs: 20 * 60_000 });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * packaged の窓でだけ攻撃 JS の前に評価する shim（DR-CP2B-P2-5）。製品の window open の handler は http/https を
 * `shell.openExternal` で OS に渡すので、`dns.form-submit`（target=_blank の form）は OS の browser を起こす。probe の main の
 * handler（deny だけ。G-open の行列の環境）と同じ「何も送らない」にそろえる。他の API は変えない。
 */
export const FORM_SUBMIT_SHIM = `(() => {
  const original = HTMLFormElement.prototype.submit;
  HTMLFormElement.prototype.submit = function () {
    const target = String(this.target || "");
    if (target !== "" && target !== "_self") return undefined;
    return original.call(this);
  };
  return "form-submit-shim";
})()`;
export const FORM_SUBMIT_SHIM_NOTE = "HTMLFormElement.prototype.submit: target が空でも _self でもない form は送らない（製品の openExternal を起こさず、probe の main の deny と同じ結果にそろえる。DR-CP2B-P2-5）";

/**
 * 一時の userData に置く初期状態（DR-CP2B-P2-10）。旧版の keyring の移行の完了 marker だけ。製品は空の userData で起動すると
 * OS の keyring（Linux は D-Bus の Secret Service、macOS は Keychain、Windows は Credential Manager）を読み、失敗すると窓の作成の前に
 * modal の dialog で止まる（`index.ts` の移行の失敗の分岐）。marker は製品自身が移行の完了時に書く形（`credentialMigration.ts` の
 * `writeMarker`。version 1）と同じで、「移行を済ませた利用者」の状態にする。利用者の keyring を読まない副作用もある。
 */
export const LEGACY_KEYRING_MARKER_FILE = "legacy-keyring-migration-v1.json";
export function seedUserData(userData, now = new Date()) {
  const marker = { version: 1, completedAt: now.toISOString(), imported: 0, skippedExisting: 0 };
  fs.writeFileSync(path.join(userData, LEGACY_KEYRING_MARKER_FILE), JSON.stringify(marker, null, 2), { mode: 0o600 });
  return [`${LEGACY_KEYRING_MARKER_FILE}（旧版の keyring の移行の完了 marker。version 1、imported 0）`];
}

export function parseArgs(argv) {
  const args = { outDir: "", app: "", exe: "", os: "", configs: [...CONFIGS], dnsLog: "", keep: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--out-dir") args.outDir = path.resolve(argv[++index]);
    else if (arg === "--app") args.app = path.resolve(argv[++index]);
    else if (arg === "--exe") args.exe = path.resolve(argv[++index]);
    else if (arg === "--os") args.os = argv[++index];
    else if (arg === "--configs") args.configs = argv[++index].split(",").filter(Boolean);
    else if (arg === "--dns-log") args.dnsLog = path.resolve(argv[++index]);
    else if (arg === "--keep") args.keep = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!args.outDir) throw new Error("--out-dir が要る");
  for (const config of args.configs) if (!CONFIGS.includes(config)) throw new Error(`unknown config: ${config}`);
  return args;
}

/** `electron-builder --dir` の出力（既定の置き場）と、その実行体 */
export function resolvePackagedApp({ app, exe }, platform = process.platform, releaseDir = path.join(root, "release", "electron")) {
  let appDir = app;
  if (!appDir) {
    const candidates = platform === "win32" ? ["win-unpacked"]
      : platform === "darwin" ? ["mac-arm64/Grimodex.app", "mac/Grimodex.app", "mac-universal/Grimodex.app"]
        : ["linux-unpacked"];
    appDir = candidates.map((candidate) => path.join(releaseDir, candidate)).find((candidate) => fs.existsSync(candidate)) ?? "";
  }
  if (!appDir || !fs.existsSync(appDir)) throw new Error(`packaged の出力が見つからない: ${appDir || releaseDir}`);
  const executable = exe || (platform === "win32" ? path.join(appDir, "Grimodex.exe")
    : platform === "darwin" ? path.join(appDir, "Contents", "MacOS", "Grimodex")
      : path.join(appDir, "grimodex"));
  if (!fs.existsSync(executable)) throw new Error(`packaged の実行体が見つからない: ${executable}`);
  return { appDir, executable };
}

function electronDist() {
  const electronDir = path.dirname(fileURLToPath(import.meta.resolve("electron/package.json")));
  const relative = fs.readFileSync(path.join(electronDir, "path.txt"), "utf8").trim();
  return { distDir: path.join(electronDir, "dist"), binary: path.join(electronDir, "dist", relative) };
}

/** 子の env: desktop の session・env の proxy・Grimodex の既存の env を外し、一時の HOME／XDG／TMPDIR を与える */
export function childEnv(base, { home, tmp, platform = process.platform, extra = {} }) {
  const env = { ...base };
  for (const key of Object.keys(env)) {
    if (/^(WAYLAND_DISPLAY|WAYLAND_SOCKET|XDG_SESSION_TYPE|DBUS_SESSION_BUS_ADDRESS|ELECTRON_RENDERER_URL|ELECTRON_RUN_AS_NODE|NODE_OPTIONS)$/.test(key)
      || /^(http|https|all|no|ftp)_proxy$/i.test(key)
      || /^GRIMODEX_/.test(key)
      || /^PROBE_/.test(key)
      || key === "LD_PRELOAD") {
      delete env[key];
    }
  }
  if (platform !== "win32") {
    env.HOME = home;
    env.XDG_CONFIG_HOME = path.join(home, ".config");
    env.XDG_DATA_HOME = path.join(home, ".local", "share");
    env.XDG_CACHE_HOME = path.join(home, ".cache");
    env.XDG_STATE_HOME = path.join(home, ".local", "state");
    env.TMPDIR = tmp;
  }
  if (platform === "linux") env.ELECTRON_OZONE_PLATFORM_HINT = "x11";
  return Object.assign(env, extra);
}

async function buildProbeBundles(work) {
  const bundle = path.join(work, "bundle");
  const dist = path.join(work, "dist");
  fs.mkdirSync(path.join(dist, "assets"), { recursive: true });
  fs.mkdirSync(bundle, { recursive: true });
  const common = { bundle: true, platform: "node", format: "cjs", target: "node22", external: ["electron", "*.node"], logLevel: "error" };
  await Promise.all([
    esbuild.build({ ...common, entryPoints: [PROBE_MAIN], outfile: path.join(bundle, "main.cjs") }),
    esbuild.build({ ...common, entryPoints: [path.join(root, "electron", "preload", "index.ts")], outfile: path.join(bundle, "preload.cjs") }),
  ]);
  fs.writeFileSync(path.join(bundle, "package.json"), JSON.stringify({ name: "probe", version: "0.0.1", main: "main.cjs" }));
  // probe の runner（webrtc-block-probe.mjs の buildBundles）と同じ app:// の中身
  fs.writeFileSync(path.join(dist, "index.html"), "<!doctype html><html><head><meta charset=utf-8><title>Grimodex</title></head><body><p>probe</p></body></html>");
  fs.writeFileSync(path.join(dist, "assets", "data.json"), "{}");
  fs.writeFileSync(path.join(dist, "assets", "app.js"), "// no-op");
  fs.writeFileSync(path.join(dist, "assets", "probe-worker.js"), "self.onmessage = (e) => self.postMessage('worker-ok:' + e.data);");
  return { bundle, dist };
}

function wrapForPlatform(command, args, platform) {
  return platform === "linux"
    ? { command: process.execPath, args: [XVFB_WRAPPER, command, ...args] }
    : { command, args };
}

function probeArgsFor({ nonce, ports, lan }) {
  // probe の main の probeArgs と同じ形（webrtc-block-probe-main.mjs）。flag は MATRIX_FLAGS だけ
  return {
    nonce, ports, lan, quick: false, dns: !!MATRIX_FLAGS.dns, gvt1: false, localhost: !!MATRIX_FLAGS.localhostRows,
    sentinel: false, rs1: !!MATRIX_FLAGS.rs1, linklocal: false, fqdn: false, secx: false, local: !!MATRIX_FLAGS.local,
    churn: false, persist: "",
  };
}

function readDnsLog(file, nonce) {
  if (!file || !fs.existsSync(file)) return null;
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => {
    const [at, , name, , rc] = line.split("\t");
    return { at: Number(at), name: String(name).split(nonce).join("<n>"), rc: Number(rc) };
  });
}

/** 行に canary・LS-1・DoH・mDNS・getaddrinfo を帰属させ、probe と同じ形の記録にする */
export function attributeRows({ results, canaries, connectTimes, listenerHits, dohQueries, mdnsPackets, dnsEvents, httpHits, nonce }) {
  const owned = new Set();
  const all = canaries.flatMap((canary) => canary.hits);
  const rows = results.filter((result) => result.startedAt).map((result) => {
    const direct = all.filter((hit) => hit.at >= result.startedAt && hit.at <= result.endedAt);
    direct.forEach((hit) => owned.add(hit));
    const leakDetail = {};
    for (const hit of direct) leakDetail[`${hit.label}:${hit.proto}`] = (leakDetail[`${hit.label}:${hit.proto}`] ?? 0) + 1;
    const row = { id: result.id, outcome: result.outcome, leaked: direct.length, leakDetail };
    const proxiedNetLog = connectTimes ? connectsInWindow(connectTimes, result) : 0;
    if (listenerHits) {
      row.proxiedListener = listenerHits.filter((at) => at >= result.startedAt && at <= result.endedAt).length;
      row.proxiedNetLog = proxiedNetLog;
      row.proxied = row.proxiedListener;
    } else {
      row.proxied = proxiedNetLog;
    }
    if (httpHits) row.httpHits = httpHits.filter((hit) => hit.at >= result.startedAt && hit.at <= result.endedAt).length;
    if (dohQueries) {
      row.dohNames = [...new Set(dohQueries.filter((query) => query.at >= result.startedAt - 50 && query.at <= result.endedAt + 50)
        .map((query) => `${query.name.split(nonce).join("<n>")}/${query.qtype}`))];
    }
    if (mdnsPackets) row.mdnsQueries = mdnsPackets.filter((packet) => packet.at >= result.startedAt - 50 && packet.at <= result.endedAt + 50).length;
    if (dnsEvents) {
      const names = dnsEvents.filter((event) => event.at >= result.startedAt - 50 && event.at <= result.endedAt + 50);
      row.dnsNames = [...new Set(names.map((event) => `${event.name}${event.rc === 0 ? "[rc0]" : ""}`))];
    }
    return row;
  });
  const unattributed = all.filter((hit) => !owned.has(hit));
  return {
    rows,
    totals: {
      leakedProbes: rows.filter((row) => row.leaked > 0).length,
      probes: rows.length,
      canaryHits: all.length,
      unattributed: unattributed.length,
      proxyHits: rows.reduce((sum, row) => sum + (row.proxied ?? 0), 0),
      mdnsQueries: mdnsPackets ? mdnsPackets.length : null,
    },
    unattributedLabels: unattributed.map((hit) => `${hit.label}:${hit.proto}`),
  };
}

/** 記録の text から nonce、LAN の IPv4、hostname を伏せる（probe と同じ表記） */
export function maskRecordText(text, { nonce, lan, hostname }) {
  let out = text.split(nonce).join("<n>");
  if (lan) out = out.split(lan).join("<lan>");
  if (hostname) out = out.split(hostname).join("<host>");
  return out;
}

async function startObservers({ nonce, lan, withDoh, work }) {
  const canaries = [
    await startCanary("p-127.0.0.1", "127.0.0.1"),
    await startCanary("q-127.0.0.1-other", "127.0.0.1"),
    await startCanary("r-127.0.0.2", "127.0.0.2"),
    await startCanary("s-[::1]", "::1", { v6: true }),
    ...(lan ? [await startCanary("t-lan", lan)] : []),
  ];
  for (const canary of canaries.slice(0, 2)) if (!canary.bound) throw new Error(`canary ${canary.label} を 127.0.0.1 に bind できない（${canary.error}）`);
  const portOf = async (canary) => (canary?.bound ? canary.port : await freePort());
  const httpd = await startHttp();
  const ctl = await startCtlSocket();
  let doh = null;
  let dohError = null;
  if (withDoh) {
    try { doh = await startDohCanary(work); } catch (error) { dohError = String(error?.message ?? error).slice(0, 200); }
  }
  const mdns = await startMdnsObserver(nonce, lan);
  const ports = {
    p: canaries[0].port, q: canaries[1].port, r: await portOf(canaries[2]), s: await portOf(canaries[3]),
    t: lan ? await portOf(canaries[4]) : 1, proxy: await freePort(), http: httpd.port, doh: doh?.port ?? 0, fake: 0, ctl: ctl.port,
  };
  return {
    canaries, httpd, ctl, doh, dohError, mdns, ports,
    close: async () => {
      await Promise.all([...canaries.map((canary) => canary.close()), httpd.close(), ctl.close(), mdns.close(), ...(doh ? [doh.close()] : [])]);
    },
  };
}

function readNetLogSummary(file, nonce) {
  if (!fs.existsSync(file)) return { summary: { error: "net log の file がない" }, connectTimes: [] };
  const text = fs.readFileSync(file, "utf8");
  try {
    const { _connectTimes, _hostTimes, ...summary } = summarizeNetLog(parseNetLog(text), { nonce });
    void _hostTimes;
    return { summary: { ...summary, rawSha256: sha256(text), rawBytes: Buffer.byteLength(text), error: null }, connectTimes: _connectTimes };
  } catch (error) {
    return { summary: { error: String(error?.message ?? error).slice(0, 200), rawSha256: sha256(text) }, connectTimes: [] };
  }
}

/** 候補の head（記録は head に束縛される。GDX-TRACE-001）と、追跡中の file の変更の有無 */
function candidateFacts() {
  const git = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] }).trim();
  try {
    return { head: git(["rev-parse", "HEAD"]), trackedDirty: git(["status", "--porcelain", "--untracked-files=no"]).length > 0 };
  } catch {
    return { head: null, trackedDirty: null };
  }
}

function environmentFacts() {
  return {
    candidate: candidateFacts(),
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    node: process.version,
    runner: { os: process.env.RUNNER_OS ?? null, image: process.env.ImageOS ?? null, imageVersion: process.env.ImageVersion ?? null },
    loadavg: os.loadavg().map((value) => Math.round(value * 100) / 100),
    at: new Date().toISOString(),
  };
}

/** probe の main を node_modules の Electron で走らせる（baseline／toolcheck） */
async function runProbeMain({ config, work, bundles, observers, nonce, lan, args, platform }) {
  const { distDir, binary } = electronDist();
  const cfg = {
    userData: path.join(work, "userData"),
    distRoot: bundles.dist,
    resultPath: path.join(work, "result.json"),
    nonce,
    hostname: os.hostname(),
    lan: lan ?? "192.0.2.1",
    ports: observers.ports,
  };
  fs.mkdirSync(cfg.userData, { recursive: true });
  const cm = config === "baseline" ? { ...MATRIX_FLAGS, doh: true } : { ...MATRIX_FLAGS, nc1: {} };
  const netLog = path.join(work, "netlog.json");
  const home = path.join(work, "home");
  const tmp = path.join(work, "tmp");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(tmp, { recursive: true });
  const dnsLogFile = platform === "linux" && args.dnsLog ? path.join(work, "dns.log") : "";
  const env = childEnv(process.env, {
    home, tmp, platform,
    extra: {
      PROBE_CM: JSON.stringify(cm), PROBE_CFG: JSON.stringify(cfg), PROBE_RENDERER_SCRIPT: RENDERER_SCRIPT,
      ...(dnsLogFile ? { LD_PRELOAD: args.dnsLog, PROBE_DNSLOG: dnsLogFile } : {}),
    },
  });
  const launch = wrapForPlatform(binary, [`--log-net-log=${netLog}`, "--net-log-capture-mode=Everything", path.join(bundles.bundle, "main.cjs")], platform);
  const owner = launchOwned({ ...launch, env, cwd: work, exeDir: distDir, label: config, platform });
  const closedInTime = await Promise.race([owner.exited.then(() => true), sleep(LIMITS.probeMainMs).then(() => false)]);
  const lifecycle = await terminateOwned(owner);
  const result = fs.existsSync(cfg.resultPath) ? JSON.parse(fs.readFileSync(cfg.resultPath, "utf8")) : null;
  if (!result || result.fatal) {
    return { fatal: result?.fatal ?? `probe の main の結果がない（closedInTime=${closedInTime}、${JSON.stringify(owner.closed())}）`, lifecycle, output: owner.output().slice(-2000), cm };
  }
  const { summary, connectTimes } = readNetLogSummary(netLog, nonce);
  const results = [...result.rendererResults, ...result.mainSide];
  const attributed = attributeRows({
    results,
    canaries: observers.canaries,
    connectTimes: summary.ls1Port != null ? connectTimes : null,
    listenerHits: config === "toolcheck" ? (result.nc1?.listenerHits ?? []) : null,
    dohQueries: observers.doh ? observers.doh.queries : null,
    mdnsPackets: observers.mdns.packets,
    dnsEvents: readDnsLog(dnsLogFile, nonce),
    httpHits: observers.httpd.hits,
    nonce,
  });
  return {
    cm,
    electron: result.electron,
    chrome: result.chrome,
    events: result.events,
    rendererRowIds: result.rendererResults.filter((row) => row.startedAt).map((row) => row.id),
    ...attributed,
    netLog: summary,
    nc1: result.nc1 ? {
      startOk: result.nc1.startOk, startMs: result.nc1.startMs, listenerPort: result.nc1.listenerPort,
      listenerHits: result.nc1.listenerHits.length, failures: result.nc1.failures, uncaught: result.nc1.uncaught.length,
    } : null,
    dohAll: observers.doh ? [...new Set(observers.doh.queries.map((query) => query.name.split(nonce).join("<n>")))] : null,
    dohQueryCount: observers.doh ? observers.doh.queries.length : null,
    dnsAll: dnsLogFile ? [...new Set((readDnsLog(dnsLogFile, nonce) ?? []).map((event) => `${event.name}${event.rc === 0 ? "[rc0]" : ""}`))] : null,
    lifecycle,
    exit: owner.closed(),
    outputTail: owner.output().slice(-600),
  };
}

/** packaged の実行体を走らせ、CDP で攻撃 JS を注入する */
async function runPackaged({ work, observers, nonce, lan, args, platform, packagedApp }) {
  const cdpPort = await freePort();
  const netLog = path.join(work, "netlog.json");
  const home = path.join(work, "home");
  const tmp = path.join(work, "tmp");
  const userData = path.join(work, "userData");
  for (const dir of [home, tmp, userData]) fs.mkdirSync(dir, { recursive: true });
  const userDataSeed = seedUserData(userData);
  const dnsLogFile = platform === "linux" && args.dnsLog ? path.join(work, "dns.log") : "";
  const env = childEnv(process.env, {
    home, tmp, platform,
    extra: { GRIMODEX_USER_DATA_DIR: userData, ...(dnsLogFile ? { LD_PRELOAD: args.dnsLog, PROBE_DNSLOG: dnsLogFile } : {}) },
  });
  const appArgs = [`--remote-debugging-port=${cdpPort}`, `--log-net-log=${netLog}`, "--net-log-capture-mode=Everything"];
  const launch = wrapForPlatform(packagedApp.executable, appArgs, platform);
  const owner = launchOwned({ ...launch, env, cwd: work, exeDir: packagedApp.appDir, label: "packaged", platform });
  const cdp = { port: cdpPort, injected: false, launchToTargetMs: null, error: null, version: null };
  const pageShims = [];
  let rendererResults = [];
  let session = null;
  try {
    const { target, waitedMs } = await waitForTarget(cdpPort, { timeoutMs: LIMITS.targetMs, isAlive: owner.isAlive });
    cdp.launchToTargetMs = waitedMs;
    cdp.targetUrl = String(target.url).split("?")[0];
    try {
      const response = await fetch(`http://127.0.0.1:${cdpPort}/json/version`);
      const version = await response.json();
      cdp.version = { browser: version.Browser ?? null, userAgent: version["User-Agent"] ?? null };
    } catch { /* 記録だけ */ }
    session = await connectCdp(target.webSocketDebuggerUrl);
    const readyStarted = Date.now();
    while (await evaluate(session, "document.readyState", { timeoutMs: 10_000 }) !== "complete") {
      if (Date.now() - readyStarted > LIMITS.pageReadyMs) throw new Error("document.readyState が complete にならない");
      await sleep(250);
    }
    if (await evaluate(session, FORM_SUBMIT_SHIM, { timeoutMs: 10_000 }) === "form-submit-shim") pageShims.push(FORM_SUBMIT_SHIM_NOTE);
    await evaluate(session, `globalThis.__probe = ${JSON.stringify(probeArgsFor({ nonce, ports: observers.ports, lan: lan ?? "192.0.2.1" }))}; true`, { timeoutMs: 10_000 });
    const script = fs.readFileSync(RENDERER_SCRIPT, "utf8");
    const value = await evaluate(session, script, { timeoutMs: LIMITS.rendererMs });
    if (!Array.isArray(value)) throw new Error(`攻撃 JS の結果が配列でない: ${typeof value}`);
    rendererResults = value;
    cdp.injected = rendererResults.length > 0;
  } catch (error) {
    cdp.error = String(error?.message ?? error).slice(0, 300);
  } finally {
    if (session) await session.close();
  }
  const lifecycle = await terminateOwned(owner);
  const { summary, connectTimes } = readNetLogSummary(netLog, nonce);
  const attributed = attributeRows({
    results: rendererResults,
    canaries: observers.canaries,
    connectTimes: summary.ls1Port != null ? connectTimes : null,
    listenerHits: null,
    dohQueries: null,
    mdnsPackets: observers.mdns.packets,
    dnsEvents: readDnsLog(dnsLogFile, nonce),
    httpHits: null,
    nonce,
  });
  let dictionariesOnDisk = null;
  try { dictionariesOnDisk = fs.readdirSync(path.join(userData, "Dictionaries")); } catch { dictionariesOnDisk = []; }
  return {
    executable: path.relative(path.dirname(packagedApp.appDir), packagedApp.executable).split(path.sep).join("/"),
    userDataSeed,
    cdp,
    pageShims,
    rendererRowIds: rendererResults.filter((row) => row.startedAt).map((row) => row.id),
    ...attributed,
    netLog: summary,
    dnsAll: dnsLogFile ? [...new Set((readDnsLog(dnsLogFile, nonce) ?? []).map((event) => `${event.name}${event.rc === 0 ? "[rc0]" : ""}`))] : null,
    dictionariesOnDisk,
    osDialogs: { observed: false, reason: "harness は UI を観測しない（headless の runner。記録だけで合否にしない）" },
    lifecycle,
    exit: owner.closed(),
    outputTail: owner.output().slice(-600),
  };
}

async function runConfig(config, context) {
  const nonce = randomBytes(3).toString("hex");
  const work = fs.mkdtempSync(path.join(context.tmpRoot, `${config.slice(0, 2)}-`));
  const observers = await startObservers({ nonce, lan: context.lan, withDoh: config === "baseline", work });
  let record;
  try {
    const body = config === "packaged"
      ? await runPackaged({ work, observers, nonce, lan: context.lan, args: context.args, platform: context.platform, packagedApp: context.packagedApp })
      : await runProbeMain({ config, work, bundles: context.bundles, observers, nonce, lan: context.lan, args: context.args, platform: context.platform });
    record = {
      label: `${context.osLabel}-${config}`,
      config,
      matrixFlags: { ...MATRIX_FLAGS },
      environment: environmentFacts(),
      canaries: observers.canaries.map((canary) => ({ label: canary.label, bound: canary.bound, error: canary.error })),
      doh: config === "baseline" ? { started: observers.doh != null, error: observers.dohError } : null,
      mdns: { ...observers.mdns.state, seenAll: observers.mdns.seenAll(), nonceBearing: observers.mdns.packets.length },
      ...body,
    };
  } finally {
    await observers.close();
    if (!context.args.keep) fs.rmSync(work, { recursive: true, force: true });
  }
  // raw の net log の SHA-256 は伏せ字の置換の外に置く（16 進の nonce が digest の中に現れうる）
  const rawSha256 = record.netLog?.rawSha256 ?? null;
  const masked = JSON.parse(maskRecordText(JSON.stringify(record, null, 2), { nonce, lan: context.lan, hostname: os.hostname() }));
  if (masked.netLog && rawSha256) masked.netLog.rawSha256 = rawSha256;
  return masked;
}

function writeSha256Sums(dir) {
  const files = fs.readdirSync(dir).filter((name) => name !== "SHA256SUMS").sort();
  const lines = files.map((name) => `${sha256(fs.readFileSync(path.join(dir, name)))}  ${name}`);
  fs.writeFileSync(path.join(dir, "SHA256SUMS"), lines.join("\n") + "\n");
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const platform = process.platform;
  const osLabel = args.os || { linux: "linux", win32: "windows", darwin: "mac" }[platform] || platform;
  const outDir = path.join(args.outDir, osLabel);
  fs.mkdirSync(outDir, { recursive: true });
  const packagedApp = args.configs.includes("packaged") ? resolvePackagedApp(args, platform) : null;
  // TMPDIR は短い path（長い path は Chromium の SingletonSocket が落ちる）。呼出し側が短い TMPDIR を渡す
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gps-"));
  const context = { args, platform, osLabel, packagedApp, tmpRoot, lan: lanAddress(), bundles: null };
  let interrupted = false;
  const onSignal = () => { interrupted = true; };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    if (args.configs.some((config) => config !== "packaged")) context.bundles = await buildProbeBundles(fs.mkdtempSync(path.join(tmpRoot, "b-")));
    for (const config of args.configs) {
      if (interrupted) throw new Error("中断された");
      console.log(`[packaged-smoke] ${osLabel}: ${config} を開始`);
      const record = await runConfig(config, context);
      fs.writeFileSync(path.join(outDir, `${config}.json`), JSON.stringify(record, null, 2) + "\n");
      console.log(`[packaged-smoke] ${osLabel}: ${config} 行 ${record.rows?.length ?? 0}、終了の証拠 ${record.lifecycle?.ok}${record.fatal ? `、失敗 ${String(record.fatal).slice(0, 200)}` : ""}${record.cdp?.error ? `、CDP ${record.cdp.error}` : ""}`);
      // 前の構成の終了の証拠が取れなければ、次を起動しない（§8.4 の admission closure）
      if (record.lifecycle?.ok !== true) {
        console.error(`[packaged-smoke] ${config} の子 process の終了を確かめられない: ${JSON.stringify(record.lifecycle)}`);
        break;
      }
    }
    if (packagedApp) {
      const packageCheck = await checkPackage({ appDir: packagedApp.appDir, platform });
      fs.writeFileSync(path.join(outDir, "package-check.json"), JSON.stringify(packageCheck, null, 2) + "\n");
    }
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    if (!args.keep) fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
  const read = (name) => (fs.existsSync(path.join(outDir, `${name}.json`)) ? JSON.parse(fs.readFileSync(path.join(outDir, `${name}.json`), "utf8")) : null);
  const verdict = judgeOs({ baseline: read("baseline"), toolcheck: read("toolcheck"), packaged: read("packaged"), packageCheck: read("package-check") });
  fs.writeFileSync(path.join(outDir, "verdict.json"), JSON.stringify(verdict, null, 2) + "\n");
  const text = formatVerdict(osLabel, verdict);
  fs.writeFileSync(path.join(outDir, "verdict.txt"), text + "\n");
  writeSha256Sums(outDir);
  console.log(text);
  return verdict.status === "pass" ? 0 : verdict.status === "no-observation-tool" ? 3 : 1;
}

const invokedDirectly = Boolean(process.argv[1])
  && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (invokedDirectly) {
  main().then((code) => { process.exitCode = code; }, (error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 2;
  });
}
