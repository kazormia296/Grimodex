// 診断（diagnostic only）専用。製品（packaged の Grimodex）がユーザーの profile に safeStorage で
// 暗号化して保存した Anthropic の API key を、app 名 "Grimodex" の Electron の中で復号し、
// launcher（run.mjs）が作った FIFO に 1 回だけ書く（fifo-key.mjs）。平文はディスクに残さない。
//
// - 製品の ai-keys.json は読むだけ（書かない）。userData は使い捨ての一時 dir。
// - key の値・長さは出さない。出すのは成否と safeStorage の backend だけ。
// - PD 評価の harness（fusion-slot-eval/product-key-to-fifo.mjs）と同じ方式で、service は
//   grimodex-anthropic に固定する。
//
// 使い方: electron product-key-to-fifo.mjs --store <ai-keys.json> --fifo <path>
import { app, safeStorage } from "electron";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { Buffer } from "node:buffer";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { writeKeyToFifo } from "./fifo-key.mjs";

const SERVICE = "grimodex-anthropic";
const PREFIX = "sk-ant-";

function parse(argv) {
  const at = argv.indexOf("--store");
  const args = {};
  for (let i = at; at >= 0 && i + 1 < argv.length; i += 2)
    args[argv[i].replace(/^--/u, "")] = argv[i + 1];
  return args;
}
const args = parse(process.argv);
let scratch = null;
const exit = (code) => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  app.exit(code);
};
const fail = (message) => {
  process.stderr.write(`[product-key] ${message}\n`);
  exit(1);
};

if (path.basename(args.store ?? "") !== "ai-keys.json" || !args.fifo) {
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
    const accounts = store?.[SERVICE];
    const cipher =
      accounts && typeof accounts === "object"
        ? accounts["grimodex-user"]
        : null;
    if (typeof cipher !== "string")
      return fail(`${SERVICE}／grimodex-user の key が無い`);
    const key = safeStorage.decryptString(Buffer.from(cipher, "base64")).trim();
    if (
      !key.startsWith(PREFIX) ||
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
