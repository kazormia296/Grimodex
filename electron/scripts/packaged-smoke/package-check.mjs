/**
 * CP-2b P2 の packaged smoke の package の検査（cp2b-decisions DR-CP2B-P2-8。TASK §3 の 1 と 3）。
 *
 * 合否に使うもの: (a) 同梱の worker（`resources/bin/nir1-c-query-worker[.exe]`）が存在し、通常 file、POSIX で実行可能、
 * seam の文字列（`NIR1_C_QUERY_TEST_`）を含まない（P1 の `verifyReleaseGraphWorker` をそのまま使う）、(b) `app.asar` の file 一覧に
 * harness・canary・攻撃 JS・名前解決の記録層・probe の file が無い。
 * 記録だけのもの: Windows の worker の PE subsystem、macOS の `codesign --verify`（A 案の無署名の `--dir` では意味がない）。
 * env 名の数と Windows の console window は観測しない（gate が閉じていて製品の経路で spawn できない。DR-CP2B-P2-8）。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { graphWorkerName, verifyReleaseGraphWorker } from "../verify-release-graph-worker.mjs";

/** app.asar に入ってはならない file の名前（harness と probe の道具） */
export const FORBIDDEN_ASAR_ENTRY = /packaged-smoke|webrtc-block-probe|renderer-isolation-probe|dnslog|doh-canary|dns-canary/i;

/**
 * asar の header（先頭 16 bytes の pickle の後の JSON）を読み、file の path の一覧を返す。
 * 形: uint32 4、uint32 header の pickle の大きさ、uint32 pickle の payload、uint32 JSON の長さ、JSON。
 */
export function listAsarEntries(file) {
  const fd = fs.openSync(file, "r");
  try {
    const head = Buffer.alloc(16);
    if (fs.readSync(fd, head, 0, 16, 0) !== 16) throw new Error("asar の header が短い");
    const jsonLength = head.readUInt32LE(12);
    if (jsonLength <= 0 || jsonLength > 64 * 1024 * 1024) throw new Error(`asar の header の長さが不正: ${jsonLength}`);
    const json = Buffer.alloc(jsonLength);
    if (fs.readSync(fd, json, 0, jsonLength, 16) !== jsonLength) throw new Error("asar の header の JSON が短い");
    const header = JSON.parse(json.toString("utf8"));
    const out = [];
    const walk = (node, prefix) => {
      for (const [name, child] of Object.entries(node.files ?? {})) {
        const entry = prefix ? `${prefix}/${name}` : name;
        if (child && typeof child === "object" && child.files) walk(child, entry);
        else out.push(entry);
      }
    };
    walk(header, "");
    return out.sort();
  } finally {
    fs.closeSync(fd);
  }
}

/** PE の Optional Header の Subsystem（2 = GUI、3 = console）。PE でなければ null */
export function peSubsystem(file) {
  const buffer = fs.readFileSync(file);
  if (buffer.length < 0x40 || buffer.toString("latin1", 0, 2) !== "MZ") return null;
  const peOffset = buffer.readUInt32LE(0x3c);
  if (peOffset + 24 + 70 > buffer.length || buffer.toString("latin1", peOffset, peOffset + 4) !== "PE\0\0") return null;
  const subsystem = buffer.readUInt16LE(peOffset + 24 + 68);
  return { value: subsystem, name: subsystem === 2 ? "windows-gui" : subsystem === 3 ? "windows-console" : `other:${subsystem}` };
}

/** package の resources の dir（Linux／Windows は <app>/resources、macOS は <bundle>/Contents/Resources） */
export function resourcesDirOf(appDir, platform = process.platform) {
  return platform === "darwin" ? path.join(appDir, "Contents", "Resources") : path.join(appDir, "resources");
}

export async function checkPackage({ appDir, platform = process.platform }) {
  const resources = resourcesDirOf(appDir, platform);
  const failures = [];
  const recorded = {};
  const worker = path.join(resources, "bin", graphWorkerName(platform));
  try {
    await verifyReleaseGraphWorker(worker, platform);
    recorded.worker = { path: path.relative(appDir, worker).split(path.sep).join("/"), verified: true, bytes: fs.statSync(worker).size };
  } catch (error) {
    failures.push(`worker: ${String(error?.message ?? error)}`);
    recorded.worker = { path: path.relative(appDir, worker).split(path.sep).join("/"), verified: false };
  }
  if (platform === "win32" && fs.existsSync(worker)) recorded.workerPeSubsystem = peSubsystem(worker);
  if (platform === "darwin") {
    try {
      execFileSync("codesign", ["--verify", "--strict", "--verbose=2", appDir], { stdio: "pipe", timeout: 120_000 });
      recorded.codesign = "verified";
    } catch (error) {
      recorded.codesign = `not-verified:${String(error?.stderr ?? error?.message ?? error).split("\n")[0].slice(0, 160)}`;
    }
  }
  const asar = path.join(resources, "app.asar");
  try {
    const entries = listAsarEntries(asar);
    const forbidden = entries.filter((entry) => FORBIDDEN_ASAR_ENTRY.test(entry));
    recorded.asar = { entries: entries.length, forbidden };
    if (entries.length === 0) failures.push("app.asar: file が 0（走査が何も見ていない）");
    if (forbidden.length) failures.push(`app.asar に harness／probe の file: ${forbidden.slice(0, 5).join(", ")}`);
  } catch (error) {
    failures.push(`app.asar: ${String(error?.message ?? error)}`);
  }
  return { ok: failures.length === 0, failures, recorded };
}
