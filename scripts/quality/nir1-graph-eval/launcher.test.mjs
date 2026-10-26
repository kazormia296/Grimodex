import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  NC1_SOURCES,
  REMOVED_LAUNCH_ENV,
  ROOT,
  assertLaunchAdmitted,
  assertXvfbWrapperEnv,
  assessObserverRecord,
  buildElectronArgs,
  buildElectronLaunchEnv,
  bundleObserver,
  findFailureCodes,
  survivingPids,
} from "./launcher.mjs";
import { assertElectronLaunch } from "./receipt.mjs";
import { admitDevPreview } from "./admission.mjs";
import { loadDevFixture } from "./dev-fixture.mjs";
import { BINARY_MARKERS } from "./native-architecture.mjs";

const WRAPPER_ENV = Object.freeze({
  GRIMODEX_LOCAL_CI_XVFB: "1",
  DISPLAY: ":7",
  XAUTHORITY: "/tmp/x/grimodex-xvfb-abc/Xauthority",
  XDG_SESSION_TYPE: "x11",
  HOME: "/home/u",
  PATH: "/usr/bin",
  DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
  HTTPS_PROXY: "http://proxy.example:8080",
  no_proxy: "localhost",
  XDG_CURRENT_DESKTOP: "KDE",
  ELECTRON_RUN_AS_NODE: "1",
});

const PATHS = {
  userData: "/r/user-data",
  nativePath: "/r/.artifacts/cp4/eval-build/grimodex-node.node",
  rendererUrl: "http://127.0.0.1:43123/index.html",
  productMain: "/r/dist-electron/main.cjs",
  tmpDir: "/r/tmp",
};

test("DR-CP4-S1C1-4: the harness runs only under the Xvfb wrapper", () => {
  assert.deepEqual(assertXvfbWrapperEnv(WRAPPER_ENV), { display: ":7" });
  for (const [change, pattern] of [
    [{ GRIMODEX_LOCAL_CI_XVFB: undefined }, /local-ci-xvfb/],
    [{ DISPLAY: ":0" }, /DISPLAY/],
    [{ DISPLAY: "host:1" }, /DISPLAY/],
    [{ XAUTHORITY: "/home/u/.Xauthority" }, /XAUTHORITY/],
    [{ XDG_SESSION_TYPE: "wayland" }, /XDG_SESSION_TYPE/],
    [{ WAYLAND_DISPLAY: "wayland-0" }, /Wayland/],
  ]) {
    const env = { ...WRAPPER_ENV, ...change };
    for (const [key, value] of Object.entries(change))
      if (value === undefined) delete env[key];
    assert.throws(() => assertXvfbWrapperEnv(env), pattern);
  }
});

