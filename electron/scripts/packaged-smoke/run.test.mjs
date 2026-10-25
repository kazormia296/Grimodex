import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

import {
  FORM_SUBMIT_SHIM,
  closeAllWithin,
  createTracker,
  injectAttack,
  installInterruptHandler,
  maskFreeText,
  maskRules,
  maskValue,
  runConfigsInOrder,
  startObservers,
  LEGACY_KEYRING_MARKER_FILE,
  attributeRows,
  childEnv,
  maskRecordText,
  parseArgs,
  resolvePackagedApp,
  seedUserData,
} from "./run.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");

test("行への帰属: 時間窓の canary 到達を leaked に、窓の外の到達を unattributed に数える。packaged の proxied は net log の接続", () => {
  const canaries = [{ label: "p-127.0.0.1", hits: [{ label: "p-127.0.0.1", proto: "tcp-connect", at: 105 }, { label: "p-127.0.0.1", proto: "udp", at: 500 }] }];
  const out = attributeRows({
    results: [
      { id: "main.turn-tcp.lo4", outcome: "gathering:gathering", startedAt: 100, endedAt: 200 },
      { id: "main.stun.lo4", outcome: "gathering:complete", startedAt: 201, endedAt: 300 },
      { id: "script", outcome: "error:x" }, // startedAt の無い行は数えない
    ],
    canaries,
    connectTimes: [150, 250, 251],
    listenerHits: null,
    nonce: "abc",
  });
  assert.deepEqual(out.rows.map((row) => [row.id, row.leaked, row.proxied]), [["main.turn-tcp.lo4", 1, 1], ["main.stun.lo4", 0, 2]]);
  assert.equal(out.totals.unattributed, 1);
  assert.equal(out.totals.canaryHits, 2);
  assert.equal(out.totals.leakedProbes, 1);
});

test("toolcheck は listener の実数を proxied に、net log の数を proxiedNetLog に分けて残す。DoH・mDNS は ±50 ms の窓", () => {
  const out = attributeRows({
    results: [{ id: "main.turn-tcp.name", outcome: "gathering:gathering", startedAt: 1000, endedAt: 2000 }],
    canaries: [],
    connectTimes: [1500],
    listenerHits: [1501, 1502],
    dohQueries: [{ at: 960, name: "turntcpname-abc.probe.test", qtype: 1 }, { at: 2100, name: "late-abc.probe.test", qtype: 1 }],
    mdnsPackets: [{ at: 2040 }],
    nonce: "abc",
  });
  assert.equal(out.rows[0].proxied, 2);
  assert.equal(out.rows[0].proxiedListener, 2);
  assert.equal(out.rows[0].proxiedNetLog, 1);
  assert.deepEqual(out.rows[0].dohNames, ["turntcpname-<n>.probe.test/1"]);
  assert.equal(out.rows[0].mdnsQueries, 1);
});

test("記録の伏せ字: nonce、LAN の IPv4、hostname", () => {
  assert.equal(maskRecordText("x-abc123 192.168.1.9 myhost", { nonce: "abc123", lan: "192.168.1.9", hostname: "myhost" }), "x-<n> <lan> <host>");
});

