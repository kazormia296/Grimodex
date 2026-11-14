// 測定 B の key の復号の helper にだけ渡す「本物の session の env」の控えと受け渡し（事前登録 §17.6）。
//
// 測定の Electron・A・名簿・目録の process は、隔離した bus（dbus-run-session と launcher の隔離 bus）の env で動く。
// key の取り出し（製品の ai-keys.json の復号）だけは、本物の OS の鍵の保管庫に届く env の別 process（helper）が行う。
// launcher は dbus-run-session の中で起動されるので、本物の bus の address は launcher の process.env に残らない。
// そのため、起動する人の本物の session で外側の script（launch-measure-b.mjs）が env を許可リストで控え、
// FIFO（0700 の dir の 0600）で launcher に 1 回だけ渡す。launcher はメモリにだけ持つ（file・記録・出力に出さない）。
// 値は表示・記録しない（エラーにも載せない）。
import { existsSync, mkdirSync, rmdirSync } from "node:fs";
import path from "node:path";
import {
  makeKeyFifo,
  readKeyFromFifo,
  writeKeyToFifo,
} from "../chronicle-prompt-cache-diag/fifo-key.mjs";

/**
 * helper に渡す名前の許可リスト。keyring の backend の選択（XDG_CURRENT_DESKTOP など）と bus への到達に要るものだけ。
 * Wayland の変数・XDG_SESSION_TYPE・偽 AI の env・API key の env は入れない。
 */
export const REAL_ENV_NAMES = Object.freeze([
  "DBUS_SESSION_BUS_ADDRESS",
  "XDG_RUNTIME_DIR",
  "XDG_CURRENT_DESKTOP",
  "XDG_SESSION_DESKTOP",
  "DESKTOP_SESSION",
  "KDE_FULL_SESSION",
  "KDE_SESSION_VERSION",
  "GNOME_DESKTOP_SESSION_ID",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CONFIG_DIRS",
  "XDG_DATA_DIRS",
  "HOME",
  "USER",
  "LOGNAME",
  "PATH",
  "LANG",
  "LC_ALL",
  "DISPLAY",
  "XAUTHORITY",
]);

/** env から許可リストの名前だけを控える（値は返す側に渡すだけ）。 */
export function pickRealEnv(env) {
  const out = {};
  for (const name of REAL_ENV_NAMES)
    if (typeof env?.[name] === "string" && env[name] !== "")
      out[name] = env[name];
  return out;
}

/** エラーの文面に載せられる理由の code だけ。値は載せない。 */
function realBusError(reason) {
  return new Error(
    `[precheck] REAL_BUS_MISSING ${reason} the real session bus env is not available to the key helper`,
  );
}

/**
 * 控えた env が本物の session bus を指していること。無い・隔離 bus と同じ・socket が無いときは止める
 * （key を読まない）。isolatedAddresses は launcher 自身の bus（dbus-run-session）と隔離 bus の address。
 */
export function assertRealBusEnv(env, { isolatedAddresses = [] } = {}) {
  if (!env || typeof env !== "object") throw realBusError("NO_HANDOFF");
  const address = env.DBUS_SESSION_BUS_ADDRESS;
  if (typeof address !== "string" || address === "")
    throw realBusError("NO_ADDRESS");
  if (isolatedAddresses.filter(Boolean).includes(address))
    throw realBusError("SAME_AS_ISOLATED");
  const runtime = env.XDG_RUNTIME_DIR;
  if (typeof runtime !== "string" || !path.isAbsolute(runtime))
    throw realBusError("NO_RUNTIME_DIR");
  // unix:path=<socket> は存在を確かめる。abstract など path の無い形は確かめられないので通す。
  const socket = /^unix:path=([^,;]+)/u.exec(address)?.[1];
  if (socket && !existsSync(socket)) throw realBusError("SOCKET_MISSING");
  return env;
}

/**
 * helper の env を組む（純関数）。控えた env だけから作り、launcher の process.env は混ぜない。
 * ELECTRON_RUN_AS_NODE は外し、Wayland でなく X11（xvfb-run）で動かし、一時 dir は launcher の 0700 の tmp にする。
 */
export function buildHelperEnv(realEnv, { tmpDir } = {}) {
  const env = { ...pickRealEnv(realEnv), ELECTRON_OZONE_PLATFORM_HINT: "x11" };
  delete env.ELECTRON_RUN_AS_NODE;
  if (tmpDir) env.TMPDIR = tmpDir;
  return env;
}

// ---- 外側の script と launcher の受け渡し（FIFO。file に残さない） ----------------------------

/** 外側の script が作る。<output>/real-env/ は 0700。key-fifo-* の探索（findKeyResidue）の対象外にする。 */
export function makeRealEnvFifo(output) {
  const parent = path.join(path.resolve(output), "real-env");
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const made = makeKeyFifo(parent);
  return {
    fifo: made.fifo,
    cleanup: () => {
      made.cleanup();
      try {
        rmdirSync(parent);
      } catch {
        // 空でなければ残す（他の run の FIFO かもしれない）。
      }
    },
  };
}

/** 外側の script：控えた env を FIFO に 1 回だけ書く（launcher が読むまで待つ）。 */
export async function sendRealEnv(fifo, env, { timeoutMs = 120_000 } = {}) {
  await writeKeyToFifo(fifo, JSON.stringify(pickRealEnv(env)), { timeoutMs });
}

/**
 * launcher：FIFO から 1 回だけ受け取る。受け取った env は許可リストで絞り直す。
 * path が無い・読めない・JSON でないときは理由の code だけで止める（値は載せない）。
 */
export async function receiveRealEnv(fifo, { timeoutMs = 30_000 } = {}) {
  if (typeof fifo !== "string" || fifo === "") throw realBusError("NO_HANDOFF");
  let text;
  try {
    text = await readKeyFromFifo(fifo, { timeoutMs });
  } catch {
    throw realBusError("HANDOFF_NOT_RECEIVED");
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw realBusError("HANDOFF_NOT_JSON");
  }
  return pickRealEnv(parsed);
}
