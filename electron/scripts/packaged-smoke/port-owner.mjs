/**
 * CP-2b P2 の packaged smoke: CDP の port を owned の process tree が listen しているかの確認（security レビューの E）。
 *
 * harness は空いている port を選んで閉じてから `--remote-debugging-port` に渡すので、その間に別の process が port を取りうる。
 * 攻撃 JS を別の Grimodex（利用者の app など）に注入しないよう、注入の前に listen している pid を OS の道具で引き、owner の
 * process group（POSIX）か owner の pid／実行体の dir（Windows）に属することを確かめる。確かめられなければ owned: false（注入しない）。
 *   Linux: `ss -ltnpH "sport = :<port>"` の `pid=`（pid の無い listen の行があれば失敗）、`/proc/<pid>/stat` の pgrp
 *   macOS: `lsof -nP -iTCP:<port> -sTCP:LISTEN -F pn`、`netstat -an -p tcp` の listen の数との照合、`ps -o pgid= -p <pid>`
 *   Windows: `Get-NetTCPConnection -LocalPort <port> -State Listen` の OwningProcess、`Win32_Process` の ExecutablePath
 * exec と readStat は試験が差し替える。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const run = (command, args) => execFileSync(command, args, { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
const readProcStat = (pid) => fs.readFileSync(`/proc/${pid}/stat`, "utf8");

/** `/proc/<pid>/stat` の pgrp（comm の括弧の後ろの 3 番目） */
export function pgrpFromStat(text) {
  const after = String(text).slice(String(text).lastIndexOf(")") + 2).split(" ");
  const pgrp = Number(after[2]);
  return Number.isInteger(pgrp) ? pgrp : null;
}

export function listeningPids(port, platform, exec = run) {
  if (platform === "linux") {
    const lines = String(exec("ss", ["-ltnpH", `sport = :${port}`])).split("\n").filter((line) => line.trim().length > 0);
    // ss は別の利用者の socket に pid を出さない。pid の無い listen の行が 1 つでもあれば、誰の socket か分からない（fail-safe）
    if (lines.some((line) => !/pid=\d+/.test(line))) throw new Error("pid の分からない listen の socket がある");
    return [...new Set(lines.flatMap((line) => [...line.matchAll(/pid=(\d+)/g)].map((match) => Number(match[1]))))];
  }
  if (platform === "darwin") {
    // lsof は見えない（別の利用者の）socket を出さない。netstat の listen の数が lsof の socket の数より多ければ fail-safe で失敗
    const sockets = String(exec("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-F", "pn"])).split("\n");
    const pids = [];
    let current = null;
    let socketCount = 0;
    for (const line of sockets) {
      if (line.startsWith("p")) current = Number(line.slice(1));
      if (line.startsWith("n")) { socketCount += 1; if (Number.isInteger(current)) pids.push(current); }
    }
    const listening = String(exec("netstat", ["-an", "-p", "tcp"])).split("\n")
      .filter((line) => /LISTEN/.test(line) && new RegExp(`[.:]${Number(port)}\\s`).test(line)).length;
    if (listening > socketCount) throw new Error(`pid の分からない listen の socket がある（netstat ${listening}、lsof ${socketCount}）`);
    return [...new Set(pids)];
  }
  if (platform === "win32") {
    const text = exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      `Get-NetTCPConnection -LocalPort ${Number(port)} -State Listen | ForEach-Object { $_.OwningProcess }`]);
    return [...new Set(String(text).split(/\r?\n/).map((line) => line.trim()).filter((line) => /^\d+$/.test(line)).map(Number))];
  }
  return [];
}

function windowsExecutable(pid, exec) {
  return String(exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").ExecutablePath`])).trim();
}

/** 戻り値: { owned, pids, reason } */
export function verifyCdpPortOwner({ port, owner, platform = process.platform, exec = run, readStat = readProcStat }) {
  let pids;
  try {
    pids = listeningPids(port, platform, exec);
  } catch (error) {
    return { owned: false, pids: [], reason: `listen している process を引けない（${String(error?.code ?? error?.message ?? error).slice(0, 80)}）` };
  }
  if (pids.length === 0) return { owned: false, pids, reason: "listen している process が見つからない" };
  for (const pid of pids) {
    if (pid === owner.pid) continue;
    try {
      if (platform === "win32") {
        const exe = windowsExecutable(pid, exec);
        const root = path.resolve(owner.exeDir ?? "");
        if (!(owner.exeDir && exe.toLowerCase().startsWith(root.toLowerCase() + path.sep))) return { owned: false, pids, reason: `pid ${pid} の実行体が owner の dir の外` };
      } else {
        const pgrp = platform === "linux" ? pgrpFromStat(readStat(pid)) : Number(String(exec("ps", ["-o", "pgid=", "-p", String(pid)])).trim());
        if (owner.pgid == null || pgrp !== owner.pgid) return { owned: false, pids, reason: `pid ${pid} の process group（${pgrp}）が owner（${owner.pgid}）と違う` };
      }
    } catch (error) {
      return { owned: false, pids, reason: `pid ${pid} の所属を確かめられない（${String(error?.code ?? error?.message ?? error).slice(0, 80)}）` };
    }
  }
  return { owned: true, pids, reason: "owned" };
}
