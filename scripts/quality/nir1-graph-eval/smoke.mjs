/* global window */
// CP-4 S1c-1 launcher smoke (DR-CP4-S1C1-7): V-9 and V-10 on the product
// `dist-electron/main.cjs` behind the NC-1 observer, on a synthetic empty
// project only (no G-case fixture is read). Run under the Xvfb wrapper in the
// host network namespace:
//
//   TMPDIR=<scratch> node scripts/local-ci-xvfb.mjs node \
//     scripts/quality/nir1-graph-eval/smoke.mjs --run <name> \
//     --ja-model <pinned ja onnx> --en-model <pinned en onnx>
//
// Writes `.artifacts/cp4/<run>/smoke-report.json`. Exit code 1 when any
// check fails. This is not a CP-4 measurement and writes no CP-4 receipt.

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import console from "node:console";
import { clearInterval, setInterval, setTimeout } from "node:timers";
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
  bundleObserver,
  launchGraphEvalElectron,
  prepareEvalProfile,
  snapshotElectronPids,
  stopElectron,
} from "./launcher.mjs";
import { buildHarnessRenderer, startStaticServer } from "./renderer-build.mjs";
import { MAIN_WORKER } from "./eval-native-build.mjs";

const SMOKE_PAGE = "/scripts/quality/nir1-graph-eval/renderer/smoke.html";
const WORKER_NAME = "nir1-c-query-worker";