test("子の env から desktop の session・env の proxy・Grimodex と probe の env・LD_PRELOAD を外し、一時の HOME／XDG／TMPDIR を与える", () => {
  const env = childEnv({
    PATH: "/bin", WAYLAND_DISPLAY: "wayland-0", WAYLAND_SOCKET: "3", XDG_SESSION_TYPE: "wayland", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
    HTTPS_PROXY: "http://p", https_proxy: "http://p", ALL_PROXY: "socks5://p", NO_PROXY: "x", GRIMODEX_USER_DATA_DIR: "/home/u/real", GRIMODEX_PRODUCT_JOURNEY_IDS: "[]",
    PROBE_CM: "{}", LD_PRELOAD: "/x.so", NODE_OPTIONS: "--inspect", ELECTRON_RUN_AS_NODE: "1", HOME: "/home/u",
  }, { home: "/tmp/h", tmp: "/tmp/t", platform: "linux", extra: { GRIMODEX_USER_DATA_DIR: "/tmp/u" } });
  for (const key of ["WAYLAND_DISPLAY", "WAYLAND_SOCKET", "XDG_SESSION_TYPE", "DBUS_SESSION_BUS_ADDRESS", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "NO_PROXY", "GRIMODEX_PRODUCT_JOURNEY_IDS", "PROBE_CM", "LD_PRELOAD", "NODE_OPTIONS", "ELECTRON_RUN_AS_NODE"]) {
    assert.equal(env[key], undefined, key);
  }
  assert.equal(env.GRIMODEX_USER_DATA_DIR, "/tmp/u");
  assert.equal(env.HOME, "/tmp/h");
  assert.equal(env.XDG_CONFIG_HOME, path.join("/tmp/h", ".config"));
  assert.equal(env.TMPDIR, "/tmp/t");
  assert.equal(env.ELECTRON_OZONE_PLATFORM_HINT, "x11");
  assert.equal(env.PATH, "/bin");
  // Windows は USERPROFILE／APPDATA を変えない（DR-CP2B-P2-6）
  const win = childEnv({ USERPROFILE: "C:\\Users\\u", APPDATA: "C:\\a" }, { home: "C:\\t\\h", tmp: "C:\\t\\t", platform: "win32" });
  assert.equal(win.USERPROFILE, "C:\\Users\\u");
  assert.equal(win.HOME, undefined);
});

test("userData の初期状態は製品の移行の完了 marker と同じ名前と version（credentialMigration.ts から読む）", () => {
  const source = fs.readFileSync(path.join(repoRoot, "electron", "main", "credentialMigration.ts"), "utf8");
  assert.equal(LEGACY_KEYRING_MARKER_FILE, /LEGACY_KEYRING_MIGRATION_MARKER =\s*"([^"]+)"/.exec(source)?.[1]);
  const version = Number(/const MIGRATION_VERSION = (\d+);/.exec(source)?.[1]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gps-ud-"));
  seedUserData(dir, new Date("2026-10-26T00:00:00Z"));
  const marker = JSON.parse(fs.readFileSync(path.join(dir, LEGACY_KEYRING_MARKER_FILE), "utf8"));
  assert.equal(marker.version, version);
  assert.deepEqual(Object.keys(marker).sort(), ["completedAt", "imported", "skippedExisting", "version"]);
});

test("form の shim: target が空でも _self でもない form だけを送らない（他は元の submit を呼ぶ）", () => {
  const calls = [];
  class HTMLFormElement { constructor(target) { this.target = target; } }
  HTMLFormElement.prototype.submit = function () { calls.push(this.target); return "sent"; };
  const context = vm.createContext({ HTMLFormElement, String });
  assert.equal(vm.runInContext(FORM_SUBMIT_SHIM, context), "form-submit-shim");
  assert.equal(new HTMLFormElement("_blank").submit(), undefined);
  assert.equal(new HTMLFormElement("other-window").submit(), undefined);
  assert.equal(new HTMLFormElement("").submit(), "sent");
  assert.equal(new HTMLFormElement("_self").submit(), "sent");
  assert.deepEqual(calls, ["", "_self"]);
});

test("引数: --out-dir が要る、未知の構成と引数を拒む", () => {
  assert.throws(() => parseArgs([]), /--out-dir/);
  assert.throws(() => parseArgs(["--out-dir", "x", "--configs", "baseline,nope"]), /unknown config/);
  assert.throws(() => parseArgs(["--out-dir", "x", "--no-sandbox"]), /unknown argument/);
  assert.deepEqual(parseArgs(["--out-dir", "x"]).configs, ["baseline", "toolcheck", "packaged"]);
});

