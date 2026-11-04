// 評価（試験の仕組み）専用。製品（packaged の Grimodex）がユーザーの profile に safeStorage で
// 暗号化して保存した API key を、app 名 "Grimodex" の Electron の中で復号し、harness が作った
// FIFO に 1 回だけ書く（fifo-key.mjs）。平文はディスクに残さない。
//
// - 製品の profile の ai-keys.json は読むだけ（書かない）。userData は使い捨ての一時 dir。
// - key の値・長さは出さない。出すのは成否と safeStorage の backend だけ。
// - harness（ir-slot.mjs の --product-key-store）が keyring の snapshot を取った後に起動する。
// - 2026-11-04 のユーザーの依頼（「評価用の key は key ring に有るキーで」）による。
//
// 使い方: electron product-key-to-fifo.mjs --store <ai-keys.json> --service <grimodex-*> \
//           --fifo <path> --prefix <sk-xxx->
import { app, safeStorage } from "electron";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { Buffer } from "node:buffer";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { writeKeyToFifo } from "./fifo-key.mjs";

function parse(argv) {
  const at = argv.indexOf("--store");
  const args = {};
  for (let i = at; at >= 0 && i + 1 < argv.length; i += 2)
    args[argv[i].replace(/^--/u, "")] = argv[i + 1];
  return args;
}
const args = parse(process.argv);
let scratch = null;
// app.exit は process をすぐ終えるので、一時の userData はその前に消す。
const exit = (code) => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  app.exit(code);
};
const fail = (message) => {
  process.stderr.write(`[product-key] ${message}\n`);
  exit(1);
};

if (
  path.basename(args.store ?? "") !== "ai-keys.json" ||
  !/^grimodex-[a-z-]+$/u.test(args.service ?? "") ||
  !/^sk-[a-z]+-$/u.test(args.prefix ?? "") ||
  !args.fifo
) {
  process.stderr.write("[product-key] 引数が想定と違う\n");
  process.exit(2);
}

// 製品の app 名。Linux の safeStorage の鍵（keyring の "Chromium Safe Storage"）は app 名ごと。
app.setName("Grimodex");
scratch = mkdtempSync(path.join(os.tmpdir(), "gdx-product-key-"));
app.setPath("userData", scratch);

app.whenReady().then(async () => {
  try {
    const backend = safeStorage.getSelectedStorageBackend?.() ?? "unknown";
    if (
      !safeStorage.isEncryptionAvailable() ||
      ["basic_text", "unknown"].includes(backend)
    )
      return fail(`safeStorage が keyring を使えない（backend ${backend}）`);
    const store = JSON.parse(readFileSync(args.store, "utf8"));
    const accounts = store?.[args.service];
    const cipher =
      accounts && typeof accounts === "object"
        ? accounts["grimodex-user"]
        : null;
    if (typeof cipher !== "string")
      return fail(`${args.service}／grimodex-user の key が無い`);
    const key = safeStorage.decryptString(Buffer.from(cipher, "base64")).trim();
    if (
      !key.startsWith(args.prefix) ||
      key.length < 40 ||
      key.length > 300 ||
      /\s/u.test(key)
    )
      return fail("復号した key の形式（接頭辞と長さ）が想定と違う");
    await writeKeyToFifo(args.fifo, key);
    process.stdout.write(`[product-key] ok backend=${backend}\n`);
    exit(0);
  } catch (error) {
    fail(
      `復号または受け渡しに失敗（${error?.code ?? error?.name ?? "error"}）`,
    );
  }
});