test("DR-CP4-S1C1-4: the launch env drops the desktop, the bus and proxies and passes assertElectronLaunch", () => {
  const env = buildElectronLaunchEnv(WRAPPER_ENV, PATHS);
  const setAgain = new Set([
    "ELECTRON_RENDERER_URL",
    "GRIMODEX_NODE_PATH",
    "GRIMODEX_USER_DATA_DIR",
  ]);
  for (const name of REMOVED_LAUNCH_ENV)
    if (!setAgain.has(name)) assert.equal(env[name], undefined, name);
  assert.equal(env.ELECTRON_OZONE_PLATFORM_HINT, "x11");
  assert.equal(env.DISPLAY, ":7");
  assert.equal(env.XDG_SESSION_TYPE, "x11");
  assert.equal(env.TMPDIR, "/r/tmp");
  // B-3: no session bus through XDG_RUNTIME_DIR, no AT-SPI bridge.
  assert.equal(env.XDG_RUNTIME_DIR, "/r/tmp/xdg-runtime");
  assert.equal(env.NO_AT_BRIDGE, "1");
  for (const name of ["auto_proxy", "SOCKS_SERVER", "ftp_proxy", "FTP_PROXY"])
    assert.ok(REMOVED_LAUNCH_ENV.includes(name), name);
  assert.equal(env.GRIMODEX_NODE_PATH, PATHS.nativePath);
  assert.equal(env.ELECTRON_RENDERER_URL, PATHS.rendererUrl);
  assert.equal(env.GRIMODEX_CP4_PRODUCT_MAIN, PATHS.productMain);
  const args = buildElectronArgs({
    observerPath: "/r/.artifacts/cp4/run/observer/observer.cjs",
    netLogPath: "/r/.artifacts/cp4/run/netlog.json",
  });
  assert.deepEqual(args, [
    "--log-net-log=/r/.artifacts/cp4/run/netlog.json",
    "/r/.artifacts/cp4/run/observer/observer.cjs",
  ]);
  const netns = {
    self: "net:[1]",
    parent: "net:[1]",
    hostInterfaces: ["lo", "eth0"],
    userManager: "net:[1]",
  };
  assert.deepEqual(
    assertElectronLaunch({ env, argv: args, xvfbDisplay: ":7", netns }).display,
    ":7",
  );
  // The un-sanitized wrapper env would fail the same check (DBUS is kept by the wrapper).
  assert.throws(
    () =>
      assertElectronLaunch({
        env: { ...WRAPPER_ENV, ELECTRON_OZONE_PLATFORM_HINT: "x11" },
        argv: args,
        xvfbDisplay: ":7",
        netns,
      }),
    /DBUS_SESSION_BUS_ADDRESS/,
  );
  assert.throws(
    () => buildElectronLaunchEnv(WRAPPER_ENV, { ...PATHS, tmpDir: "tmp" }),
    /absolute/,
  );
  assert.throws(
    () => buildElectronArgs({ observerPath: "observer.cjs", netLogPath: "/n" }),
    /absolute/,
  );
});

test("failure codes of NC-1 and of the observer are found in stderr", () => {
  assert.deepEqual(findFailureCodes("ok\nnothing here\n"), []);
  assert.deepEqual(
    findFailureCodes(
      "[grimodex-electron] NC-SELF-PROXY: renderer の外向き通信を…\nx\n[cp4-observer] CP4-OBS-BYPASS\n[grimodex-electron] NC-LISTENER-LOST",
    ),
    ["NC-SELF-PROXY", "CP4-OBS-BYPASS", "NC-LISTENER-LOST"],
  );
  // Every fixed NC-1 code of the product is found by the scan.
  const source = readFileSync(
    path.join(ROOT, "electron/main/rendererContainment.ts"),
    "utf8",
  );
  const codes = [...source.matchAll(/"(NC-[A-Z-]+)"/gu)].map(
    (match) => match[1],
  );
  assert.ok(codes.length >= 9);
  for (const code of codes)
    assert.deepEqual(findFailureCodes(`[grimodex-electron] ${code}: x`), [
      code,
    ]);
});

function goodRecord() {
  const names = [
    "appendSwitch host-resolver-rules",
    "registerWebContentsPolicy",
    "product main require",
    "product main required",
    "ready",
    "listener up",
    "defaultSession first touch",
    "setProxy start",
    "setProxy done",
    "nc1 start done",
    "released",
  ];
  return {
    schema: "nir1-cp4-observer/1",
    staticOrigin: "http://127.0.0.1:43123",
    hostResolverRules:
      "MAP grimodex-rule-sentinel.invalid 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
    proxyConfig: {
      mode: "fixed_servers",
      proxyRules: "socks5://127.0.0.1:41000",
      proxyBypassRules: "<-loopback>;http://127.0.0.1:43123",
    },
    blackholePort: 41000,
    marks: names.map((name, at) => ({ name, at })),
    startOk: true,
    readBack: {
      staticOrigin: "DIRECT",
      otherLoopbackPort: "SOCKS5 127.0.0.1:41000",
      loopbackPort1: "SOCKS5 127.0.0.1:41000",
      external: "SOCKS5 127.0.0.1:41000",
      expectedBlackhole: "SOCKS5 127.0.0.1:41000",
    },
    spellcheckerEnabledAfter: false,
    released: true,
    failures: [],
  };
}

