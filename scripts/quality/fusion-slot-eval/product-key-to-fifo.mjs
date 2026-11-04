// 評価（試験の仕組み）専用。製品（packaged の Grimodex）がユーザーの profile に safeStorage で
// 暗号化して保存した API key を、app 名 "Grimodex" の Electron の中で復号し、名前付きパイプ
// （FIFO）に 1 回だけ書く。harness は同じ FIFO を --key-file で読む。平文はディスクに残さない。
//
// - 製品の profile の ai-keys.json は読むだけ（書かない）。userData は使い捨ての一時 dir。
// - key の値・長さは出さない。出すのは成否と safeStorage の backend だけ。
// - 2026-11-04 のユーザーの依頼（「評価用の key は key ring に有るキーで」）による。
//
// 使い方（local-ci-xvfb の下、DBUS_SESSION_BUS_ADDRESS を残す）:
//   electron product-key-to-fifo.mjs <ai-keys.json> <service> <fifo> <prefix>
import { app, safeStorage } from "electron";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { Buffer } from "node:buffer";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const [file, service, fifo, prefix] = process.argv.slice(-4);
let scratch = null;
// app.exit は process をすぐ終えるので、一時の userData はその前に消す。
const exit = (code) => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  app.exit(code);
};
const fail = (message) => {
  process.stderr.write(`[product-key] ${message}\n`);
  // 読み手（harness）が FIFO で待ち続けないよう、空を書いて閉じる（形式の検査で止まる）。
  try {
    if (statSync(fifo).isFIFO()) writeFileSync(fifo, "");
  } catch {
    // FIFO が無い・開けないなら、読み手も開けていない。
  }
  exit(1);
};

// 製品の app 名。Linux の safeStorage の鍵（keyring の "Chromium Safe Storage"）は app 名ごと。
app.setName("Grimodex");
scratch = mkdtempSync(path.join(os.tmpdir(), "gdx-product-key-"));
app.setPath("userData", scratch);

app.whenReady().then(() => {
  try {
    if (!statSync(fifo).isFIFO()) return fail("出力先が FIFO でない");
    if ((statSync(fifo).mode & 0o077) !== 0) return fail("FIFO の権限は 600");
    const backend = safeStorage.getSelectedStorageBackend?.() ?? "unknown";
    if (
      !safeStorage.isEncryptionAvailable() ||
      ["basic_text", "unknown"].includes(backend)
    )
      return fail(`safeStorage が keyring を使えない（backend ${backend}）`);
    const store = JSON.parse(readFileSync(file, "utf8"));
    const accounts = store?.[service];
    const cipher =
      accounts && typeof accounts === "object"
        ? accounts["grimodex-user"]
        : null;
    if (typeof cipher !== "string") return fail(`${service} の key が無い`);
    const key = safeStorage.decryptString(Buffer.from(cipher, "base64")).trim();
    if (
      !key.startsWith(prefix) ||
      key.length < 40 ||
      key.length > 300 ||
      /\s/u.test(key)
    )
      return fail("復号した key の形式（接頭辞と長さ）が想定と違う");
    writeFileSync(fifo, key);
    process.stdout.write(`[product-key] ok backend=${backend}\n`);
    exit(0);
  } catch (error) {
    fail(`復号に失敗（${error instanceof Error ? error.name : "error"}）`);
  }
});
