/**
 * CP-2b P2 の packaged smoke の子 process の起動と終了（cp2b-decisions §8.4 の owner／lifecycle matrix）。
 *
 * - 起動は `launchOwned()` の 1 か所。POSIX は新しい process group（`detached: true`）、Windows は通常の子（tree は `taskkill /T`）。
 *   Linux は `scripts/local-ci-xvfb.mjs` を host の namespace で前に置ける（`unshare` を使わない）。
 * - 終了は `terminateOwned()`。graceful（POSIX は owner の pid に SIGTERM、Windows は `taskkill /PID <pid> /T`）→ 期限で強制
 *   （POSIX は process group に SIGKILL、Windows は `taskkill /PID <pid> /T /F`）→ 証拠の確認。
 * - 終了の証拠は kill の要求ではなく、(1) 直接の子の `close`、(2) POSIX は process group が消えたこと（`kill(-pgid, 0)` が ESRCH）、
 *   (3) 実行体の dir の下の実行ファイルを持つ process が 0（Linux は `/proc/<pid>/exe`、読めない〔EACCES。sandbox の子など
 *   non-dumpable〕ときは `/proc/<pid>/cmdline` の argv[0]、macOS は `ps -axww -o pid=,args=` の先頭、Windows は
 *   `Get-CimInstance Win32_Process` の `ExecutablePath`）。path で見つけた process は kill しない（他人の process を殺さない）。報告だけで、
 *   残っていれば `ok: false`。走査できなければ null（観測できない＝証明にならない）。
 * - Windows は直接の子の exit を見た後に pid で `taskkill` を送らない（pid の再利用で無関係な process を殺しうる）。
 * - 観測と kill の関数は `deps` で差し替えられる（試験が配線を確かめる）。
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const OUTPUT_LIMIT = 64 * 1024;

const defaultProc = {
  list: () => fs.readdirSync("/proc"),
  exe: (pid) => fs.readlinkSync(`/proc/${pid}/exe`),
  cmdline: (pid) => fs.readFileSync(`/proc/${pid}/cmdline`, "latin1"),
};
const defaultExec = (command, args, options) => execFileSync(command, args, options);

/**
 * 実行体の dir の下の実行ファイルを持つ process の pid（自分自身は除く）。走査できない OS・失敗は null。
 * options.proc（Linux の /proc の読取）と options.exec（macOS／Windows の command）は試験が差し替える。
 */
export function processesUnder(dir, platform = process.platform, { proc = defaultProc, exec = defaultExec } = {}) {
  const root = path.resolve(dir);
  const inside = (file) => typeof file === "string" && file.length > 0 && path.resolve(file).startsWith(root + path.sep);
  try {
    if (platform === "linux") {
      const out = [];
      for (const name of proc.list()) {
        if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
        let exe = null;
        try {
          exe = proc.exe(name).replace(/ \(deleted\)$/, "");
        } catch (error) {
          if (error?.code === "ENOENT" || error?.code === "ESRCH") continue; // 走査の間に終わった
          // EACCES など: non-dumpable な子（Chromium の sandbox の子など）は exe を読めない。cmdline の argv[0] で照合する
          try {
            exe = proc.cmdline(name).split("\0")[0];
          } catch {
            continue; // cmdline も読めない（hidepid など）。この pid は判断できない。group の消滅の確認が担う
          }
        }
        if (inside(exe)) out.push(Number(name));
      }
      return out;
    }
    if (platform === "darwin") {
      // args（-ww で切り詰めない）の先頭は実行体の path（Chromium は macOS で argv を書き換えない）
      const text = exec("ps", ["-axww", "-o", "pid=,args="], { encoding: "utf8", timeout: 30_000 });
      return String(text).split("\n").map((line) => /^\s*(\d+)\s+(.+)$/.exec(line)).filter(Boolean)
        .filter((match) => Number(match[1]) !== process.pid && match[2].trim().startsWith(root + path.sep))
        .map((match) => Number(match[1]));
    }
    if (platform === "win32") {
      const script = "Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($env:GRIMODEX_SMOKE_DIR + '\\', [System.StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { $_.ProcessId }";
      const text = exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
        encoding: "utf8", timeout: 60_000, env: { ...process.env, GRIMODEX_SMOKE_DIR: root }, windowsHide: true,
      });
      return String(text).split(/\r?\n/).map((line) => line.trim()).filter((line) => /^\d+$/.test(line)).map(Number)
        .filter((pid) => pid !== process.pid);
    }
  } catch {
    return null;
  }
  return null;
}

