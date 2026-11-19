/**
 * Mastra の ee 由来のコードが配布物に入らないことの検査（Mastra 移行 MP-1、脅威モデル D8／T8、計画書の第 4.3・11 節）。
 *
 * - 陰性対照：stub なしの素の bundle で、ee の input と ee 固有の文字列を検出できること。
 *   検出が壊れていて「0 件で通る」ことを防ぐ。
 * - 陽性：stub を当てた bundle で、metafile の ee の input が stub を通ったものだけで、
 *   ee 固有の文字列が出力に無いこと。
 * - entry は 2 つ（core の Agent だけ、core＋memory）。`@mastra/memory` に ee が入らないことも見る。
 * - 製品の main bundle に `@mastra/*` が入っていないこと（MP-1 の条件）。
 *   MP-3 で製品の bundle に Mastra を入れるときは、この検査を「製品の bundle にも stub を当て、
 *   同じ ee の検査を適用する」形に差し替える。
 *
 * 検出の正規表現は stub の対象（mastra-ee-stub-plugin.mjs）より広く取る。stub の対象外の ee
 * （`.cjs`、他の package の ee）は「stub を通っていない input」として落ちる。
 *
 * esbuild の設定は electron/scripts/build.mjs の main の設定から取り、製品の bundle とずらさない。
 * file には書き出さない（write:false）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import esbuild from "esbuild";

import { bundleConfigs, rootDir as defaultRootDir } from "./build.mjs";
import { EE_CONTENT_MARKERS, EE_INPUT } from "./mastra-ee-patterns.mjs";
import { EE_STUB_MARK, eeStubPlugin } from "./mastra-ee-stub-plugin.mjs";

export { EE_CONTENT_MARKERS, EE_INPUT };

/** 検査用の entry。製品の bundle ではなく、CI の検査にだけ使う。 */
export const INSPECTION_ENTRIES = Object.freeze({
  core: [
    'import { Agent } from "@mastra/core/agent";',
    "export const used = [Agent];",
  ].join("\n"),
  memory: [
    'import { Agent } from "@mastra/core/agent";',
    'import { Memory } from "@mastra/memory";',
    "export const used = [Agent, Memory];",
  ].join("\n"),
});

/** 同梱が許される ee の file の一覧（版ごとに hash と版数が変わる部分は正規化する）。 */
export const KNOWN_EE_INVENTORY = Object.freeze([
  "@mastra/core/dist/_types/@internal_auth@*/dist/ee",
  "@mastra/core/dist/agent-builder/ee",
  "@mastra/core/dist/auth/ee",
  "@mastra/core/dist/ee-<hash>",
]);

/** esbuild で検査用の bundle を作る（file には書かない）。 */
export async function bundleForInspection({
  entry,
  plugins = [],
  rootDir = defaultRootDir,
}) {
  if (!Object.hasOwn(INSPECTION_ENTRIES, entry)) {
    throw new Error(`未知の検査 entry: ${entry}`);
  }
  const {
    entryPoints: _entryPoints,
    outfile: _outfile,
    ...common
  } = bundleConfigs[0];
  const result = await esbuild.build({
    ...common,
    absWorkingDir: rootDir,
    stdin: {
      contents: INSPECTION_ENTRIES[entry],
      resolveDir: rootDir,
      sourcefile: `mastra-ee-check-${entry}.ts`,
      loader: "ts",
    },
    sourcemap: false,
    logLevel: "silent",
    write: false,
    metafile: true,
    plugins,
  });
  return {
    text: result.outputFiles.map((file) => file.text).join(""),
    metafile: result.metafile,
    warnings: result.warnings.length,
  };
}

