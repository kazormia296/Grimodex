/**
 * CP-2b P2 の packaged smoke の子 process の起動と終了（cp2b-decisions §8.4 の owner／lifecycle matrix）。
 *
 * - 起動は `launchOwned()` の 1 か所。POSIX は新しい process group（`detached: true`）、Windows は通常の子（tree は `taskkill /T`）。
 *   Linux は `scripts/local-ci-xvfb.mjs` を host の namespace で前に置ける（`unshare` を使わない）。
 * - 終了は `terminateOwned()`。graceful（POSIX は owner の pid に SIGTERM、Windows は `taskkill /PID <pid> /T`）→ 期限で強制
 *   （POSIX は process group に SIGKILL、Windows は `taskkill /PID <pid> /T /F`）→ 証拠の確認。
 * - 終了の証拠は kill の要求ではなく、(1) 直接の子の `close`、(2) POSIX は process group が消えたこと（`kill(-pgid, 0)` が ESRCH）、
 *   (3) 実行体の dir の下の実行ファイルを持つ process が 0（Linux は `/proc/<pid>/exe`、macOS は `ps -axo pid=,comm=`、Windows は
 *   `Get-CimInstance Win32_Process` の `ExecutablePath`）。path で見つけた process は kill しない（他人の process を殺さない）。報告だけで、
 *   残っていれば `ok: false`。
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const OUTPUT_LIMIT = 64 * 1024;

/** 実行体の dir の下の実行ファイルを持つ process の pid（自分自身は除く）。見られない OS は null */
export function processesUnder(dir, platform = process.platform) {
  const root = path.resolve(dir);
  const inside = (file) => {
    const resolved = path.resolve(file);
    return platform === "win32"
      ? resolved.toLowerCase().startsWith(root.toLowerCase() + path.sep)
      : resolved.startsWith(root + path.sep);
  };
  try {
    if (platform === "linux") {
      const out = [];
      for (const name of fs.readdirSync("/proc")) {
        if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
        let exe;
        try { exe = fs.readlinkSync(`/proc/${name}/exe`); } catch { continue; }
        if (inside(exe.replace(/ \(deleted\)$/, ""))) out.push(Number(name));
      }
      return out;
    }
    if (platform === "darwin") {
      const text = execFileSync("ps", ["-axo", "pid=,comm="], { encoding: "utf8", timeout: 30_000 });
      return text.split("\n").map((line) => /^\s*(\d+)\s+(.+)$/.exec(line)).filter(Boolean)
        .filter((match) => Number(match[1]) !== process.pid && inside(match[2].trim()))
        .map((match) => Number(match[1]));
    }
    if (platform === "win32") {
      const script = "Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($env:GRIMODEX_SMOKE_DIR + '\\', [System.StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { $_.ProcessId }";
      const text = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
        encoding: "utf8", timeout: 60_000, env: { ...process.env, GRIMODEX_SMOKE_DIR: root }, windowsHide: true,
      });
      return text.split(/\r?\n/).map((line) => line.trim()).filter((line) => /^\d+$/.test(line)).map(Number)
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
export function launchOwned({ command, args, env, cwd, exeDir, label, platform = process.platform }) {
  const posix = platform !== "win32";
  const child = spawn(command, args, {
    env,
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    detached: posix,
    windowsHide: true,
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

async function waitClosed(owner, ms) {
  if (owner.closed()) return true;
  return Promise.race([owner.exited.then(() => true), sleep(ms).then(() => false)]);
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

/**
 * 終了させて証拠を返す。戻り値: { ok, steps, closed, groupGone, residual, forced }
 * ok は「close を見た」かつ「group が消えた（POSIX）」かつ「実行体の dir の下の process が 0」。
 */
export async function terminateOwned(owner, { graceMs = 15_000, forceMs = 10_000, settleMs = 5_000 } = {}) {
  const steps = [];
  let forced = false;
  if (owner.pid == null) {
    return { ok: false, steps: ["spawn-failed"], closed: owner.closed(), groupGone: null, residual: [], forced, spawnError: owner.spawnError() };
  }
  const posix = owner.platform !== "win32";
  if (owner.isAlive()) {
    if (posix) {
      try { process.kill(owner.pid, "SIGTERM"); steps.push("SIGTERM(pid)"); } catch (error) { steps.push(`SIGTERM-failed:${error?.code}`); }
    } else {
      steps.push(`taskkill /T:${taskkill(owner.pid, false)}`);
    }
  } else {
    steps.push("already-closed");
  }
  let isClosed = await waitClosed(owner, graceMs);
  const groupStillAlive = () => posix && owner.pgid != null && groupAlive(owner.pgid);
  if (!isClosed || groupStillAlive()) {
    forced = true;
    if (posix) {
      try { process.kill(-owner.pgid, "SIGKILL"); steps.push("SIGKILL(group)"); } catch (error) { steps.push(`SIGKILL-failed:${error?.code}`); }
    } else {
      steps.push(`taskkill /T /F:${taskkill(owner.pid, true)}`);
    }
    isClosed = await waitClosed(owner, forceMs);
  }
  // group と実行体の dir の下の process が消えるのを有限に待つ（close の後も孫が残りうる）
  let groupGone = posix ? !groupStillAlive() : null;
  let residual = owner.exeDir ? processesUnder(owner.exeDir, owner.platform) : [];
  const deadline = Date.now() + settleMs;
  while ((groupGone === false || (residual?.length ?? 0) > 0) && Date.now() < deadline) {
    await sleep(250);
    groupGone = posix ? !groupStillAlive() : null;
    residual = owner.exeDir ? processesUnder(owner.exeDir, owner.platform) : [];
  }
  const ok = terminationProven({ isClosed, groupGone, residual });
  return { ok, steps, closed: owner.closed(), groupGone, residual, residualObservable: Array.isArray(residual), forced };
}
