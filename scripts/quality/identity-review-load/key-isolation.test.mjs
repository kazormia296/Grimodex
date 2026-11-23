// key の隔離と後始末の試験（§17.6）。偽の safeStorage・偽の userData・偽の env。key・keyring・Electron は使わない。
import assert from "node:assert/strict";
import {
  chmodSync,
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
import { inspectKeyFiles } from "./cleanup.mjs";
import {
  buildMeasureElectronEnv,
  finishCellCleanup,
} from "./launcher-common.mjs";
import {
  assertPlainTextKeystoreAllowed,
  installPlainTextKeystore,
} from "./plain-text-keystore.mjs";
import { REAL_ENV_NAMES } from "./real-env.mjs";
import {
  buildIsolatedLauncherEnv,
  buildLauncherCommand,
  parseLaunchArgs,
} from "./launch-measure-b.mjs";

function withTmp(fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "idl-iso-"));
  return Promise.resolve(fn(dir)).finally(() =>
    rmSync(dir, { recursive: true, force: true }),
  );
}

/** <dir>/run/<cell>/user-data（0700）を作る。 */
function makeUserData(dir, mode = 0o700) {
  const runRoot = path.join(dir, "run");
  const userData = path.join(runRoot, "cell", "user-data");
  mkdirSync(userData, { recursive: true });
  chmodSync(path.join(runRoot, "cell"), 0o700);
  chmodSync(userData, mode);
  return { runRoot, userData };
}

const baseEnv = (userData, runRoot) => ({
  GRIMODEX_IDL_PLAIN_TEXT_KEYSTORE: "1",
  GRIMODEX_USER_DATA_DIR: userData,
  GRIMODEX_IDL_RUN_ROOT: runRoot,
});

test("測定の Electron の env は隔離 bus・隔離 runtime dir だけで、控えた本物の env は入らない", () => {
  const real = {
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/fake-real-session/bus",
    XDG_RUNTIME_DIR: "/fake-real-session/runtime",
    XDG_CURRENT_DESKTOP: "REAL-DESKTOP",
    DESKTOP_SESSION: "real-session",
  };
  const saved = {};
  for (const [k, v] of Object.entries(real)) {
    saved[k] = process.env[k];
    process.env[k] = v; // launcher の process.env に本物があっても、Electron の env へは入らない
  }
  try {
    const env = buildMeasureElectronEnv({
      rendererUrl: "http://127.0.0.1:1/x",
      userData: "/out/run/c/user-data",
      native: "/n",
      main: "/m",
      tmpDir: "/out/run/c/tmp",
      xdgDir: "/out/run/c/xdg",
      busAddress: "unix:path=/out/dbus/bus",
      plainTextRunRoot: "/out/run",
    });
    assert.equal(env.DBUS_SESSION_BUS_ADDRESS, "unix:path=/out/dbus/bus");
    assert.equal(env.XDG_RUNTIME_DIR, "/out/run/c/xdg");
    assert.equal(env.GRIMODEX_IDL_PLAIN_TEXT_KEYSTORE, "1");
    assert.equal(env.GRIMODEX_IDL_RUN_ROOT, "/out/run");
    const values = Object.values(env).join("\n");
    for (const value of Object.values(real))
      assert.ok(!values.includes(value), "real env value leaked");
    assert.ok(!("XDG_CURRENT_DESKTOP" in env) && !("DESKTOP_SESSION" in env));
    // 許可リストのうち Electron の既定の env に入る名前は launcher 由来の PATH・HOME・LANG・DISPLAY・XAUTHORITY だけ。
    const inherited = new Set([
      "PATH",
      "HOME",
      "LANG",
      "DISPLAY",
      "XAUTHORITY",
    ]);
    for (const name of REAL_ENV_NAMES)
      if (name in env && !inherited.has(name))
        assert.ok(
          ["DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR"].includes(name),
        );
    // 上書きの条件の env は、本測定でない cell では立たない。
    const plain = buildMeasureElectronEnv({
      rendererUrl: "u",
      userData: "u",
      native: "n",
      main: "m",
      tmpDir: "t",
      xdgDir: "x",
      busAddress: "b",
    });
    assert.ok(!("GRIMODEX_IDL_PLAIN_TEXT_KEYSTORE" in plain));
  } finally {
    for (const [k, v] of Object.entries(saved))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  }
});

