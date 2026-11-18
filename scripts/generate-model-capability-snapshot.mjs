#!/usr/bin/env node
/**
 * モデル能力の registry の「写し」を、保存済みの models.dev の応答（file）から生成・検証する（PR-C2）。
 * 設計の正本は docs/plans/model-capability-runtime-fetch-precheck.md の §4 と §7.3。
 *
 * このスクリプトは通信しない。入力は引数で渡す file だけで、取得は後の workflow の PR が担う。
 * 検証 module（electron/shared/modelCapabilityRegistry.ts）は import なしの 1 file で、Node 22.18 以降は
 * 型の除去が既定で有効なので、install なしで `.ts` を直接 import できる。
 *
 * 使い方:
 *   node scripts/generate-model-capability-snapshot.mjs generate <models.dev の応答> \
 *     --generated-at 2026-11-18T15:28:51Z [--out <出力 file>]
 *   node scripts/generate-model-capability-snapshot.mjs check [<写しの file>]
 *
 * generate: normalizeModelsDev → canonicalize → parseSnapshot の順に通し、自己検証してから書く。
 *   途中で 1 つでも失敗したら、出力 file には触れず、非 0 で終わる。`source` は常に "grimodex"。
 * check: file が parseSnapshot を通り、`source` が "grimodex" で、書式が generate の出力と
 *   1 byte も違わないことを確かめる（CI と試験の入口）。
 *
 * 失敗の出力は code と件数だけで、入力の本文は出さない。
 */
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  canonicalize,
  normalizeModelsDev,
  parseModelsDevText,
  parseSnapshot,
  SNAPSHOT_POLICY,
} from "../electron/shared/modelCapabilityRegistry.ts";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

/** 同梱の写しの repo 内の path。master の raw 配信の path と同じ（app の定数と試験が一致を確かめる）。 */
export const SNAPSHOT_REPO_PATH = "electron/resources/model-capabilities.json";
const DEFAULT_OUT = path.join(rootDir, SNAPSHOT_REPO_PATH);

/**
 * repo に置く書式。1 model を 1 行にして、更新 PR の diff を読めるようにする（canonicalize は
 * 1 行で diff に向かない）。key の順は canonicalize と同じ（辞書順）。末尾に改行を 1 つ付ける。
 * parseSnapshot は空白を問わないので、この書式の file も検証を通る。
 */
export function formatSnapshotFile(snapshot) {
  const canonical = JSON.parse(canonicalize(snapshot));
  const lines = Object.keys(canonical.models).map(
    (key) =>
      `    ${JSON.stringify(key)}: ${JSON.stringify(canonical.models[key])}`,
  );
  return (
    `{\n` +
    `  "generatedAt": ${JSON.stringify(canonical.generatedAt)},\n` +
    `  "models": {\n${lines.join(",\n")}\n  },\n` +
    `  "schemaVersion": ${canonical.schemaVersion},\n` +
    `  "source": ${JSON.stringify(canonical.source)}\n` +
    `}\n`
  );
}

function countFindings(findings) {
  const counts = new Map();
  for (const finding of findings) {
    const add = typeof finding.count === "number" ? finding.count : 1;
    counts.set(finding.code, (counts.get(finding.code) ?? 0) + add);
  }
  return [...counts].map(([code, count]) => `${code}=${count}`).join(" ");
}

function providerCounts(snapshot) {
  const counts = new Map();
  for (const key of Object.keys(snapshot.models)) {
    const provider = key.slice(0, key.indexOf("/"));
    counts.set(provider, (counts.get(provider) ?? 0) + 1);
  }
  return [...counts]
    .map(([provider, count]) => `${provider}=${count}`)
    .join(" ");
}

