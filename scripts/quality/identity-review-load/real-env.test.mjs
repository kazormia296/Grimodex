// 本物の session の env の控えと受け渡しの試験（偽の値・偽の socket。本物の bus・keyring・helper は使わない）。
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  REAL_ENV_NAMES,
  assertRealBusEnv,
  buildHelperEnv,
  makeRealEnvFifo,
  pickRealEnv,
  receiveRealEnv,
  sendRealEnv,
} from "./real-env.mjs";

function withTmp(fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "idl-realenv-"));
  return Promise.resolve(fn(dir)).finally(() =>
    rmSync(dir, { recursive: true, force: true }),
  );
}

/** 偽の「本物の bus」：socket の代わりに通常 file（存在だけを検査する）。 */
function fakeRealEnv(dir) {
  const socket = path.join(dir, "real-bus");
  writeFileSync(socket, "");
  return {
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${socket},guid=fake`,
    XDG_RUNTIME_DIR: dir,
    XDG_CURRENT_DESKTOP: "FAKE",
    HOME: "/home/fake",
    PATH: "/usr/bin",
  };
}

test("控えるのは許可リストの名前だけ（Wayland・API key・偽 AI の env・隔離の印は入れない）", () => {
  const picked = pickRealEnv({
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/x",
    XDG_RUNTIME_DIR: "/run/user/1",
    WAYLAND_DISPLAY: "wayland-0",
    XDG_SESSION_TYPE: "wayland",
    ANTHROPIC_API_KEY: "sk-ant-x",
    GRIMODEX_PRODUCT_JOURNEY_FAKE_AI: "1",
    GRIMODEX_AI_WIRE_LOG: "1",
    EMPTY: "",
  });
  assert.deepEqual(Object.keys(picked).sort(), [
    "DBUS_SESSION_BUS_ADDRESS",
    "XDG_RUNTIME_DIR",
  ]);
  for (const name of REAL_ENV_NAMES)
    assert.ok(!/WAYLAND|API_KEY|JOURNEY|WIRE_LOG|SESSION_TYPE/u.test(name));
});

test("本物の bus が無い・隔離 bus と同じ・socket が無いときは理由の code で止まる（値は載せない）", async () => {
  await withTmp((dir) => {
    const real = fakeRealEnv(dir);
    assert.doesNotThrow(() => assertRealBusEnv(real));
    const code = (env, opts) => {
      try {
        assertRealBusEnv(env, opts);
      } catch (error) {
        assert.ok(!error.message.includes(dir), "path must not be in message");
        return /REAL_BUS_MISSING (\w+)/u.exec(error.message)?.[1];
      }
      return "none";
    };
    assert.equal(code(undefined), "NO_HANDOFF");
    assert.equal(code({}), "NO_ADDRESS");
    assert.equal(code({ ...real, DBUS_SESSION_BUS_ADDRESS: "" }), "NO_ADDRESS");
    assert.equal(
      code(real, { isolatedAddresses: [real.DBUS_SESSION_BUS_ADDRESS] }),
      "SAME_AS_ISOLATED",
    );
    assert.equal(
      code({ ...real, XDG_RUNTIME_DIR: undefined }),
      "NO_RUNTIME_DIR",
    );
    assert.equal(
      code({
        ...real,
        DBUS_SESSION_BUS_ADDRESS: `unix:path=${path.join(dir, "none")}`,
      }),
      "SOCKET_MISSING",
    );
    // 隔離 bus の address が別なら通る。
    assert.doesNotThrow(() =>
      assertRealBusEnv(real, { isolatedAddresses: ["unix:path=/iso/bus"] }),
    );
  });
});

test("helper の env は控えた env だけから作る（launcher の隔離 bus・他の変数は混ざらない）", () => {
  const real = {
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
    XDG_RUNTIME_DIR: "/run/user/1000",
    ELECTRON_RUN_AS_NODE: "1",
    LAUNCHER_ONLY: "x",
  };
  const env = buildHelperEnv(real, { tmpDir: "/out/tmp" });
  assert.equal(env.DBUS_SESSION_BUS_ADDRESS, real.DBUS_SESSION_BUS_ADDRESS);
  assert.equal(env.XDG_RUNTIME_DIR, "/run/user/1000");
  assert.equal(env.TMPDIR, "/out/tmp");
  assert.equal(env.ELECTRON_OZONE_PLATFORM_HINT, "x11");
  assert.ok(!("ELECTRON_RUN_AS_NODE" in env) && !("LAUNCHER_ONLY" in env));
});

test("外側の script から launcher へ FIFO で 1 回渡す。file に内容は残らず、後始末で消える", async () => {
  await withTmp(async (dir) => {
    const real = fakeRealEnv(dir);
    const { fifo, cleanup } = makeRealEnvFifo(dir);
    try {
      const reading = receiveRealEnv(fifo, { timeoutMs: 5_000 });
      await sendRealEnv(fifo, { ...real, ANTHROPIC_API_KEY: "sk-ant-leak" });
      const got = await reading;
      assert.deepEqual(got, pickRealEnv(real));
      assert.ok(!("ANTHROPIC_API_KEY" in got));
      // dir の下の通常 file は無い（FIFO だけ）。
      const names = readdirSync(path.join(dir, "real-env"), {
        recursive: true,
      });
      assert.ok(names.every((n) => !/\.json$|\.env$/u.test(String(n))));
    } finally {
      cleanup();
    }
    assert.ok(!existsSync(path.join(dir, "real-env")));
  });
});

test("受け取れない（path が無い・期限切れ・JSON でない）ときは code だけで止まる", async () => {
  await withTmp(async (dir) => {
    await assert.rejects(receiveRealEnv(""), /REAL_BUS_MISSING NO_HANDOFF/u);
    const { fifo, cleanup } = makeRealEnvFifo(dir);
    try {
      await assert.rejects(
        receiveRealEnv(fifo, { timeoutMs: 300 }),
        /REAL_BUS_MISSING HANDOFF_NOT_RECEIVED/u,
      );
      const reading = receiveRealEnv(fifo, { timeoutMs: 5_000 });
      const { writeKeyToFifo } =
        await import("../chronicle-prompt-cache-diag/fifo-key.mjs");
      await writeKeyToFifo(fifo, "not json");
      await assert.rejects(reading, /REAL_BUS_MISSING HANDOFF_NOT_JSON/u);
    } finally {
      cleanup();
    }
  });
});