test("packaged の実行体の置き場（OS ごとの --dir の出力）", () => {
  const release = fs.mkdtempSync(path.join(os.tmpdir(), "gps-rel-"));
  fs.mkdirSync(path.join(release, "linux-unpacked"), { recursive: true });
  fs.writeFileSync(path.join(release, "linux-unpacked", "grimodex"), "");
  assert.equal(resolvePackagedApp({ app: "", exe: "" }, "linux", release).executable, path.join(release, "linux-unpacked", "grimodex"));
  fs.mkdirSync(path.join(release, "mac-arm64", "Grimodex.app", "Contents", "MacOS"), { recursive: true });
  fs.writeFileSync(path.join(release, "mac-arm64", "Grimodex.app", "Contents", "MacOS", "Grimodex"), "");
  assert.equal(resolvePackagedApp({ app: "", exe: "" }, "darwin", release).appDir, path.join(release, "mac-arm64", "Grimodex.app"));
  assert.throws(() => resolvePackagedApp({ app: "", exe: "" }, "win32", release), /見つからない/);
});

test("中断: signal を受けたら起動中の owner を terminate してから非 0 で終わり、2 回目の signal で二重に実行しない", async () => {
  const handlers = new Map();
  const terminated = [];
  const exits = [];
  const active = new Set([{ label: "packaged" }, { label: "probe" }]);
  const interrupt = installInterruptHandler({
    active,
    terminate: async (owner) => { terminated.push(owner.label); await new Promise((r) => setTimeout(r, 20)); return { ok: true, steps: ["SIGTERM(pid)"] }; },
    exit: (code) => exits.push(code),
    on: (signal, fn) => handlers.set(signal, fn),
    off: (signal) => handlers.delete(signal),
    log: () => {},
  });
  assert.deepEqual([...handlers.keys()].sort(), ["SIGINT", "SIGTERM"]);
  const first = handlers.get("SIGINT")("SIGINT");
  const second = handlers.get("SIGTERM")("SIGTERM");
  assert.equal(interrupt.state.interrupted, true);
  // exit は terminate の後（終了の証拠を待ってから）
  assert.deepEqual(exits, []);
  await Promise.all([first, second]);
  assert.deepEqual(terminated, ["packaged", "probe"]);
  assert.deepEqual(exits, [130]);
  assert.equal(active.size, 0);
  interrupt.dispose();
  assert.equal(handlers.size, 0);
});

test("中断の対象の登録: 終了の証拠が取れた owner だけを外す", () => {
  const active = new Set();
  const track = createTracker(active);
  const a = track({ label: "a" });
  const b = track({ label: "b" });
  track.release(a, { ok: true });
  track.release(b, { ok: false });
  assert.deepEqual([...active], [b]);
});

test("admission closure: 前の構成の終了の証拠が取れなければ、中断されたら、次の構成を起動しない", async () => {
  const started = [];
  const records = await runConfigsInOrder(["baseline", "toolcheck", "packaged"], async (config) => {
    started.push(config);
    return { config, lifecycle: { ok: config !== "toolcheck" } };
  }, { log: () => {} });
  assert.deepEqual(started, ["baseline", "toolcheck"]);
  assert.equal(records.length, 2);
  let interrupted = false;
  const written = [];
  await assert.rejects(runConfigsInOrder(["baseline", "toolcheck"], async (config) => { interrupted = true; return { config, lifecycle: { ok: true } }; }, {
    isInterrupted: () => interrupted, onRecord: (config) => written.push(config), log: () => {},
  }), /中断/);
  // 中断の後は記録を書かない
  assert.deepEqual(written, []);
});

test("受け口の起動が途中で失敗したら、開いたものを閉じてから throw する", async () => {
  const closed = [];
  const fake = (label) => async () => ({ label, port: 1, bound: true, close: async () => { closed.push(label); } });
  await assert.rejects(startObservers({
    nonce: "abc", lan: null, withDoh: false, work: os.tmpdir(),
    factories: {
      startCanary: (label) => fake(label)(),
      startHttp: fake("http"),
      startCtlSocket: async () => { throw new Error("listen EADDRINUSE"); },
    },
  }), /EADDRINUSE/);
  assert.deepEqual(closed.sort(), ["http", "p-127.0.0.1", "q-127.0.0.1-other", "r-127.0.0.2", "s-[::1]"].sort());
});