/** generate の本体。失敗は Error（message は code だけ）。 */
export function generateSnapshotText(rawText, generatedAt, nowMs) {
  const raw = parseModelsDevText(rawText, SNAPSHOT_POLICY);
  if (!raw.ok) throw new Error(`models.dev の応答を読めません: ${raw.code}`);
  const normalized = normalizeModelsDev(raw.value, SNAPSHOT_POLICY, {
    generatedAt,
    source: "grimodex",
  });
  if (!normalized.ok) {
    throw new Error(`models.dev の応答を変換できません: ${normalized.code}`);
  }
  const canonicalText = canonicalize(normalized.snapshot);
  const parsed = parseSnapshot(canonicalText, SNAPSHOT_POLICY, { nowMs });
  if (!parsed.ok) throw new Error(`生成した写しの検証に失敗: ${parsed.code}`);
  // 自己検証：変換の結果は、検証を通した後も 1 件も落ちていない（正規形が完全に一致する）。
  if (canonicalize(parsed.snapshot) !== canonicalText) {
    throw new Error("生成した写しの検証で内容が変わりました");
  }
  return {
    text: formatSnapshotFile(parsed.snapshot),
    snapshot: parsed.snapshot,
    digest: parsed.digest,
    findings: [...normalized.findings, ...parsed.findings],
  };
}

/** check の本体。file の text を検証し、書式の一致まで確かめる。 */
export function checkSnapshotText(text, nowMs) {
  const parsed = parseSnapshot(text, SNAPSHOT_POLICY, { nowMs });
  if (!parsed.ok) throw new Error(`写しの検証に失敗: ${parsed.code}`);
  if (parsed.snapshot.source !== "grimodex") {
    throw new Error("写しの source が grimodex ではありません");
  }
  if (parsed.findings.length > 0) {
    throw new Error(
      `写しに捨てられる項目があります: ${countFindings(parsed.findings)}`,
    );
  }
  if (formatSnapshotFile(parsed.snapshot) !== text) {
    throw new Error("写しの書式が generate の出力と一致しません");
  }
  return parsed;
}

function writeAtomic(target, text) {
  mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, text, "utf8");
    renameSync(tmp, target);
  } finally {
    rmSync(tmp, { force: true });
  }
}

function parseArgs(argv) {
  const positional = [];
  const options = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg.startsWith("--")) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${arg} には値が要ります`);
      }
      options.set(arg, value);
      index += 1;
    } else {
      positional.push(arg);
    }
  }
  return { positional, options };
}

function main(argv) {
  const { positional, options } = parseArgs(argv);
  const [command, input] = positional;
  const nowMs = Date.now();
  if (command === "generate") {
    if (!input || positional.length !== 2) {
      throw new Error("generate には models.dev の応答 file を 1 つ渡します");
    }
    const generatedAt = options.get("--generated-at");
    if (!generatedAt) {
      throw new Error(
        "--generated-at（ISO 8601 の UTC、例 2026-11-18T15:28:51Z）が要ります",
      );
    }
    const out = options.get("--out") ?? DEFAULT_OUT;
    const result = generateSnapshotText(
      readFileSync(input, "utf8"),
      generatedAt,
      nowMs,
    );
    writeAtomic(out, result.text);
    console.log(
      `wrote ${out}\n` +
        `models=${Object.keys(result.snapshot.models).length} (${providerCounts(result.snapshot)})\n` +
        `digest=${result.digest}\n` +
        `findings: ${countFindings(result.findings) || "none"}`,
    );
    return;
  }
  if (command === "check") {
    const target = input ?? DEFAULT_OUT;
    const parsed = checkSnapshotText(readFileSync(target, "utf8"), nowMs);
    console.log(
      `ok ${target}\nmodels=${Object.keys(parsed.snapshot.models).length} (${providerCounts(parsed.snapshot)})\ndigest=${parsed.digest}`,
    );
    return;
  }
  throw new Error(
    "使い方: generate <models.dev の応答> --generated-at <時刻> | check [<file>]",
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "失敗しました");
    process.exitCode = 1;
  }
}