test("basic_text を認める上書きは、要求・0700 の userData・一時 root の下の 3 条件が揃うときだけ", async () => {
  await withTmp((dir) => {
    const { runRoot, userData } = makeUserData(dir);
    assert.doesNotThrow(() =>
      assertPlainTextKeystoreAllowed(baseEnv(userData, runRoot)),
    );
    assert.throws(
      () =>
        assertPlainTextKeystoreAllowed({
          ...baseEnv(userData, runRoot),
          GRIMODEX_IDL_PLAIN_TEXT_KEYSTORE: "0",
        }),
      /PLAIN_TEXT_KEYSTORE_NOT_REQUESTED/u,
    );
    assert.throws(
      () =>
        assertPlainTextKeystoreAllowed({
          ...baseEnv(userData, runRoot),
          GRIMODEX_IDL_RUN_ROOT: "relative",
        }),
      /PLAIN_TEXT_KEYSTORE_PATHS/u,
    );
    // 一時 root の外（兄弟の dir）
    const other = path.join(dir, "elsewhere");
    mkdirSync(other, { mode: 0o700 });
    assert.throws(
      () => assertPlainTextKeystoreAllowed(baseEnv(other, runRoot)),
      /PLAIN_TEXT_KEYSTORE_ROOT/u,
    );
    // userData が 0755
    chmodSync(userData, 0o755);
    assert.throws(
      () => assertPlainTextKeystoreAllowed(baseEnv(userData, runRoot)),
      /PLAIN_TEXT_KEYSTORE_MODE/u,
    );
  });
});

test("上書きは basic_text のときだけ backend の名前を変え、本物の名前を残す。条件が欠ければ上書きしない", async () => {
  await withTmp((dir) => {
    const { runRoot, userData } = makeUserData(dir);
    const calls = [];
    const fake = (backend) => ({
      getSelectedStorageBackend: () => backend,
      setUsePlainTextEncryption: (v) => calls.push(["plain", v]),
    });
    const storage = fake("basic_text");
    const real = installPlainTextKeystore(storage, baseEnv(userData, runRoot));
    assert.equal(real(), "basic_text");
    assert.notEqual(storage.getSelectedStorageBackend(), "basic_text");
    assert.ok(
      !["basic_text", "unknown"].includes(storage.getSelectedStorageBackend()),
    );
    assert.deepEqual(calls, [["plain", true]]);
    // 実際の keyring の backend の名前は変えずに返す。
    const keyring = fake("gnome_libsecret");
    installPlainTextKeystore(keyring, baseEnv(userData, runRoot));
    assert.equal(keyring.getSelectedStorageBackend(), "gnome_libsecret");
    // 条件が欠ければ、safeStorage に触れずに止まる。
    const untouched = fake("basic_text");
    assert.throws(
      () => installPlainTextKeystore(untouched, {}),
      /PLAIN_TEXT_KEYSTORE_NOT_REQUESTED/u,
    );
    assert.deepEqual(calls.length, 2); // 2 回目は gnome のとき、3 回目の untouched は呼ばれない
    assert.equal(untouched.getSelectedStorageBackend(), "basic_text");
  });
});

test("後始末の検査：userData の下の ai-keys.json（と一時 file）に key の entry が残っていれば数える。空・無しは 0", async () => {
  await withTmp((dir) => {
    const userData = path.join(dir, "user-data");
    mkdirSync(path.join(userData, "sub"), { recursive: true });
    assert.deepEqual(inspectKeyFiles(userData), { files: 0, withEntries: 0 });
    // delete_api_key の後：空の store は file が残っても entry は 0
    writeFileSync(path.join(userData, "ai-keys.json"), "{}");
    assert.deepEqual(inspectKeyFiles(userData), { files: 1, withEntries: 0 });
    // key が残っている（偽の暗号文）
    writeFileSync(
      path.join(userData, "sub", "ai-keys.json"),
      JSON.stringify({ svc: { acct: "ZmFrZS1jaXBoZXI=" } }),
    );
    assert.deepEqual(inspectKeyFiles(userData), { files: 2, withEntries: 1 });
    // 書きかけの一時 file・読めない file は保守側に数える
    writeFileSync(path.join(userData, "ai-keys.json.123.abc.tmp"), "garbage");
    assert.deepEqual(inspectKeyFiles(userData), { files: 3, withEntries: 2 });
    // 結果に内容は含まれない
    assert.ok(!JSON.stringify(inspectKeyFiles(userData)).includes("ZmFr"));
    // 無い dir は 0
    assert.deepEqual(inspectKeyFiles(path.join(dir, "gone")), {
      files: 0,
      withEntries: 0,
    });
  });
});

