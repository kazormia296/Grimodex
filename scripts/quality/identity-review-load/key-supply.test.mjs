// key の供給の試験（fake の key・fake の writer。製品の key store・keyring・Electron は使わない）。
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { writeKeyToFifo } from "../chronicle-prompt-cache-diag/fifo-key.mjs";
import {
  assertKeyShape,
  hashKeyStore,
  installKey,
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