function parseArgs(argv) {
  const options = {
    "eval-build": path.join(ROOT, ".artifacts/cp4/eval-build"),
    v10: "yes",
  };
  for (let at = 0; at < argv.length; at += 2) {
    if (!argv[at].startsWith("--") || argv[at + 1] === undefined)
      throw new Error("use --name value arguments");
    options[argv[at].slice(2)] = argv[at + 1];
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(options.run ?? ""))
    throw new Error("--run <name> is required");
  return options;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function x11Listing() {
  return readdirSync("/tmp/.X11-unix")
    .sort()
    .map((name) => {
      const info = statSync(path.join("/tmp/.X11-unix", name));
      return { name, ino: info.ino, mtimeMs: info.mtimeMs };
    });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const wrapper = assertXvfbWrapperEnv(process.env);
  const runDir = path.join(ROOT, ".artifacts/cp4", options.run);
  await mkdir(runDir, { recursive: true });
  const tmpDir = path.resolve(options.tmp ?? path.join(runDir, "tmp"));
  await mkdir(tmpDir, { recursive: true });
  const report = {
    schema: "nir1-cp4-s1c1-smoke/1",
    run: options.run,
    startedAt: new Date().toISOString(),
    display: wrapper.display,
    x11Before: x11Listing(),
    checks: {},
    problems: [],
  };
  const problem = (text) => report.problems.push(text);
  const evalDir = path.resolve(options["eval-build"]);
  const nativePath = realpathSync(
    path.resolve(options.native ?? path.join(evalDir, "grimodex-node.node")),
  );
  const evalManifestPath = path.join(evalDir, "eval-build.json");
  if (existsSync(evalManifestPath)) {
    const bytes = await readFile(evalManifestPath);
    const manifest = JSON.parse(bytes);
    report.evalBuild = {
      manifestSha256: sha256(bytes),
      features: manifest.features,
      head: manifest.candidate?.resolvedHeadSha ?? null,
      addonSha256: sha256(await readFile(nativePath)),
    };
  }
  const productMain = path.join(ROOT, PRODUCT_MAIN);
  report.productMain = {
    path: PRODUCT_MAIN,
    sha256: sha256(await readFile(productMain)),
  };

  const rendererDist = path.join(runDir, "renderer-dist");
  report.rendererBuild = await buildHarnessRenderer({
    root: ROOT,
    outDir: path.relative(ROOT, rendererDist),
    input: {
      index: path.join(ROOT, "index.html"),
      smoke: path.join(ROOT, SMOKE_PAGE.slice(1)),
    },
  });
  delete report.rendererBuild.files;
  const server = await startStaticServer({ dir: rendererDist });
  report.staticServer = { origin: server.origin };
  const userData = path.join(runDir, "user-data");
  report.profile = await prepareEvalProfile({
    userData,
    d2aMode: "restricted",
    models: { ja: options["ja-model"], en: options["en-model"] },
  });
  const observer = await bundleObserver({
    outDir: path.join(runDir, "observer"),
  });
  report.observerBundle = {
    sha256: observer.sha256,
    sources: observer.sources,
  };
  const netLogPath = path.join(runDir, "netlog.json");
  const env = buildElectronLaunchEnv(process.env, {
    userData,
    nativePath,
    rendererUrl: server.url(SMOKE_PAGE),
    productMain,
    tmpDir,
  });

  let handle;
  let sampler;
  const recorded = new Map();
  const remember = () => {
    if (!handle) return;
    for (const row of snapshotElectronPids(handle.pid))
      recorded.set(`${row.pid}:${row.startTime}`, row);
  };
  try {
    handle = await launchGraphEvalElectron({ observer, env, netLogPath });
    report.launch = { pid: handle.pid, removedEnv: handle.launch.removedEnv };
    // The socket window is the Electron lifetime: the sampler's first sample
    // precedes the run, its final sample follows it.
    sampler = startSocketSampler({ rootPid: handle.pid });
    report.run = { startedAtMs: Date.now() };
    remember();
    const page = await handle.app.firstWindow();
    await page.waitForFunction(() => window.cp4Smoke?.ready === true, null, {
      timeout: 120_000,
    });
    remember();
    const record = await handle.app.evaluate(() => globalThis.__cp4Observer);
    report.observer = record;
    report.checks.observer = assessObserverRecord(record, {
      stderr: handle.stderr(),
    });
    if (!report.checks.observer.ok)
      problem(`observer: ${report.checks.observer.problems.join("; ")}`);
    try {
      report.checks.ozone = assertX11Ozone(readProcessTree(handle.pid));
    } catch (error) {
      problem(error.message);
    }

    // V-9: the Main's addon module is reachable from app.evaluate.
    report.v9 = await handle.app.evaluate((_electron, file) => {
      const Module = process.getBuiltinModule("node:module");
      const cached = Module._cache[file];
      const viaCreateRequire = Module.createRequire(file)(file);
      let viaMainModule;
      try {
        viaMainModule = process.mainModule?.require?.(file) ?? null;
      } catch {
        viaMainModule = null;
      }
      return {
        electron: process.versions.electron,
        cachedPresent: cached !== undefined,
        sameAsCache: cached?.exports === viaCreateRequire,
        sameViaMainModule: viaMainModule === viaCreateRequire,
        evalExports: Object.keys(viaCreateRequire)
          .filter((name) => name.startsWith("nir1GraphEval"))
          .sort(),
        status: JSON.parse(viaCreateRequire.nir1GraphEvalStatus()),
      };
    }, nativePath);
    const status = report.v9.status;
    if (
      !report.v9.cachedPresent ||
      !report.v9.sameAsCache ||
      status?.registrations !== 1 ||
      status?.worker?.state !== "configured" ||
      status?.worker?.path !== path.join(ROOT, MAIN_WORKER) ||
      status?.gateOpened !== true
    )
      problem(`V-9: ${JSON.stringify(report.v9)}`);

    // V-10: a seeded begin on a synthetic empty project spawns the worker.
    if (options.v10 === "yes") {
      const workspacePath = path.join(runDir, "workspace");
      const ids = {
        workspacePath,
        projectId: "cp4-s1c1-smoke",
        sceneId: "cp4-s1c1-scene",
      };
      report.v10 = {
        prepare: await page.evaluate(
          (input) => window.cp4Smoke.prepare(input),
          ids,
        ),
      };
      await handle.app.evaluate((_electron, file) => {
        const Module = process.getBuiltinModule("node:module");
        Module.createRequire(file)(file).nir1GraphEvalClearSamples();
      }, nativePath);
      const workers = new Map();
      const watch = setInterval(() => {
        for (const row of readProcessTree(handle.pid))
          if (row.exe && path.basename(row.exe) === WORKER_NAME)
            workers.set(row.pid, row.exe);
        remember();
      }, 50);
      try {
        report.v10.begin = await page.evaluate(
          (input) => window.cp4Smoke.begin(input),
          { ...ids, seed: "cp4-synthetic-seed-entity" },
        );
        const deadline = Date.now() + 20_000;
        let diagnostics;
        while (Date.now() < deadline) {
          diagnostics = await handle.app.evaluate((_electron, file) => {
            const Module = process.getBuiltinModule("node:module");
            const addon = Module.createRequire(file)(file);
            return {
              diagnostics: JSON.parse(addon.nir1GraphEvalDiagnostics()),
              samples: JSON.parse(addon.nir1GraphEvalSamples()),
              status: JSON.parse(addon.nir1GraphEvalStatus()),
            };
          }, nativePath);
          const counters = diagnostics.diagnostics;
          if (
            (counters.preparesReady ?? 0) > 0 ||
            (counters.prepareFailures ?? 0) > 0
          )
            break;
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        report.v10.native = diagnostics;
        if (report.v10.begin?.ticket)
          report.v10.release = await page.evaluate(
            (ticket) => window.cp4Smoke.release(ticket),
            report.v10.begin.ticket,
          );
      } finally {
        clearInterval(watch);
      }
      report.v10.workerProcesses = [...workers].map(([pid, exe]) => ({
        pid,
        exe,
      }));
      // DR-CP4-M-1: the worker runs from the path Main configured (dev:
      // `src-tauri/target/release/`), verified equal to the one beside the
      // evaluation `.node`.
      const expectedWorker = path.join(ROOT, MAIN_WORKER);
      const begins = report.v10.native?.diagnostics?.begins ?? 0;
      report.v10.ownerReached = begins > 0;
      report.v10.workerFromMainPath = report.v10.workerProcesses.some(
        (row) => row.exe === expectedWorker,
      );
      if (!report.v10.ownerReached)
        problem(
          `V-10 not reached: the Native began no Graph (begin graph=${JSON.stringify(report.v10.begin?.graph)}, ir=${report.v10.begin?.ir}; the Graph starts only with an IR operation, which needs a usable Chronicle Index snapshot)`,
        );
      else if (!report.v10.workerFromMainPath)
        problem(
          `V-10: no ${WORKER_NAME} process from ${expectedWorker} was seen`,
        );
    }
    remember();
  } catch (error) {
    problem(`run: ${error?.stack ?? error}`);
  } finally {
    report.run ??= { startedAtMs: Date.now() };
    report.run.finishedAtMs = Date.now();
    if (sampler) report.socketSamples = sampler.stop();
    if (handle) {
      remember();
      report.stop = await stopElectron(handle, [...recorded.values()]);
      report.stderrTail = handle.stderr().slice(-4000);
      report.recordedPids = [...recorded.values()];
      if (report.stop.remaining.length > 0)
        problem(`processes left: ${report.stop.remaining.join(",")}`);
    }
    await server.close();
    report.staticServer.requests = server.requests;
  }

  if (report.socketSamples) {
    report.checks.sockets = assessSocketSamples({
      samples: report.socketSamples,
      run: report.run,
    });
    if (report.checks.sockets.violations.length > 0)
      problem(`sockets: ${report.checks.sockets.violations.join("; ")}`);
  }
  if (existsSync(netLogPath)) {
    const text = await readFile(netLogPath, "utf8");
    const { log, truncated } = parseNetLogText(text);
    report.netLog = {
      sha256: sha256(Buffer.from(text)),
      truncated,
      ...analyzeNetLog(log, {
        blackholePort: report.observer?.blackholePort ?? null,
      }),
    };
    if (report.netLog.nonLoopbackAttempts !== 0)
      problem(`net log: ${JSON.stringify(report.netLog.attempts)}`);
  } else problem("no net log was written");
  const dictionaries = path.join(userData, "Dictionaries");
  report.dictionaries = existsSync(dictionaries)
    ? readdirSync(dictionaries)
    : [];
  if (report.dictionaries.some((name) => name.endsWith(".bdic")))
    problem(`dictionaries were fetched: ${report.dictionaries.join(",")}`);
  // S1 import (fix-round-1 profileEgressEvidence): servers Chromium persisted.
  try {
    const state = JSON.parse(
      await readFile(path.join(userData, "Network Persistent State"), "utf8"),
    );
    report.networkPersistentServers = (
      state?.net?.http_server_properties?.servers ?? []
    ).map((entry) => entry.server);
  } catch (error) {
    report.networkPersistentServers =
      error?.code === "ENOENT" ? [] : [`unreadable: ${error?.code}`];
  }
  if (
    report.networkPersistentServers.some(
      (server) => !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/u.test(server),
    )
  )
    problem(`persisted servers: ${report.networkPersistentServers.join(",")}`);
  report.x11After = x11Listing();
  if (JSON.stringify(report.x11After) !== JSON.stringify(report.x11Before))
    problem("the /tmp/.X11-unix listing changed");
  report.finishedAt = new Date().toISOString();
  report.ok = report.problems.length === 0;
  await writeFile(
    path.join(runDir, "smoke-report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(
    JSON.stringify({
      ok: report.ok,
      problems: report.problems,
      report: path.relative(ROOT, path.join(runDir, "smoke-report.json")),
    }),
  );
  if (!report.ok) process.exitCode = 1;
}

await main();