test("the observer record must show the product order and one bypass", () => {
  assert.deepEqual(assessObserverRecord(goodRecord()), {
    ok: true,
    problems: [],
    failureCodes: [],
  });
  const reversed = goodRecord();
  reversed.marks = [...reversed.marks].reverse();
  assert.match(assessObserverRecord(reversed).problems.join(), /is not before/);
  const productFirst = goodRecord();
  const names = productFirst.marks.map((row) => row.name);
  names.splice(names.indexOf("product main require"), 1);
  names.unshift("product main require");
  productFirst.marks = names.map((name, at) => ({ name, at }));
  assert.match(
    assessObserverRecord(productFirst).problems.join(),
    /registerWebContentsPolicy is not before product main require/,
  );
  const wide = goodRecord();
  wide.proxyConfig.proxyBypassRules = "<-loopback>;127.0.0.1";
  assert.match(assessObserverRecord(wide).problems.join(), /one bypass/);
  const spell = goodRecord();
  spell.spellcheckerEnabledAfter = true;
  assert.match(assessObserverRecord(spell).problems.join(), /spellchecker/);
  const readBack = goodRecord();
  readBack.readBack.external = "DIRECT";
  assert.match(assessObserverRecord(readBack).problems.join(), /read-back/);
  assert.match(
    assessObserverRecord(goodRecord(), {
      stderr: "[grimodex-electron] NC-POLICY",
    }).problems.join(),
    /NC-POLICY/,
  );
  assert.equal(assessObserverRecord(null).ok, false);
});

