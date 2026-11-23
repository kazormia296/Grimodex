// 測定 B の本測定の Electron の起動 script（事前登録 §17.6）。共有の electron-observer.mjs を包む。
//
// 製品の keyStore.ts は Linux の safeStorage の backend が basic_text だと API key の保存を拒む
// （requireSecureStorage。isEncryptionAvailable も basic_text では false）。測定の Electron は隔離した bus で動き、
// secret service が無いので backend は basic_text になる。作者の決定（§17.6）により、0700 の一時的な userData に
// 限ってこれを認める。製品のコードは変えず、この process の safeStorage だけを次のとおり上書きする。
//   - setUsePlainTextEncryption(true)（basic_text の in-memory の鍵で暗号化する。isEncryptionAvailable が true になる）
//   - getSelectedStorageBackend が basic_text のとき、製品の拒否を通すため basic_text 以外の名前を返す
// 本物の backend の名前は globalThis.idlRealStorageBackend() で読む（記録にはこちらの値を使う）。
//
// 上書きの条件（どれかが欠ければ上書きせず、この process を止める）：
//   - 環境変数 GRIMODEX_IDL_PLAIN_TEXT_KEYSTORE=1（本測定の launcher が立てる。A・乾いた実行・目録では立てない）
//   - GRIMODEX_USER_DATA_DIR が絶対 path で 0700 の dir
//   - GRIMODEX_IDL_RUN_ROOT（launcher の一時 root＝<output>/run）の下にあること
// backend の名前の上書きは、本物の backend が basic_text のときだけ（それ以外の backend の名前は変えずに返す）。
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { safeStorage } from "electron";
import { installPlainTextKeystore } from "./plain-text-keystore.mjs";

if (process.env.GRIMODEX_IDL_PLAIN_TEXT_KEYSTORE === "1") {
  globalThis.idlRealStorageBackend = installPlainTextKeystore(
    safeStorage,
    process.env,
  );
}

const observer = path.resolve(
  import.meta.dirname,
  "../nir1-retrieval/electron-observer.mjs",
);
await import(pathToFileURL(observer).href);
