// key の供給の試験（fake の key・fake の writer。製品の key store・keyring・Electron は使わない）。
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { writeKeyToFifo } from "../chronicle-prompt-cache-diag/fifo-key.mjs";
import {
  assertKeyShape,
  hashKeyStore,
  installKey,
  makeKeyGetter,
  productStoreWriter,
  receiveKeyViaFifo,
  removeKey,
} from "./key-supply.mjs";

const FAKE_KEY = `sk-ant-${"x".repeat(50)}`;

test("FIFO で 1 回だけ受け取り、FIFO は消える", async () => {
  const parent = mkdtempSync(path.join(os.tmpdir(), "idl-key-"));
  try {
    let seen = null;
    const key = await receiveKeyViaFifo(
      async (fifo) => {
        seen = fifo;
        await writeKeyToFifo(fifo, FAKE_KEY);
      },
      { parent, timeoutMs: 5_000 },
    );
    assert.equal(key, FAKE_KEY);
    assert.ok(seen && !existsSync(seen));
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("key が届かない・形式が違う場合の失敗に、値を載せない", async () => {
  const parent = mkdtempSync(path.join(os.tmpdir(), "idl-key-"));
  try {
    const bad = "sk-ant-short";
    await assert.rejects(
      receiveKeyViaFifo((fifo) => writeKeyToFifo(fifo, bad), {
        parent,
        timeoutMs: 5_000,
      }),
      (error) =>
        /KEY_SHAPE/u.test(error.message) && !error.message.includes(bad),
    );
    await assert.rejects(
      receiveKeyViaFifo(
        async () => {
          throw new Error(`helper said ${FAKE_KEY}`);
        },
        { parent, timeoutMs: 5_000 },
      ),
      (error) => !error.message.includes(FAKE_KEY),
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
  assert.throws(() => assertKeyShape("not-a-key"), /KEY_SHAPE/u);
});

test("installKey／removeKey は製品の経路（bConfigureAi／bDeleteKey）に key を渡し、返り値に key を含めない", async () => {
  const calls = [];
  globalThis.window = {
    identityLoad: {
      bConfigureAi: async (input) => {
        calls.push([
          "configure",
          input.provider,
          input.model,
          input.key === FAKE_KEY,
        ]);
        return {
          provider: input.provider,
          model: input.model,
          thinkingEnabled: false,
          keyPresent: true,
        };
      },
      bDeleteKey: async (input) => {
        calls.push(["delete", input.provider]);
        return { keyPresent: false };
      },
    },
  };
  const page = { evaluate: async (fn, arg) => fn(arg) };
  const result = await installKey(page, {
    provider: "anthropic",
    model: "claude-sonnet-5-5",
    key: FAKE_KEY,
  });
  assert.deepEqual(calls[0], [
    "configure",
    "anthropic",
    "claude-sonnet-5-5",
    true,
  ]);
  assert.ok(!JSON.stringify(result).includes(FAKE_KEY));
  assert.deepEqual(await removeKey(page, { provider: "anthropic" }), {
    keyPresent: false,
  });
});

test("hashKeyStore：内容を返さず、無ければ absent", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "idl-key-"));
  try {
    assert.equal(hashKeyStore(path.join(dir, "none.json")), "absent");
    const file = path.join(dir, "ai-keys.json");
    writeFileSync(file, `{"a":"${FAKE_KEY}"}`);
    const hash = hashKeyStore(file);
    assert.match(hash, /^[0-9a-f]{16}$/u);
    assert.equal(hashKeyStore(file), hash);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- helper の env の分離（§17.6）。偽の helper（node の小さな script）・偽の bus・偽の key だけ。 ----

const FIFO_KEY_MODULE = path.resolve(
  import.meta.dirname,
  "../chronicle-prompt-cache-diag/fifo-key.mjs",
);

/** 偽の helper：渡された env の要点を file に書き、偽の key を FIFO に書く（製品の key store・keyring は読まない）。 */
function writeFakeHelper(dir) {
  const script = path.join(dir, "fake-helper.mjs");
  writeFileSync(
    script,
    `import { writeFileSync } from "node:fs";
import { writeKeyToFifo } from ${JSON.stringify(FIFO_KEY_MODULE)};
const [fifo, report] = process.argv.slice(2);
writeFileSync(report, JSON.stringify({
  dbus: process.env.DBUS_SESSION_BUS_ADDRESS ?? null,
  runtime: process.env.XDG_RUNTIME_DIR ?? null,
  tmp: process.env.TMPDIR ?? null,
  leak: process.env.IDL_TEST_LEAK ?? null,
  runAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null,
  names: Object.keys(process.env).sort(),
}));
await writeKeyToFifo(fifo, ${JSON.stringify(FAKE_KEY)});
`,
  );
  return script;
}

test("helper は launcher の隔離 bus でなく、控えた本物の bus の env で起動する。launcher の他の変数は渡さない", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "idl-key-"));
  const saved = {
    dbus: process.env.DBUS_SESSION_BUS_ADDRESS,
    leak: process.env.IDL_TEST_LEAK,
    runAsNode: process.env.ELECTRON_RUN_AS_NODE,
  };
  try {
    const isolated = `unix:path=${path.join(dir, "isolated-bus")}`;
    process.env.DBUS_SESSION_BUS_ADDRESS = isolated; // launcher の process.env は隔離 bus
    process.env.IDL_TEST_LEAK = "launcher-only";
    process.env.ELECTRON_RUN_AS_NODE = "1";
    const realSocket = path.join(dir, "real-bus");
    writeFileSync(realSocket, "");
    const realEnv = {
      DBUS_SESSION_BUS_ADDRESS: `unix:path=${realSocket}`,
      XDG_RUNTIME_DIR: dir,
      PATH: process.env.PATH,
    };
    const report = path.join(dir, "report.json");
    const script = writeFakeHelper(dir);
    const getKey = makeKeyGetter({
      realEnv,
      isolatedAddresses: [isolated],
      parent: dir,
      tmpDir: path.join(dir, "tmp"),
      helperCommand: (fifo) => [process.execPath, [script, fifo, report]],
      timeoutMs: 10_000,
    });
    assert.equal(await getKey(), FAKE_KEY);
    const seen = JSON.parse(readFileSync(report, "utf8"));
    assert.equal(seen.dbus, realEnv.DBUS_SESSION_BUS_ADDRESS);
    assert.notEqual(seen.dbus, isolated);
    assert.equal(seen.runtime, dir);
    assert.equal(seen.tmp, path.join(dir, "tmp"));
    assert.equal(seen.leak, null);
    assert.equal(seen.runAsNode, null);
    assert.ok(!seen.names.includes("IDL_TEST_LEAK"));
  } finally {
    for (const [name, value] of [
      ["DBUS_SESSION_BUS_ADDRESS", saved.dbus],
      ["IDL_TEST_LEAK", saved.leak],
      ["ELECTRON_RUN_AS_NODE", saved.runAsNode],
    ])
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("本物の bus が無い・隔離 bus と同じなら、FIFO も作らず helper も起動せず、key を読まずに止まる", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "idl-key-"));
  try {
    let spawned = 0;
    const spawnImpl = () => {
      spawned++;
      throw new Error("must not spawn");
    };
    const isolated = "unix:path=/iso/bus";
    for (const realEnv of [
      undefined,
      {},
      { DBUS_SESSION_BUS_ADDRESS: isolated, XDG_RUNTIME_DIR: dir },
      {
        DBUS_SESSION_BUS_ADDRESS: `unix:path=${dir}/none`,
        XDG_RUNTIME_DIR: dir,
      },
    ]) {
      const getKey = makeKeyGetter({
        realEnv,
        isolatedAddresses: [isolated],
        parent: dir,
        spawnImpl,
      });
      await assert.rejects(
        async () => getKey(),
        (error) =>
          /REAL_BUS_MISSING/u.test(error.message) &&
          !error.message.includes(dir),
      );
    }
    assert.equal(spawned, 0);
    assert.deepEqual(readdirSync(dir), []); // FIFO の dir も作られていない
    // writer 単体でも、本物の bus の env が無ければ起動しない（launcher の process.env へは落とさない）。
    await assert.rejects(
      productStoreWriter(undefined, { spawnImpl })("/unused"),
      /REAL_BUS_MISSING/u,
    );
    assert.equal(spawned, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