/** metafile の input のうち ee 由来のもの。`bytesInOutput` は出力に残った大きさ（tree-shake 後）。 */
export function findEeInputs(metafile) {
  const inOutput = new Map();
  for (const output of Object.values(metafile.outputs)) {
    for (const [file, info] of Object.entries(output.inputs)) {
      inOutput.set(file, (inOutput.get(file) ?? 0) + info.bytesInOutput);
    }
  }
  return Object.entries(metafile.inputs)
    .filter(([file]) => EE_INPUT.test(file))
    .map(([file, info]) => ({
      path: file,
      bytes: info.bytes,
      bytesInOutput: inOutput.get(file) ?? 0,
    }));
}

/** metafile の input のうち `@mastra/*` 由来のもの（製品の bundle に入っていないことの確認用）。 */
export function findMastraInputs(metafile) {
  return Object.keys(metafile.inputs).filter((file) =>
    /[\\/]@mastra[\\/]/.test(file),
  );
}

function markersIn(text) {
  return EE_CONTENT_MARKERS.filter((marker) => text.includes(marker));
}

function packageOf(file) {
  return file.match(/[\\/]@mastra[\\/]([^\\/]+)[\\/]/)?.[1] ?? "?";
}

/**
 * 1 つの entry の、素の bundle と stub ありの bundle の検査結果。
 * 副作用は無く、合成した入力でも失敗の分岐を試せる。
 */
export function evaluateEntry({ name, raw, stubbed, stubLog, rootDir }) {
  const failures = [];

  // 陰性対照：素の bundle で ee を検出できること。
  const rawEe = findEeInputs(raw.metafile);
  const rawActive = rawEe.filter((input) => input.bytesInOutput > 0);
  if (rawActive.length === 0) {
    failures.push(
      "陰性対照：素の bundle で ee の input を検出できない（検出の正規表現か entry が壊れている）",
    );
  }
  if (markersIn(raw.text).length === 0) {
    failures.push(
      "陰性対照：素の bundle の出力に ee 固有の文字列が無い（検出の目印が古い）",
    );
  }
  // memory の dist に ee は入らない（入る版は上げない。計画書の第 11 節）。
  const rawByPackage = {};
  for (const input of rawEe) {
    const pkg = packageOf(input.path);
    rawByPackage[pkg] = (rawByPackage[pkg] ?? 0) + 1;
  }
  if (rawByPackage.memory) {
    failures.push(
      `@mastra/memory に ee の input がある: ${rawByPackage.memory} 件`,
    );
  }

  // 陽性：stub ありの bundle の ee の input は、全部が stub を通ったもの。
  const stubEe = findEeInputs(stubbed.metafile);
  const logged = new Map(
    stubLog.map((entry) => [path.resolve(entry.path), entry]),
  );
  for (const input of stubEe) {
    const entry = logged.get(path.resolve(rootDir, input.path));
    if (!entry) {
      failures.push(`stub を通っていない ee の input: ${input.path}`);
    } else if (entry.stubBytes !== input.bytes) {
      failures.push(
        `ee の input の大きさが stub と違う: ${input.path}（${input.bytes} 対 ${entry.stubBytes}）`,
      );
    }
  }
  if (stubEe.length === 0) {
    failures.push(
      "stub ありの bundle に ee の input が 0 件（stub が当たっていない）",
    );
  }
  if (stubEe.length > 0 && !stubbed.text.includes(EE_STUB_MARK)) {
    failures.push("stub ありの出力に stub の目印が無い");
  }
  const stubMarkers = markersIn(stubbed.text);
  if (stubMarkers.length > 0) {
    failures.push(
      `stub ありの出力に ee 固有の文字列が残る: ${stubMarkers.join(", ")}`,
    );
  }

  return {
    name,
    ok: failures.length === 0,
    failures,
    summary: {
      raw: {
        eeInputs: rawEe.length,
        eeActive: rawActive.length,
        eeBytesInOutput: rawActive.reduce((sum, i) => sum + i.bytesInOutput, 0),
        markers: markersIn(raw.text),
        byPackage: rawByPackage,
        outputBytes: Buffer.byteLength(raw.text),
      },
      stubbed: {
        eeInputs: stubEe.length,
        stubbedFiles: stubLog.length,
        markers: stubMarkers,
        outputBytes: Buffer.byteLength(stubbed.text),
      },
    },
  };
}