test("外側の script：隔離した launcher の env に本物の bus・Wayland の変数は無い。引数の形を検査する", () => {
  const env = buildIsolatedLauncherEnv(
    {
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/fake-real-session/bus",
      WAYLAND_DISPLAY: "wayland-0",
      WAYLAND_SOCKET: "3",
      XDG_SESSION_TYPE: "wayland",
      XDG_RUNTIME_DIR: "/run/user/1000",
      PATH: "/usr/bin",
    },
    "/out",
  );
  for (const name of [
    "DBUS_SESSION_BUS_ADDRESS",
    "WAYLAND_DISPLAY",
    "WAYLAND_SOCKET",
    "XDG_SESSION_TYPE",
  ])
    assert.ok(!(name in env));
  assert.equal(env.TMPDIR, "/out/tmp");
  assert.equal(env.ELECTRON_OZONE_PLATFORM_HINT, "x11");
  const [command, argv] = buildLauncherCommand({
    output: "/out",
    passthrough: ["--mode", "trial"],
    fifo: "/out/real-env/key-fifo-x/key.fifo",
  });
  assert.equal(command, "dbus-run-session");
  assert.ok(argv.includes("--real-env-fifo"));
  assert.deepEqual(argv.slice(-2), ["--mode", "trial"]);
  assert.deepEqual(
    parseLaunchArgs(["--output", "/o", "--", "--mode", "trial"]),
    { output: "/o", passthrough: ["--mode", "trial"] },
  );
  assert.throws(() => parseLaunchArgs(["--mode", "trial"]), /USAGE/u);
  assert.throws(
    () => parseLaunchArgs(["--output", "/o", "--", "--real-env-fifo", "x"]),
    /USAGE/u,
  );
});

test("cell の後始末：key の entry が残っていれば failed にし、無ければ workRoot を消して status を書き換えられる", async () => {
  await withTmp((dir) => {
    const make = (name, store) => {
      const workRoot = path.join(dir, name);
      const userData = path.join(workRoot, "user-data");
      mkdirSync(userData, { recursive: true });
      if (store !== undefined)
        writeFileSync(path.join(userData, "ai-keys.json"), store);
      return { workRoot, userData };
    };
    // delete_api_key の後（空の store）：消えて、failed にならない。
    const clean = make("clean", "{}");
    const cellOk = { status: "completed" };
    finishCellCleanup(cellOk, clean);
    assert.equal(cellOk.status, "completed");
    assert.deepEqual(cellOk.keyCleanup, {
      keyFilesBeforeRemoval: 1,
      keyFilesWithEntries: 0,
      workRootRemoved: true,
    });
    assert.ok(!existsSync(clean.workRoot));
    // key が残ったまま（delete_api_key が働かなかった）：消すが、failed と code を残し、値は載せない。
    const dirty = make("dirty", JSON.stringify({ svc: { acct: "QUJD" } }));
    const cellBad = { status: "completed" };
    finishCellCleanup(cellBad, dirty);
    assert.equal(cellBad.status, "failed");
    assert.equal(cellBad.keyCleanup.keyFilesWithEntries, 1);
    assert.ok(cellBad.errors[0].codes.includes("KEY_RESIDUE_AFTER_CELL"));
    assert.ok(!JSON.stringify(cellBad).includes("QUJD"));
    assert.ok(!existsSync(dirty.workRoot));
    // 製品の ai-keys.json は触らない（別の path）。この関数は workRoot の下だけを消す。
    const product = path.join(dir, "product-ai-keys.json");
    writeFileSync(product, "{}");
    finishCellCleanup({}, make("another", undefined));
    assert.ok(existsSync(product));
  });
});