/** POSIX の process group が残っているか（ESRCH で消えた。EPERM は残っている扱い） */
export function groupAlive(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

/**
 * 子を起動して owner を返す。owner は close の結果と出力の末尾を持つ。
 * options: { command, args, env, cwd, exeDir, label, platform }
 */
export function launchOwned({ command, args, env, cwd, exeDir, label, platform = process.platform, windowsHide = false }) {
  const posix = platform !== "win32";
  // GUI の実行体は windowsHide にしない（SW_HIDE で最初の窓が隠れ、隠れた窓の timer の間引きで行の時間が伸びうる）
  const child = spawn(command, args, {
    env,
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    detached: posix,
    windowsHide,
  });
  let output = "";
  const append = (chunk) => {
    output += chunk;
    if (output.length > OUTPUT_LIMIT) output = output.slice(-OUTPUT_LIMIT);
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  let closed = null;
  let spawnError = null;
  const exited = new Promise((resolve) => {
    child.once("error", (error) => { spawnError = String(error?.message ?? error); });
    child.once("close", (code, signal) => {
      closed = { code, signal, at: Date.now() };
      resolve(closed);
    });
  });
  return {
    label,
    platform,
    child,
    pid: child.pid ?? null,
    pgid: posix ? child.pid ?? null : null,
    exeDir,
    startedAt: Date.now(),
    exited,
    isAlive: () => closed == null && spawnError == null,
    closed: () => closed,
    spawnError: () => spawnError,
    output: () => output,
  };
}

/**
 * promise が ms 以内に解決すれば true。timer は解決した時点で止める（残った timer が harness の終了を待たせない）。
 */
export function settlesWithin(promise, ms) {
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(false), ms); });
  return Promise.race([promise.then(() => true), timeout]).finally(() => clearTimeout(timer));
}

async function waitClosed(owner, ms) {
  if (owner.closed()) return true;
  return settlesWithin(owner.exited, ms);
}

function taskkill(pid, force) {
  try {
    execFileSync("taskkill", ["/PID", String(pid), "/T", ...(force ? ["/F"] : [])], { stdio: "ignore", timeout: 30_000, windowsHide: true });
    return "requested";
  } catch (error) {
    return `taskkill-failed:${error?.status ?? error?.code ?? "?"}`;
  }
}

/**
 * 終了の証拠がそろったか: close を見た、POSIX の process group が消えた（Windows は null）、実行体の dir の下の process を
 * 観測できて 0。どれか 1 つでも欠ければ false（kill の要求や close だけを証拠にしない）。
 */
export function terminationProven({ isClosed, groupGone, residual }) {
  return isClosed === true && groupGone !== false && Array.isArray(residual) && residual.length === 0;
}

const defaultDeps = {
  groupAlive,
  processesUnder,
  killPid: (pid, signal) => process.kill(pid, signal),
  killGroup: (pgid, signal) => process.kill(-pgid, signal),
  taskkill,
};

/**
 * 終了させて証拠を返す。戻り値: { ok, steps, closed, groupGone, residual, forced }
 * ok は「close を見た」かつ「group が消えた（POSIX）」かつ「実行体の dir の下の process が 0」（`terminationProven`）。
 * deps（groupAlive、processesUnder、killPid、killGroup、taskkill）は試験が差し替える。
 */
export async function terminateOwned(owner, { graceMs = 15_000, forceMs = 10_000, settleMs = 5_000, deps = {} } = {}) {
  const use = { ...defaultDeps, ...deps };
  const steps = [];
  let forced = false;
  if (owner.pid == null) {
    return { ok: false, steps: ["spawn-failed"], closed: owner.closed(), groupGone: null, residual: [], forced, spawnError: owner.spawnError() };
  }
  const posix = owner.platform !== "win32";
  if (owner.isAlive()) {
    if (posix) {
      try { use.killPid(owner.pid, "SIGTERM"); steps.push("SIGTERM(pid)"); } catch (error) { steps.push(`SIGTERM-failed:${error?.code}`); }
    } else {
      steps.push(`taskkill /T:${use.taskkill(owner.pid, false)}`);
    }
  } else {
    steps.push("already-closed");
  }
  let isClosed = await waitClosed(owner, graceMs);
  const groupStillAlive = () => posix && owner.pgid != null && use.groupAlive(owner.pgid);
  if (!isClosed || groupStillAlive()) {
    forced = true;
    if (posix) {
      // process group は直接の子が作った自分のもの（detached）。group を抜けた process には届かない
      try { use.killGroup(owner.pgid, "SIGKILL"); steps.push("SIGKILL(group)"); } catch (error) { steps.push(`SIGKILL-failed:${error?.code}`); }
    } else if (!isClosed) {
      // exit を見た後は pid が再利用されうるので送らない（孤児は下の走査が残存として報告する）
      steps.push(`taskkill /T /F:${use.taskkill(owner.pid, true)}`);
    }
    isClosed = await waitClosed(owner, forceMs);
  }
  // group と実行体の dir の下の process が消えるのを有限に待つ（close の後も孫が残りうる）。path で見つけた process は kill しない
  const scan = () => (owner.exeDir ? use.processesUnder(owner.exeDir, owner.platform) : null);
  let groupGone = posix ? !groupStillAlive() : null;
  let residual = scan();
  const deadline = Date.now() + settleMs;
  while ((groupGone === false || (residual?.length ?? 0) > 0) && Date.now() < deadline) {
    await sleep(250);
    groupGone = posix ? !groupStillAlive() : null;
    residual = scan();
  }
  const ok = terminationProven({ isClosed, groupGone, residual });
  return { ok, steps, closed: owner.closed(), groupGone, residual, residualObservable: Array.isArray(residual), forced };
}
