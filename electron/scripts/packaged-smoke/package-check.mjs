/**
 * CP-2b P2 の packaged smoke の package の検査（cp2b-decisions DR-CP2B-P2-8。TASK §3 の 1 と 3）。
 *
 * 合否に使うもの: (a) 同梱の worker（`resources/bin/nir1-c-query-worker[.exe]`）が存在し、通常 file、POSIX で実行可能、
 * seam の文字列（`NIR1_C_QUERY_TEST_`）を含まない（P1 の `verifyReleaseGraphWorker` をそのまま使う）、(b) `app.asar` の file 一覧に
 * harness・canary・攻撃 JS・名前解決の記録層・probe の file が無い、(c) `app.asar` に Mastra の ee 由来の file と、
 * ee 固有の文字列が無い（Mastra 移行 MP-1、脅威モデル D8／T8、計画書の第 4.3 節。bundle の検査は mastra-ee-check.mjs）。
 * 記録だけのもの: Windows の worker の PE subsystem、macOS の `codesign --verify`（A 案の無署名の `--dir` では意味がない）。
 * env 名の数と Windows の console window は観測しない（gate が閉じていて製品の経路で spawn できない。DR-CP2B-P2-8）。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { FORBIDDEN_ASAR_CONTENT, FORBIDDEN_ASAR_ENTRY, checkAsar, forbiddenContent, listAsarEntries, mastraEeEntries } from "../mastra-ee-asar-check.mjs";
import { graphWorkerName, verifyReleaseGraphWorker } from "../verify-release-graph-worker.mjs";

// asar の検査（harness・probe・ee・Mastra の bundle）は release.yml の 3 OS も呼ぶため、
// harness の外の electron/scripts/mastra-ee-asar-check.mjs に置いた（Mastra 移行 MP-3a、DR-MP3-20）。ここは再 export する。
export { FORBIDDEN_ASAR_CONTENT, FORBIDDEN_ASAR_ENTRY, checkAsar, forbiddenContent, listAsarEntries, mastraEeEntries };

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
  const asarResult = checkAsar(path.join(resources, "app.asar"));
  recorded.asar = asarResult.recorded;
  failures.push(...asarResult.failures);
  return { ok: failures.length === 0, failures, recorded };
}
