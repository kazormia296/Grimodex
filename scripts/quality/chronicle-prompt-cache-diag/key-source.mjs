// 診断（diagnostic only）専用。Anthropic の API key の取得。値・長さは返り値以外に出さない。
//
// 優先順:
//   1. env ANTHROPIC_API_KEY（そのまま使う。形式だけ確かめる）
//   2. 製品の profile の ai-keys.json（safeStorage）を Electron の helper で復号し、FIFO で受け取る
//      （--product-key-store <path>。既定は ~/.local/share/com.miyakey.grimodex/ai-keys.json）
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { makeKeyFifo, readKeyFromFifo } from "./fifo-key.mjs";

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_PRODUCT_KEY_STORE = path.join(
  os.homedir(),
  ".local/share/com.miyakey.grimodex/ai-keys.json",
);

export function assertKeyShape(value) {
  if (
    typeof value !== "string" ||
    !value.startsWith("sk-ant-") ||
    value.length < 40 ||
    value.length > 300 ||
    /\s/u.test(value)
  ) {
    throw new Error("[key] key の形式（接頭辞と長さ）が想定と違う");
  }
  return value;
}

/** xvfb-run が使えるなら、その下で electron を動かす（window は開かないが display を要る）。 */
function electronCommand(args) {
  const electron = require("electron");
  if (process.env.GDX_DIAG_NO_XVFB === "1") return [electron, args];
  return ["xvfb-run", ["-a", electron, ...args]];
}

async function keyFromProductStore(store) {
  const { fifo, cleanup } = makeKeyFifo(os.tmpdir());
  const abort = new globalThis.AbortController();
  const lines = [];
  try {
    const reading = readKeyFromFifo(fifo, { signal: abort.signal });
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const [command, args] = electronCommand([
      "--no-sandbox",
      path.join(HERE, "product-key-to-fifo.mjs"),
      "--store",
      store,
      "--fifo",
      fifo,
    ]);
    const child = spawn(command, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    for (const stream of [child.stdout, child.stderr])
      stream.on("data", (chunk) => {
        for (const line of chunk.toString().split("\n"))
          if (line.startsWith("[product-key]")) lines.push(line.slice(0, 200));
      });
    const exited = new Promise((resolve) => child.on("exit", resolve));
    exited.then((code) => {
      if (code !== 0) abort.abort();
    });
    const value = await reading.catch((error) => {
      throw new Error(`${error.message}（${lines.join(" ")}）`);
    });
    const code = await exited;
    if (code !== 0)
      throw new Error(`[key] 復号の script が失敗した（${lines.join(" ")}）`);
    return { key: assertKeyShape(value), via: "product-store", lines };
  } finally {
    cleanup();
  }
}

/** key と取得経路（"env" | "product-store"）を返す。 */
export async function resolveAnthropicKey({ productKeyStore } = {}) {
  if (process.env.ANTHROPIC_API_KEY) {
    return {
      key: assertKeyShape(process.env.ANTHROPIC_API_KEY.trim()),
      via: "env",
      lines: [],
    };
  }
  return keyFromProductStore(productKeyStore ?? DEFAULT_PRODUCT_KEY_STORE);
}
