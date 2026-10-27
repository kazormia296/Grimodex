// B-7: the failure paths of the Electron session (stop, launch, start) with a
// fake app and a synthetic /proc. Nothing here launches Electron.
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { launch } from "./dprime-check.mjs";
import { launchGraphEvalElectron, stopElectron } from "./launcher.mjs";
import {
  assessMainWorker,
  SOCKET_SUFFIX_BYTES,
  killChildElectronGroupsSync,
  killLiveSessionsSync,
  startSession,
} from "./session.mjs";

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
    assert.deepEqual(
      [thrown.closed, thrown.signalled, thrown.remaining],
      [false, [], []],
    );
    // E-15: the time app.close() took is recorded.
    assert.equal(typeof thrown.closeMs, "number");
    assert.ok(killed.closeMs >= 0);
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
      XDG_RUNTIME_DIR: path.join(root, "xdg-runtime"),
      NO_AT_BRIDGE: "1",
      DBUS_SESSION_BUS_ADDRESS: `unix:path=${path.join(root, "xdg-runtime")}/no-bus`,
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
    signals: false,
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
    statStart: { ino: 1, mtimeMs: 1 },
    statEnd: { ino: 1, mtimeMs: 1 },
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
      statStart: { ino: 1, mtimeMs: 1 },
      statEnd: { ino: 1, mtimeMs: 1 },
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
    HTTPS_PROXY: "http://proxy.example:8080",
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
      XDG_RUNTIME_DIR: path.join(root, "xdg-runtime"),
      NO_AT_BRIDGE: "1",
      DBUS_SESSION_BUS_ADDRESS: `unix:path=${path.join(root, "xdg-runtime")}/no-bus`,
    };
    delete env.HTTPS_PROXY;
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
    assert.ok(handle.launch.removedEnv.includes("HTTPS_PROXY"));
    // E-16: the bus address is replaced (not removed) by the run's own one.
    assert.ok(!handle.launch.removedEnv.includes("DBUS_SESSION_BUS_ADDRESS"));
    assert.ok(!handle.launch.removedEnv.includes("CP4_KEPT"));
    assert.ok(handle.launch.checkedAbsent.includes("WAYLAND_DISPLAY"));
  } finally {
    for (const key of Object.keys(process.env))
      if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    rmSync(root, { recursive: true, force: true });
  }
});

