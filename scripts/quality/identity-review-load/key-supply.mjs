/* global window */
// 測定 B の key の供給（事前登録 §6）。本測定でだけ使う。この作業（道具づくり）では実行しない。
//
// 経路：製品の profile の ai-keys.json（safeStorage）を、本物の session の bus に届く別 process の Electron の
// helper（env は real-env.mjs が控えたもの。測定の Electron の隔離 bus とは分ける）が復号し、FIFO（0700 の dir の
// 0600）で launcher に 1 回だけ渡す（chronicle-prompt-cache-diag の product-key-to-fifo.mjs と fifo-key.mjs）。
// launcher は key を、隔離した profile の page の bConfigureAi（製品の save_api_key）へ渡す。
// 値・長さは表示・記録しない（エラーにも載せない）。env の ANTHROPIC_API_KEY は読まない。
// 実行後は bDeleteKey（delete_api_key）で消し、userData ごと削除する。製品の ai-keys.json は読むだけで、
// 前後の hash を比べて変更が無いことを records に残す。
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { registerCleanup } from "./cleanup.mjs";
import { assertRealBusEnv, buildHelperEnv } from "./real-env.mjs";
import {
  makeKeyFifo,
  readKeyFromFifo,
} from "../chronicle-prompt-cache-diag/fifo-key.mjs";

const require = createRequire(import.meta.url);
const HERE = import.meta.dirname;
export const DEFAULT_PRODUCT_KEY_STORE = path.join(
  os.homedir(),
  ".local/share/com.miyakey.grimodex/ai-keys.json",
);

/** 形式だけ確かめる（値は返す側に渡すだけで、エラーには載せない）。 */
export function assertKeyShape(value) {
  if (
    typeof value !== "string" ||
    !value.startsWith("sk-ant-") ||
    value.length < 40 ||
    value.length > 300 ||
    /\s/u.test(value)
  )
    throw new Error(
      "[key] KEY_SHAPE the key does not have the expected prefix and length",
    );
  return value;
}

/**
 * FIFO を作り、writer(fifoPath) に書かせ、1 回だけ読む。writer は key を書く非同期関数
 * （本番は productStoreWriter、試験は fake）。FIFO は終わったら必ず消す。
 */
export async function receiveKeyViaFifo(
  writer,
  { parent = os.tmpdir(), timeoutMs = 120_000 } = {},
) {
  const { fifo, cleanup } = makeKeyFifo(parent);
  const unregister = registerCleanup(cleanup); // kill されても FIFO の dir を残さない
  const abort = new globalThis.AbortController();
  try {
    const reading = readKeyFromFifo(fifo, { timeoutMs, signal: abort.signal });
    let writerFailed = false;
    // writer の例外は文面を捨てる（key を含みうる）。失敗の事実だけ持つ。
    const writing = Promise.resolve()
      .then(() => writer(fifo))
      .then(
        () => undefined,
        () => {
          writerFailed = true;
          abort.abort();
        },
      );
    const value = await reading.catch(() => {
      throw new Error(
        writerFailed
          ? "[key] WRITER_FAILED the key writer failed"
          : "[key] KEY_NOT_RECEIVED the key did not arrive through the FIFO",
      );
    });
    await writing;
    return assertKeyShape(value);
  } finally {
    cleanup();
    unregister();
  }
}

/**
 * 本番の writer：製品の ai-keys.json を Electron の helper で復号して FIFO に書く。
 * helper は launcher の隔離した env でなく、控えた本物の session の env（helperEnv。real-env.mjs）で起動する。
 * helperEnv が無い・本物の bus を指さないときは、key を読まずに止まる（launcher の process.env へは落とさない）。
 * helperCommand(fifo, store) は試験用の差し替え（[command, argv]）。値・env はエラーに載せない。
 */
export function productStoreWriter(
  store = DEFAULT_PRODUCT_KEY_STORE,
  {
    helperEnv,
    isolatedAddresses = [],
    tmpDir,
    helperCommand,
    spawnImpl = spawn,
  } = {},
) {
  return (fifo) =>
    new Promise((resolve, reject) => {
      let env;
      try {
        assertRealBusEnv(helperEnv, { isolatedAddresses });
        env = buildHelperEnv(helperEnv, { tmpDir });
      } catch (error) {
        reject(error);
        return;
      }
      const [command, argv] = helperCommand
        ? helperCommand(fifo, store)
        : defaultHelperCommand(fifo, store);
      const child = spawnImpl(command, argv, { env, stdio: "ignore" });
      child.on("error", () => reject(new Error("[key] HELPER_SPAWN_FAILED")));
      child.on("exit", (code) =>
        code === 0
          ? resolve()
          : reject(new Error(`[key] HELPER_FAILED code=${code}`)),
      );
    });
}

function defaultHelperCommand(fifo, store) {
  const electron = require("electron");
  const args = [
    "--no-sandbox",
    path.join(HERE, "../chronicle-prompt-cache-diag/product-key-to-fifo.mjs"),
    "--store",
    store,
    "--fifo",
    fifo,
  ];
  return process.env.GDX_DIAG_NO_XVFB === "1"
    ? [electron, args]
    : ["xvfb-run", ["-a", electron, ...args]];
}

/**
 * cell ごとに 1 回 key を受ける関数（run-measure-b.mjs が使う）。呼ぶとまず、控えた env が本物の bus を指すことを確かめ、
 * 指さなければ FIFO も作らず helper も起動せずに止まる（key を読まない）。
 */
export function makeKeyGetter({
  realEnv,
  isolatedAddresses = [],
  parent,
  tmpDir,
  store,
  helperCommand,
  spawnImpl,
  timeoutMs,
}) {
  return () => {
    assertRealBusEnv(realEnv, { isolatedAddresses });
    return receiveKeyViaFifo(
      productStoreWriter(store, {
        helperEnv: realEnv,
        isolatedAddresses,
        tmpDir,
        helperCommand,
        spawnImpl,
      }),
      { parent, ...(timeoutMs ? { timeoutMs } : {}) },
    );
  };
}

/** 製品の ai-keys.json の hash（実行の前後で比べる。内容は返さない）。無ければ "absent"。 */
export function hashKeyStore(store = DEFAULT_PRODUCT_KEY_STORE) {
  if (!existsSync(store)) return "absent";
  return createHash("sha256")
    .update(readFileSync(store))
    .digest("hex")
    .slice(0, 16);
}

/**
 * key を隔離した profile に入れる（製品の save_api_key）。page は window.identityLoad を持つ。
 * key は引数として page に渡るだけで、返り値・記録に含めない。
 */
export async function installKey(page, { provider, model, key }) {
  return page.evaluate((input) => window.identityLoad.bConfigureAi(input), {
    provider,
    model,
    key,
  });
}

/** 実行後に key を消す。 */
export async function removeKey(page, { provider }) {
  return page.evaluate((input) => window.identityLoad.bDeleteKey(input), {
    provider,
  });
}
