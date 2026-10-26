// B-7: the failure paths of the Electron session (stop, launch, start) with a
// fake app and a synthetic /proc. Nothing here launches Electron.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { launch } from "./dprime-check.mjs";
import { launchGraphEvalElectron, stopElectron } from "./launcher.mjs";
import { assessMainWorker, startSession } from "./session.mjs";

const WRAPPER_ENV = Object.freeze({
  GRIMODEX_LOCAL_CI_XVFB: "1",
  DISPLAY: ":7",
  XAUTHORITY: "/tmp/x/grimodex-xvfb-abc/Xauthority",
  XDG_SESSION_TYPE: "x11",
  PATH: "/usr/bin",
});

function procTree() {
  const root = mkdtempSync(path.join(os.tmpdir(), "cp4-proc-"));
  const stat = (pid, start) => {
    mkdirSync(path.join(root, String(pid)), { recursive: true });
    const fields = Array.from({ length: 30 }, (_, at) =>
      at === 19 ? start : "0",
    );
    fields[1] = "1";
    writeFileSync(
      path.join(root, String(pid), "stat"),
      `${pid} (electron) ${fields.join(" ")}`,
    );
  };
  return { root, stat };
}

const hangingApp = () => ({ close: () => new Promise(() => {}) });

test("B-7: stopElectron は close の timeout の後に SIGTERM、SIGKILL と進み、残りを返す", async () => {
  const { root, stat } = procTree();
  try {
    stat(10, "555");
    stat(11, "556");
    const recorded = [
      { pid: 10, startTime: "555" },
      { pid: 11, startTime: "556" },
    ];
    // SIGTERM を無視し、SIGKILL で消える。
    const killed = await stopElectron({ app: hangingApp() }, recorded, {
      closeTimeoutMs: 5,
      signalWaitMs: 1,
      procRoot: root,
      kill: (pid, signal) => {
        if (signal === "SIGKILL")
          rmSync(path.join(root, String(pid)), { recursive: true });
      },
    });
    assert.equal(killed.closed, false);
    assert.deepEqual(
      killed.signalled.map((row) => `${row.pid}:${row.signal}`),
      ["10:SIGTERM", "11:SIGTERM", "10:SIGKILL", "11:SIGKILL"],
    );
    assert.deepEqual(killed.remaining, []);
    // signal が届かない process は remaining に残る（合否は呼出し側、B-2）。
    stat(12, "700");
    const stuck = await stopElectron(
      { app: hangingApp() },
      [{ pid: 12, startTime: "700" }],
      { closeTimeoutMs: 5, signalWaitMs: 1, procRoot: root, kill: () => {} },
    );
    assert.deepEqual(stuck.remaining, [12]);
    // close が投げても pid の確認に進む。
    const thrown = await stopElectron(
      { app: { close: () => Promise.reject(new Error("gone")) } },
      [],
      { closeTimeoutMs: 5, signalWaitMs: 1, procRoot: root },
    );
    assert.deepEqual(thrown, { closed: false, signalled: [], remaining: [] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("B-7: launchGraphEvalElectron の spawn の失敗はそのまま投げ、起動の前の検査を通らなければ spawn しない", async () => {
  const saved = { ...process.env };
  Object.assign(process.env, WRAPPER_ENV);
  delete process.env.WAYLAND_DISPLAY;
  delete process.env.WAYLAND_SOCKET;
  const root = mkdtempSync(path.join(os.tmpdir(), "cp4-spawn-"));
  try {
    const product = path.join(root, "product.node");
    writeFileSync(product, "\0napi\0product");
    const env = {
      DISPLAY: ":7",
      ELECTRON_OZONE_PLATFORM_HINT: "x11",
      GRIMODEX_NODE_PATH: product,
    };
    let spawned = 0;
    await assert.rejects(
      launchGraphEvalElectron({
        root,
        observer: { path: path.join(root, "observer.cjs") },
        env,
        netLogPath: path.join(root, "netlog.json"),
        netns: { unavailable: true },
        electron: {
          _electron: {
            launch: async () => {
              spawned += 1;
              throw new Error("spawn ENOENT");
            },
          },
        },
      }),
      /spawn ENOENT/,
    );
    assert.equal(spawned, 1);
    // 評価の .node を admission なしで起動しようとすると spawn の前に止まる。
    const { BINARY_MARKERS } = await import("./native-architecture.mjs");
    const evaluation = path.join(root, "eval.node");
    writeFileSync(evaluation, `\0${BINARY_MARKERS.join("\0")}\0`);
    await assert.rejects(
      launchGraphEvalElectron({
        root,
        observer: { path: path.join(root, "observer.cjs") },
        env: { ...env, GRIMODEX_NODE_PATH: evaluation },
        netLogPath: path.join(root, "netlog.json"),
        netns: { unavailable: true },
        electron: {
          _electron: {
            launch: async () => {
              spawned += 1;
            },
          },
        },
      }),
      /admission/,
    );
    assert.equal(spawned, 1);
  } finally {
    for (const key of Object.keys(process.env))
      if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    rmSync(root, { recursive: true, force: true });
  }
});

function fakeDeps(calls, { firstWindow }) {
  return {
    wrapperEnv: WRAPPER_ENV,
    prepareProfile: async () => ({ d2aStateFile: null }),
    launch: async () => {
      calls.launch += 1;
      return {
        pid: 4242,
        app: { firstWindow, evaluate: async () => null },
        stderr: () => "",
        launch: { removedEnv: [] },
        addonCheck: { evaluation: false },
      };
    },
    sampleSockets: () => ({ stop: () => [] }),
    snapshotPids: () => [{ pid: 4242, startTime: "1", type: "browser" }],
    stopApp: async () => {
      calls.stop += 1;
      return { closed: false, signalled: [], remaining: [4242] };
    },
    listX11: () => [],
  };
}

test("B-7: startSession の早期の終了（firstWindow の失敗）は problems に残り、stop は 1 回だけ走る", async () => {
  const runDir = mkdtempSync(path.join(os.tmpdir(), "cp4-session-"));
  try {
    const calls = { launch: 0, stop: 0 };
    const session = await startSession({
      runDir,
      label: "s",
      server: { url: (page) => `http://127.0.0.1:1${page}` },
      observer: { path: "/x/observer.cjs" },
      nativePath: "/x/grimodex-node.node",
      d2aMode: "restricted",
      models: {},
      deps: fakeDeps(calls, {
        firstWindow: () => Promise.reject(new Error("exited early")),
      }),
    });
    assert.match(session.evidence.problems.join(), /start: .*exited early/);
    const [first, second] = await Promise.all([session.stop(), session.stop()]);
    assert.equal(first, second);
    assert.equal(calls.stop, 1);
    assert.match(first.problems.join(), /processes left: 4242/);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("B-1: dprime の launch は検査に落ちたら起動した Electron を止めてから投げる", async () => {
  const options = { "eval-build": "/x", run: "r" };
  const fake = (problems, status) => {
    const calls = { stop: 0 };
    const session = {
      evidence: { problems },
      addon: async () => JSON.stringify(status),
      stop: async () => {
        calls.stop += 1;
        return { problems: [] };
      },
    };
    return { calls, session, start: async () => session };
  };
  const ready = {
    registrations: 1,
    worker: { state: "configured" },
    gateOpened: true,
    owner: { profile: { restricted: true, inFlightStopped: true } },
  };
  for (const [problems, status] of [
    [["observer: no observer record"], ready],
    [[], { ...ready, gateOpened: false }],
  ]) {
    const { calls, session, start } = fake(problems, status);
    const error = await launch({
      label: "prep",
      options,
      start,
      statusWaitMs: 0,
    }).then(
      () => null,
      (thrown) => thrown,
    );
    assert.ok(error, JSON.stringify(problems));
    assert.equal(error.launchedSession, session);
    assert.equal(error.launchLabel, "prep");
    assert.equal(calls.stop, 1);
  }
  // 準備ができた session はそのまま返り、止めない。
  const ok = fake([], ready);
  assert.equal(
    await launch({ label: "check", options, start: ok.start, statusWaitMs: 0 }),
    ok.session,
  );
  assert.equal(ok.calls.stop, 0);
  // 起動そのものの失敗は止めるものが無いのでそのまま投げる。
  await assert.rejects(
    launch({
      label: "prep",
      options,
      start: async () => {
        throw new Error("no electron");
      },
    }),
    /no electron/,
  );
});

test("A-3: Main の path の worker を開始時と終了時に hash し、評価 build の worker と違えば [precheck]", () => {
  const mainPath = "/r/src-tauri/target/release/nir1-c-query-worker";
  const ok = assessMainWorker({
    mainPath,
    expectedSha256: "a".repeat(64),
    atStart: "a".repeat(64),
    atEnd: "a".repeat(64),
    exes: [mainPath],
  });
  assert.deepEqual(ok.problems, []);
  assert.equal(ok.ok, true);
  for (const [label, change] of [
    ["changed during the run", { atEnd: "b".repeat(64) }],
    [
      "another build at start",
      { atStart: "c".repeat(64), atEnd: "c".repeat(64) },
    ],
    ["missing at start", { atStart: null }],
    ["missing at end", { atEnd: null }],
    ["replaced while running", { exes: [`${mainPath} (deleted)`] }],
    ["another worker ran", { exes: ["/tmp/nir1-c-query-worker"] }],
    ["expected unknown", { expectedSha256: null }],
  ]) {
    const result = assessMainWorker({
      mainPath,
      expectedSha256: "a".repeat(64),
      atStart: "a".repeat(64),
      atEnd: "a".repeat(64),
      exes: [mainPath],
      ...change,
    });
    assert.equal(result.ok, false, label);
    assert.match(result.problems.join(), /\[precheck\] A-3/, label);
  }
});

test("A-3: 評価の .node の session は worker の食い違いを problems に入れる", async () => {
  const runDir = mkdtempSync(path.join(os.tmpdir(), "cp4-worker-"));
  try {
    const calls = { launch: 0, stop: 0 };
    const hashes = ["a".repeat(64), "a".repeat(64), "b".repeat(64)];
    const deps = fakeDeps(calls, {
      firstWindow: () => Promise.reject(new Error("x")),
    });
    const launchFake = deps.launch;
    deps.launch = async (input) => ({
      ...(await launchFake(input)),
      addonCheck: { evaluation: true },
    });
    // expected（.node の隣）、開始時、終了時の順に読む。
    deps.hashFile = () => hashes.shift();
    const session = await startSession({
      runDir,
      label: "s",
      server: { url: (page) => `http://127.0.0.1:1${page}` },
      observer: { path: "/x/observer.cjs" },
      nativePath: "/x/grimodex-node.node",
      d2aMode: "restricted",
      models: {},
      deps,
    });
    const evidence = await session.stop();
    assert.equal(evidence.mainWorker.ok, false);
    assert.match(evidence.problems.join(), /\[precheck\] A-3/);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("B-2: launch の記録の removedEnv は wrapper の env から実際に落とした名前", async () => {
  const saved = { ...process.env };
  Object.assign(process.env, WRAPPER_ENV, {
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
    CP4_KEPT: "1",
  });
  delete process.env.WAYLAND_DISPLAY;
  delete process.env.WAYLAND_SOCKET;
  const root = mkdtempSync(path.join(os.tmpdir(), "cp4-removed-"));
  try {
    const product = path.join(root, "product.node");
    writeFileSync(product, "\0napi\0product");
    const env = {
      ...process.env,
      ELECTRON_OZONE_PLATFORM_HINT: "x11",
      GRIMODEX_NODE_PATH: product,
    };
    delete env.DBUS_SESSION_BUS_ADDRESS;
    delete env.WAYLAND_DISPLAY;
    delete env.WAYLAND_SOCKET;
    const on = () => {};
    const handle = await launchGraphEvalElectron({
      root,
      observer: { path: path.join(root, "observer.cjs") },
      env,
      netLogPath: path.join(root, "netlog.json"),
      netns: { unavailable: true },
      electron: {
        _electron: {
          launch: async () => ({
            process: () => ({ pid: 5, stderr: { on }, stdout: { on } }),
          }),
        },
      },
    });
    assert.ok(handle.launch.removedEnv.includes("DBUS_SESSION_BUS_ADDRESS"));
    assert.ok(!handle.launch.removedEnv.includes("CP4_KEPT"));
    assert.ok(handle.launch.checkedAbsent.includes("WAYLAND_DISPLAY"));
  } finally {
    for (const key of Object.keys(process.env))
      if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    rmSync(root, { recursive: true, force: true });
  }
});