test("close の待ちは上限つき（閉じない受け口で harness を止めない）", async () => {
  const started = Date.now();
  assert.equal(await closeAllWithin([() => new Promise(() => {}), async () => {}], 50), false);
  assert.equal(await closeAllWithin([async () => {}], 1000), true);
  assert.ok(Date.now() - started < 2000);
});

test("伏せ字: repo・一時 dir・home の絶対 path（Windows の区切りの両形）、nonce、LAN、hostname を key と値で伏せ、利用者名は自由文だけ伏せる", () => {
  const rules = maskRules({
    nonce: "abc123", lan: "10.0.0.5", hostname: "box",
    paths: { repo: "/home/alice/src/Grimodex", tmp: "/tmp/gps-x", home: "/home/alice", win: "C:\\Users\\alice\\AppData" },
  });
  const record = maskValue({
    fatal: "ENOENT /home/alice/src/Grimodex/release/x and /tmp/gps-x/pa-1/netlog.json",
    outputTail: "[pid] C:/Users/alice/AppData/Local/Temp and C:\\Users\\alice\\AppData\\x for alice",
    hostResolver: { "stun-abc123.probe.test": 1, "10.0.0.5": 2 },
    environment: { runner: { os: "Linux" } },
    note: "/home/alice/.config box",
  }, rules);
  assert.equal(record.fatal, "ENOENT <repo>/release/x and <tmp>/pa-1/netlog.json");
  assert.deepEqual(record.hostResolver, { "stun-<n>.probe.test": 1, "<lan>": 2 });
  assert.equal(record.note, "<home>/.config <host>");
  assert.match(record.outputTail, /^\[pid\] <win>\/Local\/Temp and <win>\\x for alice$/);
  const free = maskFreeText({ ...record, cdp: { error: "port owned by alice" }, environment: { runner: { os: "alice" } } }, "alice");
  assert.match(free.outputTail, /for <user>$/);
  assert.equal(free.cdp.error, "port owned by <user>");
  assert.equal(free.environment.runner.os, "alice"); // 自由文の field 以外は変えない
});

test("注入: CDP の port を owned の process tree が listen していると確かめられなければ、接続も Runtime.evaluate もしない", async () => {
  const calls = [];
  const deps = (owned) => ({
    cdpPort: 9222, owner: { isAlive: () => true }, platform: "linux", probeArgs: { nonce: "x" },
    waitTarget: async () => ({ target: { url: "app://bundle/index.html", webSocketDebuggerUrl: "ws://127.0.0.1:9222/x" }, waitedMs: 5 }),
    verifyPortOwner: () => ({ owned, reason: owned ? "owned" : "pid 9 の process group が違う" }),
    fetchVersion: async () => { calls.push("version"); return {}; },
    connect: async () => { calls.push("connect"); return { close: async () => {} }; },
    evaluateFn: async (_session, expression) => {
      calls.push("evaluate");
      if (expression === "document.readyState") return "complete";
      if (expression.includes("form-submit-shim")) return "form-submit-shim";
      if (expression.startsWith("globalThis.__probe")) return true;
      return [{ id: "main.stun.lo4", outcome: "gathering:complete", startedAt: 1, endedAt: 2 }];
    },
    readScript: () => "attack()",
  });
  const refused = await injectAttack(deps(false));
  assert.deepEqual(calls, []);
  assert.equal(refused.cdp.injected, false);
  assert.match(refused.cdp.error, /確かめられない/);
  assert.deepEqual(refused.rendererResults, []);
  const injected = await injectAttack(deps(true));
  assert.ok(calls.includes("connect") && calls.includes("evaluate"));
  assert.equal(injected.cdp.injected, true);
  assert.deepEqual(injected.pageShimIds, ["form-submit"]);
  // owned が true 以外（undefined など）でも注入しない
  calls.length = 0;
  await injectAttack({ ...deps(true), verifyPortOwner: () => ({}) });
  assert.deepEqual(calls, []);
});

