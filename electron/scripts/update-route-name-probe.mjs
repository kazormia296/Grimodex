#!/usr/bin/env node
/**
 * H1 (b)（CP-2b P3）: RS-1 の外の名前へ redirect された更新の要求が、製品の NC-1 の規則の
 * 下で electron-updater 方式の `net.request` の `net::ERR_NAME_NOT_RESOLVED` になることを、
 * 実 Electron（Linux、非 packaged）で確かめるローカルの道具。CI には載せない（H3 は非目標）。
 *
 * - `update-route-name-probe-main.mjs` を esbuild で束ね、`scripts/local-ci-xvfb.mjs` を
 *   host の namespace で使って 2 回起動する（`product` と `mapped-control`）。
 * - 起動の規則（electron-spike-isolation）: `WAYLAND_DISPLAY`／`WAYLAND_SOCKET`／
 *   `XDG_SESSION_TYPE`／`DBUS_SESSION_BUS_ADDRESS` と env の proxy を除き、一時の
 *   `HOME`／`XDG_*` を使う。Electron は独立の process group で、上限の後に group の
 *   PID を指定して止める。終われば一時 dir を消す。
 * - 要求先は loopback の模擬 server だけ。Chromium の他の通信（辞書など）は起きうるので
 *   「外部網なし」は主張しない。
 *
 * 使い方: `TMPDIR=/tmp/<短い dir> node electron/scripts/update-route-name-probe.mjs`
 * 判断の記録: `docs/plans/nir1-lane-decisions/cp2b-decisions.md` の DR-CP2B-P3-6。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const RUN_TIMEOUT_MS = 90_000;
const NAME_NOT_RESOLVED = "net::ERR_NAME_NOT_RESOLVED";
const CASE_IDS = [
  "request.loopback",
  "request.outside",
  "download.loopback",
  "download.outside",
];

/**
 * 2 回の起動の記録から合否を決める。どの期待にも反しなければ `failures` は空。
 * - product: containment の起動が成功し、loopback への redirect は 200 に届き、RS-1 外の
 *   名前への redirect は確認・取得の両方で `ERR_NAME_NOT_RESOLVED`。その名前の要求は
 *   server に届かず、updater の session の名前解決も失敗する。
 * - mapped-control: 同じ名前を loopback へ写すと同じ要求が 200 に届き、server がその名前の
 *   Host で受ける（失敗の原因が名前解決の規則であることの対照）。
 */
export function judgeUpdateRouteProbe(product, control) {
  const failures = [];
  const caseOf = (record, id) =>
    record?.cases?.find((entry) => entry.id === id);
  const expectOk = (record, id) => {
    const entry = caseOf(record, id);
    if (entry?.outcome !== "ok" || entry.value !== "final") {
      failures.push(
        `${record?.mode ?? "?"}: ${id} did not reach the final 200`,
      );
    }
  };
  const outsideHits = (record) =>
    (record?.serverHits ?? []).filter((hit) =>
      String(hit.host).startsWith("github-releases.githubusercontent.com"),
    ).length;

  if (product?.mode !== "product") failures.push("product: record missing");
  if (control?.mode !== "mapped-control") {
    failures.push("mapped-control: record missing");
  }
  for (const record of [product, control]) {
    const ids = (record?.cases ?? []).map((entry) => entry.id);
    if (JSON.stringify(ids) !== JSON.stringify(CASE_IDS)) {
      failures.push(
        `${record?.mode ?? "?"}: unexpected case set ${ids.join(",")}`,
      );
    }
  }

  if (product?.containmentStarted !== true) {
    failures.push("product: renderer containment did not start");
  }
  expectOk(product, "request.loopback");
  expectOk(product, "download.loopback");
  for (const id of ["request.outside", "download.outside"]) {
    const entry = caseOf(product, id);
    if (
      entry?.outcome !== "error" ||
      !entry.message.includes(NAME_NOT_RESOLVED)
    ) {
      failures.push(`product: ${id} did not fail with ${NAME_NOT_RESOLVED}`);
    }
  }
  if (outsideHits(product) !== 0) {
    failures.push("product: the outside name reached the server");
  }
  if (
    product?.resolveHost?.outcome !== "error" ||
    !product.resolveHost.message.includes("ERR_NAME_NOT_RESOLVED")
  ) {
    failures.push("product: the updater session resolved the outside name");
  }

  for (const id of CASE_IDS) expectOk(control, id);
  if (outsideHits(control) < 2) {
    failures.push("mapped-control: the outside name did not reach the server");
  }
  if (
    control?.resolveHost?.outcome !== "ok" ||
    !control.resolveHost.addresses?.includes("127.0.0.1")
  ) {
    failures.push(
      "mapped-control: the mapped name did not resolve to loopback",
    );
  }
  return { pass: failures.length === 0, failures };
}