/** `@mastra/*` の dist にある ee の file と dir を、版ごとの hash／version を正規化した形で列挙する。 */
export function inventoryEeEntries(rootDir = defaultRootDir) {
  const pnpm = path.join(rootDir, "node_modules", ".pnpm");
  const found = new Set();
  if (!fs.existsSync(pnpm)) return [];
  for (const store of fs.readdirSync(pnpm)) {
    if (!store.startsWith("@mastra+")) continue;
    const scope = path.join(pnpm, store, "node_modules", "@mastra");
    if (!fs.existsSync(scope)) continue;
    for (const pkg of fs.readdirSync(scope)) {
      const dist = path.join(scope, pkg, "dist");
      if (!fs.existsSync(dist)) continue;
      const walk = (dir, relative) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const rel = relative ? `${relative}/${entry.name}` : entry.name;
          if (entry.isDirectory()) {
            if (entry.name === "ee") found.add(normalizeEe(pkg, rel));
            else walk(path.join(dir, entry.name), rel);
          } else if (/^ee-/.test(entry.name)) {
            found.add(normalizeEe(pkg, rel));
          }
        }
      };
      walk(dist, "");
    }
  }
  return [...found].sort();
}

function normalizeEe(pkg, relative) {
  const normalized = relative
    .replace(/@([A-Za-z_]+)@[\d.]+/g, "@$1@*")
    .replace(/(^|\/)ee-[^/]+$/, "$1ee-<hash>");
  return `@mastra/${pkg}/dist/${normalized}`;
}

/** 製品の main bundle を metafile 付きで組み、`@mastra/*` の input を返す（MP-1：0 件のはず）。 */
export async function productBundleMastraInputs(rootDir = defaultRootDir) {
  const { entryPoints, outfile, ...common } = bundleConfigs[0];
  const result = await esbuild.build({
    ...common,
    entryPoints,
    outfile,
    absWorkingDir: rootDir,
    sourcemap: false,
    logLevel: "silent",
    write: false,
    metafile: true,
  });
  return {
    inputs: Object.keys(result.metafile.inputs).length,
    mastraInputs: findMastraInputs(result.metafile),
    outputBytes: result.outputFiles.reduce(
      (sum, f) => sum + f.contents.length,
      0,
    ),
  };
}

/** 全部の検査を走らせる。失敗は返り値の `failures` に集め、throw しない。 */
export async function checkMastraEe({ rootDir = defaultRootDir } = {}) {
  const entries = [];
  for (const name of Object.keys(INSPECTION_ENTRIES)) {
    const raw = await bundleForInspection({ entry: name, rootDir });
    const stubLog = [];
    const stubbed = await bundleForInspection({
      entry: name,
      rootDir,
      plugins: [eeStubPlugin(stubLog)],
    });
    entries.push(evaluateEntry({ name, raw, stubbed, stubLog, rootDir }));
  }
  const failures = entries.flatMap((entry) =>
    entry.failures.map((failure) => `${entry.name}: ${failure}`),
  );
  const inventory = inventoryEeEntries(rootDir);
  if (JSON.stringify(inventory) !== JSON.stringify([...KNOWN_EE_INVENTORY])) {
    failures.push(
      `ee の file／dir の棚卸しが既知の集合と違う: ${JSON.stringify(inventory)}`,
    );
  }
  const product = await productBundleMastraInputs(rootDir);
  if (product.mastraInputs.length > 0) {
    failures.push(
      `製品の main bundle に @mastra/* が入っている（MP-3 より前）: ${product.mastraInputs.length} 件`,
    );
  }
  return { ok: failures.length === 0, failures, entries, inventory, product };
}

const isDirectRun =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  const result = await checkMastraEe();
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    console.error(result.failures.map((failure) => `- ${failure}`).join("\n"));
    process.exitCode = 1;
  }
}
