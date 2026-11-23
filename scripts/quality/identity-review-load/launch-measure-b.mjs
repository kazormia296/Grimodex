// 測定 B の本測定の起動（外側の script。事前登録 §17.6）。起動する人の本物の session（本物の bus がある shell）で実行する。
//
// 役割：本物の session の env（DBUS_SESSION_BUS_ADDRESS・XDG_RUNTIME_DIR など。許可リストだけ）を控え、
// 隔離した env（Wayland の変数・DBUS_SESSION_BUS_ADDRESS を外し、dbus-run-session の下、TMPDIR は <out>/tmp）で
// run-measure-b.mjs を起動し、控えた env を FIFO（<out>/real-env/ の下の 0700 の dir の 0600）で 1 回だけ渡す。
// run-measure-b.mjs はこれをメモリにだけ持ち、key の復号の helper にだけ使う。測定の Electron・A・名簿・目録の process には
// 渡さない。控えた env は file・記録・出力に出さない。本物の bus が無ければ、何も起動せずに止まる（key を読まない）。
// この作業（道具づくり）では実行しない。
//
// 使い方（本測定。--confirm-send は run-measure-b.mjs が検査する）：
//   node scripts/quality/identity-review-load/launch-measure-b.mjs --output <out> -- \
//     --mode trial --trial-work <work> --confirm-send yes-send-to-anthropic \
//     --egress-allow <Anthropic の API の範囲の CIDR,...> [--egress-resolver <loopback でない resolver の IP,...>]
//   （-- の後ろは run-measure-b.mjs の引数。--output はこの script が run-measure-b.mjs にも渡す）
// 本測定の前に、build の直後に record-build-provenance.mjs で出所の記録を取る（run-measure-b.mjs が照合する。F2）。
// 測定の process の中で動く guard の file（renderer.ts など）を変えたら、記録を取り直す（F3a）。
// key を出力しうる env（DEBUG・PWDEBUG・NODE_DEBUG・ELECTRON_ENABLE_LOGGING・ELECTRON_ENABLE_STACK_DUMPING など）と、
// 空でない NODE_OPTIONS（--require・--import・--heapsnapshot-*・--report-*・--inspect ほか、どの項目も。F5 の m-d）が立っていると、
// run-measure-b.mjs が key の前に止まる。実行する shell で外しておく。
// --egress-allow は人が明示する（この道具は Anthropic の IP 範囲を持たない）。無ければ本測定は始まらない。
import console from "node:console";
import process from "node:process";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { registerCleanup } from "./cleanup.mjs";
import { safeErrorSummary } from "./lib.mjs";
import {
  assertRealBusEnv,
  makeRealEnvFifo,
  pickRealEnv,
  sendRealEnv,
} from "./real-env.mjs";

const ROOT = path.resolve(import.meta.dirname, "../../..");

/** 隔離した launcher の env を組む（純関数）。本物の bus・Wayland の変数は外し、TMPDIR を出力 dir の下にする。 */
export function buildIsolatedLauncherEnv(env, output) {
  const out = { ...env };
  for (const name of [
    "WAYLAND_DISPLAY",
    "WAYLAND_SOCKET",
    "XDG_SESSION_TYPE",
    "DBUS_SESSION_BUS_ADDRESS",
  ])
    delete out[name];
  out.ELECTRON_OZONE_PLATFORM_HINT = "x11";
  out.TMPDIR = path.join(path.resolve(output), "tmp");
  return out;
}

/** 子の起動の command と引数（run-measure-b.mjs の起動例と同じ。実際の起動はしない）。 */
export function buildLauncherCommand({ output, passthrough, fifo }) {
  return [
    "dbus-run-session",
    [
      "--",
      "node",
      path.join(ROOT, "scripts/local-ci-xvfb.mjs"),
      "node",
      path.join(ROOT, "scripts/quality/identity-review-load/run-measure-b.mjs"),
      "--output",
      path.resolve(output),
      "--real-env-fifo",
      fifo,
      ...passthrough,
    ],
  ];
}

export function parseLaunchArgs(args) {
  const split = args.indexOf("--");
  const own = split < 0 ? args : args.slice(0, split);
  const passthrough = split < 0 ? [] : args.slice(split + 1);
  if (own.length !== 2 || own[0] !== "--output" || !own[1])
    throw new Error(
      "[precheck] USAGE launch-measure-b.mjs --output <dir> -- <run-measure-b args>",
    );
  if (passthrough.some((a) => a === "--output" || a === "--real-env-fifo"))
    throw new Error(
      "[precheck] USAGE --output and --real-env-fifo are set by this script",
    );
  return { output: own[1], passthrough };
}

async function main() {
  const { output, passthrough } = parseLaunchArgs(process.argv.slice(2));
  // 本物の bus が無ければ、何も起動せずに止まる。
  const realEnv = assertRealBusEnv(pickRealEnv(process.env));
  mkdirSync(path.join(path.resolve(output), "tmp"), {
    recursive: true,
    mode: 0o700,
  });
  const { fifo, cleanup } = makeRealEnvFifo(output);
  const unregister = registerCleanup(cleanup); // kill されても FIFO の dir を残さない
  try {
    const [command, argv] = buildLauncherCommand({ output, passthrough, fifo });
    const child = spawn(command, argv, {
      cwd: ROOT,
      env: buildIsolatedLauncherEnv(process.env, output),
      stdio: "inherit",
    });
    let done = false;
    const exited = new Promise((resolve) => {
      child.on("error", () => resolve(1));
      child.on("exit", (code) => resolve(code ?? 1));
    });
    // launcher が FIFO を開くまで待って 1 回だけ書く。書けなければ launcher が HANDOFF_NOT_RECEIVED で止まる。
    sendRealEnv(fifo, realEnv).catch(() => {
      if (!done)
        console.log(JSON.stringify({ status: "real-env-handoff-failed" }));
    });
    process.exitCode = await exited;
    done = true;
  } finally {
    cleanup();
    unregister();
  }
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  try {
    await main();
  } catch (error) {
    console.log(
      JSON.stringify({ status: "launcher-failed", ...safeErrorSummary(error) }),
    );
    process.exitCode = 1;
  }
}