function electronBinary() {
  const electronDir = path.dirname(
    fileURLToPath(import.meta.resolve("electron/package.json")),
  );
  const rel = fs
    .readFileSync(path.join(electronDir, "path.txt"), "utf8")
    .trim();
  return path.join(electronDir, "dist", rel);
}

async function bundle(work) {
  const { build } = await import("esbuild");
  const dir = path.join(work, "app");
  fs.mkdirSync(dir, { recursive: true });
  await build({
    entryPoints: [path.join(here, "update-route-name-probe-main.mjs")],
    outfile: path.join(dir, "main.cjs"),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    external: ["electron"],
    logLevel: "silent",
  });
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({
      name: "update-route-name-probe",
      version: "0.0.1",
      main: "main.cjs",
    }),
  );
  return dir;
}

function isolatedEnv(work, mode) {
  const env = { ...process.env };
  for (const key of [
    "WAYLAND_DISPLAY",
    "WAYLAND_SOCKET",
    "XDG_SESSION_TYPE",
    "DBUS_SESSION_BUS_ADDRESS",
    "ELECTRON_RENDERER_URL",
    "ELECTRON_RUN_AS_NODE",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "no_proxy",
  ]) {
    delete env[key];
  }
  const home = path.join(work, `home-${mode}`);
  for (const sub of ["config", "data", "cache", "state"]) {
    fs.mkdirSync(path.join(home, sub), { recursive: true });
  }
  Object.assign(env, {
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, "config"),
    XDG_DATA_HOME: path.join(home, "data"),
    XDG_CACHE_HOME: path.join(home, "cache"),
    XDG_STATE_HOME: path.join(home, "state"),
    ELECTRON_OZONE_PLATFORM_HINT: "x11",
    PROBE_MODE: mode,
    PROBE_WORK: path.join(work, `run-${mode}`),
    PROBE_RESULT: path.join(work, `result-${mode}.json`),
  });
  fs.mkdirSync(env.PROBE_WORK, { recursive: true });
  return env;
}

/** group の中に残っている process の PID（`/proc/<pid>/stat` の pgrp で数える）。 */
function processesInGroup(pgid) {
  const left = [];
  for (const entry of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${entry}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (Number(fields[2]) === pgid) left.push(Number(entry));
    } catch {
      // 読む間に終わった。
    }
  }
  return left;
}

/** 実行中の子と一時 dir。signal の handler が片付けに使う。 */
const active = { child: null, work: null, stopping: false };

/**
 * SIGINT／SIGTERM で、実行中の子の process group（`-child.pid`）に SIGTERM を送り、
 * `close` を上限まで待ってから SIGKILL を送り、一時 dir を消して終了する。
 * wrapper（`local-ci-xvfb.mjs`）は SIGTERM で Xvfb を片付けるので、先に SIGTERM を送る。
 */
