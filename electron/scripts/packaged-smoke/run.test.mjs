import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

import {
  FORM_SUBMIT_SHIM,
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
