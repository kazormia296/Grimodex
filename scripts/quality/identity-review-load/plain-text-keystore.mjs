// 測定 B の本測定の Electron で、safeStorage の basic_text を認める上書きとその条件（事前登録 §17.6）。
// electron を import しない（試験できるように、electron-observer-b.mjs から分けた）。
import assert from "node:assert/strict";
import { realpathSync, statSync } from "node:fs";
import path from "node:path";

/** 上書きしてよい条件（純関数。試験が使う）。違えば例外（値は載せない）。 */
export function assertPlainTextKeystoreAllowed(
  env,
  { fs = { realpathSync, statSync } } = {},
) {
  assert.equal(
    env.GRIMODEX_IDL_PLAIN_TEXT_KEYSTORE,
    "1",
    "[precheck] PLAIN_TEXT_KEYSTORE_NOT_REQUESTED",
  );
  const userData = env.GRIMODEX_USER_DATA_DIR ?? "";
  const runRoot = env.GRIMODEX_IDL_RUN_ROOT ?? "";
  assert.ok(
    path.isAbsolute(userData) && path.isAbsolute(runRoot),
    "[precheck] PLAIN_TEXT_KEYSTORE_PATHS userData and run root must be absolute",
  );
  const info = fs.statSync(userData);
  assert.ok(
    info.isDirectory() && (info.mode & 0o077) === 0,
    "[precheck] PLAIN_TEXT_KEYSTORE_MODE userData must be a 0700 directory",
  );
  const rel = path.relative(
    fs.realpathSync(runRoot),
    fs.realpathSync(userData),
  );
  assert.ok(
    rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel),
    "[precheck] PLAIN_TEXT_KEYSTORE_ROOT userData must be under the launcher run root",
  );
}

/** safeStorage を上書きする。本物の backend の関数を返す。 */
export function installPlainTextKeystore(storage, env) {
  assertPlainTextKeystoreAllowed(env);
  const real = storage.getSelectedStorageBackend.bind(storage);
  storage.setUsePlainTextEncryption(true);
  storage.getSelectedStorageBackend = () => {
    const backend = real();
    return backend === "basic_text" ? "idl_plain_text_override" : backend;
  };
  return real;
}