export function createSignalCleanup(
  state,
  {
    kill = (pid, signal) => process.kill(pid, signal),
    remove = (dir) => fs.rmSync(dir, { recursive: true, force: true }),
    exit = (code) => process.exit(code),
    graceMs = 5000,
  } = {},
) {
  let entered = false;
  return async (signal) => {
    if (entered) return;
    entered = true;
    // 以後の起動を止める（待つ間に次の起動が始まらないようにする）。
    state.stopping = true;
    const child = state.child;
    const killGroup = (target, name) => {
      try {
        kill(-target.pid, name);
      } catch {
        // すでに終了している。
      }
    };
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      const closed = new Promise((resolve) => child.once("close", resolve));
      killGroup(child, "SIGTERM");
      let timer;
      await Promise.race([
        closed,
        new Promise((resolve) => (timer = setTimeout(resolve, graceMs))),
      ]);
      clearTimeout(timer);
    }
    for (const target of new Set([child, state.child])) {
      if (target?.pid) killGroup(target, "SIGKILL");
    }
    if (state.work) remove(state.work);
    exit(signal === "SIGINT" ? 130 : 143);
  };
}

function runElectron(appDir, work, mode) {
  const env = isolatedEnv(work, mode);
  const wrapper = path.join(root, "scripts", "local-ci-xvfb.mjs");
  if (active.stopping) throw new Error("stopping on a signal");
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [wrapper, electronBinary(), "--no-sandbox", appDir],
      { env, stdio: ["ignore", "pipe", "pipe"], detached: true },
    );
    active.child = child;
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    const killGroup = (signal) => {
      try {
        process.kill(-child.pid, signal);
      } catch {
        // すでに終了している。
      }
    };
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup("SIGTERM");
      setTimeout(() => killGroup("SIGKILL"), 5000).unref();
    }, RUN_TIMEOUT_MS);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (active.child === child) active.child = null;
      let left = processesInGroup(child.pid);
      if (left.length) {
        killGroup("SIGKILL");
        left = processesInGroup(child.pid);
      }
      let record = null;
      try {
        record = JSON.parse(fs.readFileSync(env.PROBE_RESULT, "utf8"));
      } catch {
        // 記録が無い（起動の失敗）。判定で落ちる。
      }
      resolve({ mode, code, signal, timedOut, left, output, record });
    });
  });
}

async function main() {
  if (process.platform !== "linux") {
    throw new Error("this probe runs on Linux only");
  }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "h1b-"));
  active.work = work;
  const cleanup = createSignalCleanup(active);
  process.once("SIGINT", cleanup);
  process.once("SIGTERM", cleanup);
  try {
    const appDir = await bundle(work);
    const runs = [];
    for (const mode of ["product", "mapped-control"]) {
      runs.push(await runElectron(appDir, work, mode));
    }
    for (const run of runs) {
      console.log(
        `${run.mode}: exit=${run.code} signal=${run.signal} timedOut=${run.timedOut} left=${run.left.length}`,
      );
      console.log(JSON.stringify(run.record, null, 2));
      if (!run.record || run.timedOut) console.log(run.output.slice(-4000));
    }
    const verdict = judgeUpdateRouteProbe(runs[0].record, runs[1].record);
    for (const run of runs) {
      if (run.timedOut) verdict.failures.push(`${run.mode}: timed out`);
      if (run.left.length) verdict.failures.push(`${run.mode}: processes left`);
    }
    verdict.pass = verdict.failures.length === 0;
    console.log(
      verdict.pass
        ? "H1(b) PASS"
        : `H1(b) FAIL\n${verdict.failures.join("\n")}`,
    );
    process.exitCode = verdict.pass ? 0 : 1;
  } finally {
    process.removeListener("SIGINT", cleanup);
    process.removeListener("SIGTERM", cleanup);
    active.work = null;
    fs.rmSync(work, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main().catch((error) => {
    console.error(`H1(b) ERROR ${error?.message ?? error}`);
    process.exitCode = 1;
  });
}