test("surviving pids match pid and start time (a reused pid is not ours)", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "cp4-pids-"));
  try {
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
    stat(10, "555");
    stat(11, "999");
    const survivors = survivingPids(
      [
        { pid: 10, startTime: "555" },
        { pid: 11, startTime: "556" },
        { pid: 12, startTime: "1" },
      ],
      root,
    );
    assert.deepEqual(
      survivors.map((row) => row.pid),
      [10],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the observer bundle carries the product NC-1 modules and the core", async () => {
  const outDir = mkdtempSync(path.join(os.tmpdir(), "cp4-observer-"));
  try {
    const bundle = await bundleObserver({ outDir });
    for (const source of NC1_SOURCES) assert.ok(bundle.sources[source], source);
    assert.ok(
      bundle.sources["scripts/quality/nir1-graph-eval/observer-core.mjs"],
    );
    assert.match(bundle.sha256, /^[0-9a-f]{64}$/u);
    const text = readFileSync(bundle.path, "utf8");
    assert.ok(text.includes('require("electron")'));
    assert.ok(
      text.includes("MAP * ~NOTFOUND"),
      "the product rules are bundled",
    );
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("D-6／A-4: 評価の .node の起動は admission を要し、既定の addon の path は製品の .node だけ", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "cp4-launch-"));
  try {
    const dir = path.join(root, "electron/native/grimodex-node");
    mkdirSync(dir, { recursive: true });
    const evalNode = path.join(root, "eval.node");
    const evalBytes = `\0${BINARY_MARKERS.join("\0")}\0eval`;
    writeFileSync(evalNode, evalBytes);
    // E-8: the evaluation build's manifest beside the .node names its bytes
    // and the capability flag.
    const manifest = (overrides = {}) =>
      writeFileSync(
        path.join(root, "eval-build.json"),
        JSON.stringify({
          capabilities: { nir1GraphEval: true },
          artifacts: {
            ".artifacts/cp4/eval-build/grimodex-node.node": createHash("sha256")
              .update(evalBytes)
              .digest("hex"),
          },
          ...overrides,
        }),
      );
    manifest();
    const productNode = path.join(root, "product.node");
    writeFileSync(productNode, "\0napi_register_module_v1\0product");
    const preview = admitDevPreview({ purpose: "smoke", fixture: null });
    // 既定の path が無い、または製品の .node なら、admission つきで起動できる。
    assert.equal(
      assertLaunchAdmitted({ root, nativePath: evalNode, admission: preview })
        .evaluation,
      true,
    );
    writeFileSync(path.join(dir, "grimodex-node.node"), "\0napi\0product");
    assert.equal(
      assertLaunchAdmitted({ root, nativePath: evalNode, admission: preview })
        .defaultAddon.product,
      true,
    );
    // admission の無い評価の .node、手で作った admission は拒む。
    for (const admission of [undefined, null, { kind: "dev-preview" }])
      assert.throws(
        () => assertLaunchAdmitted({ root, nativePath: evalNode, admission }),
        /admission/,
      );
    // 製品の .node は admission なしで起動できる（Graph は開かない）。
    assert.equal(
      assertLaunchAdmitted({ root, nativePath: productNode }).evaluation,
      false,
    );
    // 既定の path に評価の文字列を持つ .node（今回のものと別の bytes でも）は拒む。
    writeFileSync(
      path.join(dir, "grimodex-node.node"),
      `\0${BINARY_MARKERS[0]}\0older-eval`,
    );
    for (const nativePath of [evalNode, productNode])
      assert.throws(
        () => assertLaunchAdmitted({ root, nativePath, admission: preview }),
        /default addon/,
      );
    // E-8: 評価の文字列の一部だけの .node（版のずれた評価 build）は評価 build として拒む。
    const partial = path.join(root, "partial.node");
    writeFileSync(partial, `\0${BINARY_MARKERS[0]}\0partial`);
    assert.throws(
      () =>
        assertLaunchAdmitted({ root, nativePath: partial, admission: preview }),
      /some of the evaluation strings/,
    );
    // E-8: manifest の capability が無いか bytes が違えば拒む。
    rmSync(path.join(dir, "grimodex-node.node"));
    for (const overrides of [
      { capabilities: { nir1GraphEval: false } },
      { artifacts: { "x.node": "0".repeat(64) } },
    ]) {
      manifest(overrides);
      assert.throws(
        () =>
          assertLaunchAdmitted({
            root,
            nativePath: evalNode,
            admission: preview,
          }),
        /eval-build\.json/,
        JSON.stringify(overrides),
      );
    }
    rmSync(path.join(root, "eval-build.json"));
    assert.throws(
      () =>
        assertLaunchAdmitted({
          root,
          nativePath: evalNode,
          admission: preview,
        }),
      /eval-build\.json/,
    );
    // E-7: dev の preview の admission は loadDevFixture が読んだ fixture に束縛し、
    // path の文字列や手で作った object（凍結した fixture の path を含む）は受けない。
    const loaded = loadDevFixture({
      root: ROOT,
      fixturePath:
        "scripts/quality/nir1-graph-eval/dev-fixtures/dev-lantern.v1.json",
    });
    const bound = admitDevPreview({
      purpose: "runner-preview",
      fixture: loaded,
    });
    assert.equal(bound.fixturePath, loaded.path);
    assert.equal(bound.fixtureSha256, loaded.sha256);
    for (const fixture of [
      { ...loaded },
      { path: "evals/nir1-graph/fixtures/g-02.v1.json", sha256: "0" },
    ])
      assert.throws(
        () => admitDevPreview({ purpose: "runner-preview", fixture }),
        /loadDevFixture/,
      );
    assert.throws(
      () =>
        admitDevPreview({
          purpose: "runner-preview",
          fixturePath: loaded.path,
        }),
      /unsupported option fixturePath/,
    );
    assert.throws(
      () => admitDevPreview({ purpose: "formal", fixture: null }),
      /\[precheck\]/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