test("B-5: 取消しの signal では記録した Electron の process group と pid を同期で SIGKILL する", () => {
  const { root, stat } = procTree();
  try {
    stat(4242, "10");
    stat(4243, "11");
    const sent = [];
    const live = new Set([
      {
        rootPid: 4242,
        recorded: () => [
          { pid: 4242, startTime: "10" },
          { pid: 4243, startTime: "11" },
          { pid: 4244, startTime: "12" },
        ],
      },
    ]);
    const killed = killLiveSessionsSync(live, {
      procRoot: root,
      kill: (pid, signal) => sent.push(`${pid}:${signal}`),
    });
    assert.deepEqual(sent, ["-4242:SIGKILL", "4242:SIGKILL", "4243:SIGKILL"]);
    assert.deepEqual(killed, [4242, 4243]);
    // root の pid が別の process に再利用されていれば group には送らない。
    stat(4242, "99");
    sent.length = 0;
    killLiveSessionsSync(live, {
      procRoot: root,
      kill: (pid, signal) => sent.push(`${pid}:${signal}`),
    });
    assert.deepEqual(sent, ["4243:SIGKILL"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("B P3／E-9: session の TMPDIR は unix socket の上限に収まる短い path で、停止の後に消える（環境の TMPDIR に依らない）", async () => {
  const runDir = mkdtempSync(path.join("/tmp", "cp4-tmp-"));
  const start = async (deps, tmpRoot = null) =>
    startSession({
      runDir: path.join(runDir, "a".repeat(80)),
      label: "s",
      server: { url: (page) => `http://127.0.0.1:1${page}` },
      observer: { path: "/x/observer.cjs" },
      nativePath: "/x/grimodex-node.node",
      d2aMode: "restricted",
      models: {},
      tmpRoot,
      deps,
    });
  try {
    const calls = { launch: 0, stop: 0 };
    let launchedEnv = null;
    const deps = fakeDeps(calls, {
      firstWindow: () => Promise.reject(new Error("x")),
    });
    const launchFake = deps.launch;
    deps.launch = async (input) => {
      launchedEnv = input.env;
      return launchFake(input);
    };
    // 長い TMPDIR の環境では短い /tmp に落ちる。
    const longBase = path.join(runDir, "b".repeat(90));
    mkdirSync(longBase, { recursive: true });
    const session = await start({ ...deps, tmpBase: longBase });
    const tmp = launchedEnv.TMPDIR;
    assert.ok(tmp.startsWith("/tmp/cp4-"), tmp);
    assert.ok(Buffer.byteLength(tmp) + SOCKET_SUFFIX_BYTES <= 107, tmp);
    assert.ok(existsSync(tmp));
    const evidence = await session.stop();
    assert.equal(existsSync(tmp), false);
    assert.equal(evidence.tmp.removed, true);
    // どの候補も長ければ、起動の前に [precheck]。
    await assert.rejects(
      start({ ...deps, tmpBase: longBase, tmpFallback: longBase }),
      /\[precheck\].*108/,
    );
    await assert.rejects(start(deps, longBase), /\[precheck\].*108/);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("E-12: Main の path の worker の ino と mtime が開始と終了で違えば、bytes が同じでも [precheck]", () => {
  const mainPath = "/r/src-tauri/target/release/nir1-c-query-worker";
  const base = {
    mainPath,
    expectedSha256: "a".repeat(64),
    atStart: "a".repeat(64),
    atEnd: "a".repeat(64),
    exes: [mainPath],
    statStart: { ino: 7, mtimeMs: 100 },
    statEnd: { ino: 7, mtimeMs: 100 },
  };
  assert.equal(assessMainWorker(base).ok, true);
  for (const statEnd of [
    { ino: 8, mtimeMs: 100 },
    { ino: 7, mtimeMs: 200 },
    null,
  ])
    assert.match(
      assessMainWorker({ ...base, statEnd }).problems.join(),
      /\[precheck\] A-3: Main's worker file was replaced/,
    );
});

test("E-13: 取消しの handler は harness の直接の子の electron の process group も止める（launch の最中）", () => {
  const root = mkdtempSync(path.join("/tmp", "cp4-children-"));
  try {
    const proc = (pid, ppid, comm) => {
      mkdirSync(path.join(root, String(pid)), { recursive: true });
      const fields = Array.from({ length: 30 }, () => "0");
      fields[1] = String(ppid);
      writeFileSync(
        path.join(root, String(pid), "stat"),
        `${pid} (${comm}) ${fields.join(" ")}`,
      );
    };
    proc(500, 99, "electron");
    proc(501, 99, "node");
    proc(502, 1, "electron");
    const sent = [];
    killChildElectronGroupsSync({
      procRoot: root,
      parentPid: 99,
      kill: (pid, signal) => sent.push(`${pid}:${signal}`),
    });
    assert.deepEqual(sent, ["-500:SIGKILL"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("E-14: dprime の launch の検査で addon の呼出しが返らなければ上限で投げ、Electron を止める", async () => {
  let stops = 0;
  const session = {
    evidence: { problems: [] },
    addon: () => new Promise(() => {}),
    stop: async () => {
      stops += 1;
      return { problems: [] };
    },
  };
  const error = await launch({
    label: "prep",
    options: { "eval-build": "/x", run: "r" },
    start: async () => session,
    statusWaitMs: 0,
    addonTimeoutMs: 5,
  }).then(
    () => null,
    (thrown) => thrown,
  );
  assert.match(String(error?.message), /timed out/);
  assert.equal(stops, 1);
});

test("S1j-2: setup 専用の Main は封印した admission で起動し（決定論の provider の env を足す）、admission が無ければ製品の Main、検査に落ちれば起動しない", async () => {
  const runDir = mkdtempSync(path.join(os.tmpdir(), "cp4-setup-main-"));
  try {
    const launched = [];
    const deps = (assertSetupMain) => ({
      ...fakeDeps(
        { launch: 0, stop: 0 },
        { firstWindow: () => Promise.reject(new Error("no window")) },
      ),
      launch: async ({ env }) => {
        launched.push(env);
        return {
          pid: 4242,
          app: {
            firstWindow: () => Promise.reject(new Error("no window")),
            evaluate: async () => null,
          },
          stderr: () => "",
          launch: { removedEnv: [] },
          addonCheck: { evaluation: false },
        };
      },
      ...(assertSetupMain ? { assertSetupMain } : {}),
    });
    const base = {
      runDir,
      server: { url: (page) => `http://127.0.0.1:1${page}` },
      observer: { path: "/x/observer.cjs" },
      nativePath: "/x/grimodex-node.node",
      d2aMode: "unrestricted",
      models: {},
    };
    const setupMain = { sealed: true };
    const ir = await startSession({
      ...base,
      label: "ir",
      setupMain,
      deps: deps((admission) => {
        assert.equal(admission, setupMain);
        return {
          mainPath: "/repo/dist-electron/main-setup-ir.cjs",
          env: { GRIMODEX_PRODUCT_JOURNEY_FAKE_AI: "deterministic-v1" },
          record: { kind: "setup-ir", sha256: "e".repeat(64) },
        };
      }),
    });
    await ir.stop();
    assert.equal(
      launched[0].GRIMODEX_CP4_PRODUCT_MAIN,
      "/repo/dist-electron/main-setup-ir.cjs",
    );
    assert.equal(
      launched[0].GRIMODEX_PRODUCT_JOURNEY_FAKE_AI,
      "deterministic-v1",
    );
    assert.equal(ir.evidence.main.kind, "setup-ir");
    assert.ok(
      ir.evidence.extraEnvNames.includes("GRIMODEX_PRODUCT_JOURNEY_FAKE_AI"),
    );
    // Review P2-5: the wrapper env's journey seam variables are never
    // inherited; the ir session's provider env comes from its admission.
    const leaking = {
      ...WRAPPER_ENV,
      GRIMODEX_PRODUCT_JOURNEY_FAKE_AI: "deterministic-v1",
      GRIMODEX_PRODUCT_JOURNEY_MAINTENANCE_TRIGGER: "nir1-graph-index-build",
      GRIMODEX_PRODUCT_JOURNEY_MAINTENANCE_OWNER_TOKEN: "t",
    };
    const author = await startSession({
      ...base,
      label: "author",
      deps: { ...deps(null), wrapperEnv: leaking },
    });
    await author.stop();
    for (const name of Object.keys(leaking))
      if (name.startsWith("GRIMODEX_PRODUCT_JOURNEY_"))
        assert.equal(launched[1][name], undefined, name);
    assert.deepEqual(author.evidence.extraEnvSha256, {});
    assert.match(
      ir.evidence.extraEnvSha256.GRIMODEX_PRODUCT_JOURNEY_FAKE_AI,
      /^[0-9a-f]{64}$/u,
    );
    assert.match(
      launched[1].GRIMODEX_CP4_PRODUCT_MAIN,
      /dist-electron\/main\.cjs$/u,
    );
    assert.equal(launched[1].GRIMODEX_PRODUCT_JOURNEY_FAKE_AI, undefined);
    assert.deepEqual(author.evidence.main, {
      kind: "product",
      path: "dist-electron/main.cjs",
    });
    // The real check refuses an admission it did not seal (no launch).
    await assert.rejects(
      startSession({
        ...base,
        label: "forged",
        setupMain: { setupMain: { sha256: "0".repeat(64) } },
        deps: deps(null),
      }),
      /\[precheck\] S1j-2 setup-main/u,
    );
    assert.equal(launched.length, 2);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});
