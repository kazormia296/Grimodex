/**
 * 配布物の app.asar の検査（Mastra 移行 MP-1 の T8、MP-3a の DR-MP3-20）。
 *
 * packaged smoke（packaged-smoke/package-check.mjs の `checkPackage`）と、release.yml の 3 OS の両方が呼ぶ。
 * release は worker の検証を別の step で持つので、worker を含めずに asar だけを見る入口にした。
 *
 * 合否に使うもの：
 * - asar の file 一覧に harness・canary・攻撃 JS・名前解決の記録層・probe の file が無い。中身に固有の文字列が無い。
 * - Mastra の ee 由来の file（.js／.cjs／.map／.d.ts を問わず）と ee 固有の文字列が無い（bundle の検査は mastra-ee-check.mjs）。
 * - 3 つ目の bundle `dist-electron/mastra-agent.cjs` が有り、`.map` が無い。
 * 記録だけ：`@mastra/` の file が asar にあるか（bundle に入るだけで node_modules は載らない）。
 *
 * 使い方：`node electron/scripts/mastra-ee-asar-check.mjs <app.asar を探す dir>`（release/electron など）。
 * dir の下の `resources/app.asar`（macOS は `Contents/Resources/app.asar`）を全部検査し、1 つも無ければ失敗する。
 * 依存を持たない。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { EE_CONTENT_MARKERS, EE_INPUT } from "./mastra-ee-patterns.mjs";

/** asar に入っているべき 3 つ目の bundle と、あってはならない .map。 */
export const ASAR_MASTRA_AGENT_ENTRY = "dist-electron/mastra-agent.cjs";

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

/** app.asar の中身（bytes）に現れてはならない harness・probe の固有の文字列（製品の bundle に harness の code が混ざったら検出） */
export const FORBIDDEN_ASAR_CONTENT = Object.freeze([
  "dnsprobe.test", "probe.test:", "webrtc-block-probe", "renderer-isolation-probe", "packaged-smoke", "PROBE_DNSLOG", "PROBE_RENDERER_SCRIPT", "form-submit-shim",
]);

/** file の bytes に含まれる禁止の文字列（chunk の境界をまたぐ一致も見る） */
export function forbiddenContent(file, needles = FORBIDDEN_ASAR_CONTENT) {
  const encoded = needles.map((needle) => Buffer.from(needle, "latin1"));
  const longest = Math.max(...encoded.map((needle) => needle.length));
  const found = new Set();
  const fd = fs.openSync(file, "r");
  try {
    const chunk = 1024 * 1024;
    const buffer = Buffer.alloc(chunk + longest - 1);
    let carry = 0;
    for (;;) {
      const read = fs.readSync(fd, buffer, carry, chunk, null);
      if (read === 0) break;
      const filled = carry + read;
      const view = buffer.subarray(0, filled);
      encoded.forEach((needle, index) => { if (view.includes(needle)) found.add(needles[index]); });
      carry = Math.min(longest - 1, filled);
      buffer.copy(buffer, 0, filled - carry, filled);
    }
  } finally {
    fs.closeSync(fd);
  }
  return [...found].sort();
}

/**
 * asar の file 一覧のうち、Mastra の ee 由来のもの（.js／.cjs／.map／.d.ts を問わない）。
 * asar の entry は先頭に区切りが無いので、`@mastra/` が先頭の entry も拾えるよう `/` を足して照合する。
 */
export function mastraEeEntries(entries) {
  return entries.filter((entry) => EE_INPUT.test(`/${entry}`));
}

/**
 * app.asar 1 つの検査。副作用なし。`recorded` は記録用、失敗は `failures` に集める（throw しない）。
 * `recorded.asar` の形は package-check.json の記録と同じ。
 */
export function checkAsar(asar) {
  const failures = [];
  let recorded = {};
  try {
    const entries = listAsarEntries(asar);
    const forbidden = entries.filter((entry) => FORBIDDEN_ASAR_ENTRY.test(entry));
    const content = forbiddenContent(asar);
    const eeEntries = mastraEeEntries(entries);
    const eeContent = forbiddenContent(asar, EE_CONTENT_MARKERS);
    // @mastra の file が asar にあるか（bundle に入るだけで、node_modules は載らない）は記録だけにする。
    const mastraEntries = entries.filter((entry) => /(^|\/)@mastra\//.test(entry)).length;
    const hasAgent = entries.includes(ASAR_MASTRA_AGENT_ENTRY);
    const agentMaps = entries.filter((entry) => entry === `${ASAR_MASTRA_AGENT_ENTRY}.map`);
    recorded = { entries: entries.length, forbidden, forbiddenContent: content, mastraEntries, mastraEeEntries: eeEntries, mastraEeContent: eeContent, mastraAgentBundle: hasAgent };
    if (entries.length === 0) failures.push("app.asar: file が 0（走査が何も見ていない）");
    if (forbidden.length) failures.push(`app.asar に harness／probe の file: ${forbidden.slice(0, 5).join(", ")}`);
    if (content.length) failures.push(`app.asar の中身に harness／probe の文字列: ${content.join(", ")}`);
    if (eeEntries.length) failures.push(`app.asar に Mastra の ee の file: ${eeEntries.slice(0, 5).join(", ")}`);
    if (eeContent.length) failures.push(`app.asar の中身に Mastra の ee 固有の文字列: ${eeContent.join(", ")}`);
    if (entries.length > 0 && !hasAgent) failures.push(`app.asar に ${ASAR_MASTRA_AGENT_ENTRY} が無い`);
    if (agentMaps.length) failures.push(`app.asar に ${ASAR_MASTRA_AGENT_ENTRY}.map がある（作らない）`);
  } catch (error) {
    failures.push(`app.asar: ${String(error?.message ?? error)}`);
  }
  return { ok: failures.length === 0, failures, recorded };
}

/** dir の下の app.asar を探す（resources／Resources の直下だけ。深さに上限）。 */
export function findAsars(root, maxDepth = 6) {
  const found = [];
  const walk = (dir, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isFile() && entry.name === "app.asar" && /^resources$/i.test(path.basename(dir))) {
        found.push(full);
      } else if (entry.isDirectory() && depth < maxDepth && entry.name !== "node_modules") {
        walk(full, depth + 1);
      }
    }
  };
  walk(root, 0);
  return found.sort();
}

/** CLI の本体。失敗の行を返す（0 件なら合格）。 */
export function checkAsarsUnder(root) {
  const asars = findAsars(root);
  if (asars.length === 0) return { ok: false, failures: [`${root} の下に app.asar が無い`], results: [] };
  const results = asars.map((asar) => ({ asar, ...checkAsar(asar) }));
  const failures = results.flatMap((result) => result.failures.map((failure) => `${result.asar}: ${failure}`));
  return { ok: failures.length === 0, failures, results };
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  const root = process.argv[2];
  if (!root) {
    console.error("usage: node electron/scripts/mastra-ee-asar-check.mjs <dir>");
    process.exit(2);
  }
  const result = checkAsarsUnder(root);
  for (const entry of result.results) console.log(`${entry.asar}: ${JSON.stringify(entry.recorded)}`);
  if (!result.ok) {
    console.error(result.failures.map((failure) => `- ${failure}`).join("\n"));
    process.exitCode = 1;
  } else {
    console.log(`app.asar ${result.results.length} 件：harness・ee の混入なし、mastra-agent.cjs あり`);
  }
}
