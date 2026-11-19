/**
 * Mastra の ee 由来のコードが配布物に入らないことの検査（Mastra 移行 MP-1、脅威モデル D8／T8、計画書の第 4.3・11 節）。
 *
 * 2 つの mode。
 * - 既定（`node electron/scripts/mastra-ee-check.mjs`）：MP-1 の検査。検査用の entry で素の bundle と stub ありの bundle を比べる。
 * - `--dist`（MP-3a、docs/plans/mastra-mp3-decisions.md の DR-MP3-19）：製品の bundle（`node electron/scripts/build.mjs` の
 *   出力 `dist-electron/`）に当てる。既定の検査も含めて走らせる。
 *   - main.cjs と preload.cjs（とその .map）に `@mastra` が 0。
 *   - mastra-agent.cjs は stub の目印を 1 件以上持ち、ee 固有の文字列が 0、`.map` を作っていない。
 *   - 全 bundle の config に ee の stub plugin が入っている（dev の watch が落とさない）。
 *   - 陰性対照：mastra-agent の config から stub を外すと、ee の input と文字列を検出して落ちる。
 *   - picomatch（GHSA-fc5q の例外の対象）を import する依存の外の file は、workspace-skills の chunk だけ
 *     （@mastra/core を上げて importer が増えたら落ちる）。
 *   - main.cjs・preload.cjs・mastra-agent.cjs の大きさは出力の `bytes` に記録するだけ（失敗にしない。DR-MP3-21）。
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

/**
 * 検査用の entry。製品の bundle ではなく、CI の検査にだけ使う。
 * `require` は `require()` で解決される経路（`.cjs`）。MP-3 が遅延 `require` を使っても stub が当たることを見る。
 */
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
  require: [
    'const { Agent } = require("@mastra/core/agent");',
    'const { Memory } = require("@mastra/memory");',
    "exports.used = [Agent, Memory];",
  ].join("\n"),
});

/** 同梱が許される ee の file／dir の一覧（版ごとに hash と版数が変わる部分は正規化する）。 */
export const KNOWN_EE_INVENTORY = Object.freeze([
  "@mastra/core/dist/_types/@internal_auth@*/dist/ee",
  "@mastra/core/dist/_types/@internal_auth@*/dist/ee/defaults",
  "@mastra/core/dist/_types/@internal_auth@*/dist/ee/defaults/rbac",
  "@mastra/core/dist/_types/@internal_auth@*/dist/ee/interfaces",
  "@mastra/core/dist/agent-builder/ee",
  "@mastra/core/dist/auth/ee",
  "@mastra/core/dist/auth/ee/defaults",
  "@mastra/core/dist/auth/ee/defaults/rbac",
  "@mastra/core/dist/auth/ee/interfaces",
  "@mastra/core/dist/ee-<hash>",
]);

/** esbuild で検査用の bundle を作る（file には書かない）。 */
export async function bundleForInspection({
  entry,
  plugins = [],
  rootDir = defaultRootDir,
  sourcemap = false,
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
    // 書き出さない（write:false）。外部の source map を出力として得るために出力先の名前だけ要る。
    outfile: path.join(rootDir, "mastra-ee-check.out.cjs"),
    sourcemap,
    logLevel: "silent",
    write: false,
    metafile: true,
    plugins,
  });
  return {
    text: result.outputFiles
      .filter((file) => !file.path.endsWith(".map"))
      .map((file) => file.text)
      .join(""),
    mapText: result.outputFiles
      .filter((file) => file.path.endsWith(".map"))
      .map((file) => file.text)
      .join(""),
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
      // ee/ の下は深さを問わず、部分ディレクトリも列挙する（新しい入れ子が増えたら棚卸しが変わる）。
      const addSubdirectories = (dir, relative) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const rel = `${relative}/${entry.name}`;
          found.add(normalizeEe(pkg, rel));
          addSubdirectories(path.join(dir, entry.name), rel);
        }
      };
      const walk = (dir, relative) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const rel = relative ? `${relative}/${entry.name}` : entry.name;
          if (entry.isDirectory()) {
            if (entry.name === "ee") {
              found.add(normalizeEe(pkg, rel));
              addSubdirectories(path.join(dir, entry.name), rel);
            } else walk(path.join(dir, entry.name), rel);
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

/** 製品の main bundle を metafile 付きで組み、`@mastra/*` の input を返す（0 件のはず。Mastra は mastra-agent.cjs にだけ入る）。 */
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

/** 製品の bundle の名前（`dist-electron/` の出力）。 */
export const PRODUCT_BUNDLES = Object.freeze({
  main: "main.cjs",
  preload: "preload.cjs",
  mastraAgent: "mastra-agent.cjs",
});

/**
 * picomatch を import してよい `@mastra/core` の chunk。GHSA-fc5q の期限つきの例外（scripts/pnpm-audit.mjs）は、
 * workspace を有効にしないことを前提にする。picomatch に届くのはこの chunk だけであることを固定し、
 * 版を上げて importer が増えたら落とす（docs/plans/mastra-mp3-decisions.md の DR-MP3-15）。
 */
export const PICOMATCH_ALLOWED_IMPORTER =
  /[\\/]@mastra[\\/]core[\\/]dist[\\/]workspace-skills-[A-Za-z0-9_-]+\.[cm]?js$/;

const PICOMATCH_INPUT = /[\\/]picomatch[\\/]/;

/** metafile で picomatch を import している、picomatch の外の input（重複なし、昇順）。 */
export function picomatchImporters(metafile) {
  const picomatchInputs = new Set(
    Object.keys(metafile.inputs).filter((file) => PICOMATCH_INPUT.test(file)),
  );
  const importers = new Set();
  for (const [file, info] of Object.entries(metafile.inputs)) {
    if (picomatchInputs.has(file)) continue;
    for (const entry of info.imports ?? []) {
      if (picomatchInputs.has(entry.path)) importers.add(file);
    }
  }
  return [...importers].sort();
}

/**
 * 製品の bundle の出力 file の検査（副作用なし。合成した入力でも失敗の分岐を試せる）。
 * `files` は `{ main, preload, mastraAgent }` の text、`mapTexts` は main／preload の .map の text（無ければ省く）、
 * `distEntries` は dist-electron の file 名の一覧。
 */
export function evaluateDistFiles({ files, mapTexts = {}, distEntries }) {
  const failures = [];
  for (const name of ["main", "preload"]) {
    const text = files[name];
    if (typeof text !== "string" || text.length === 0) {
      failures.push(`${PRODUCT_BUNDLES[name]} が無い、または空`);
      continue;
    }
    if (text.includes("@mastra")) {
      failures.push(`${PRODUCT_BUNDLES[name]} に @mastra が入っている`);
    }
    if (typeof mapTexts[name] === "string") {
      // `sources` の path だけを見る。sourcesContent には自分の source の comment（`@mastra/*` を import しない、など）が入る。
      try {
        const sources = JSON.parse(mapTexts[name]).sources ?? [];
        const bad = sources.filter((source) =>
          /@mastra[+/\\]/.test(String(source)),
        );
        if (bad.length > 0) {
          failures.push(
            `${PRODUCT_BUNDLES[name]}.map の sources に @mastra が入っている: ${bad.length} 件`,
          );
        }
      } catch {
        failures.push(`${PRODUCT_BUNDLES[name]}.map を JSON として読めない`);
      }
    }
  }
  const agent = files.mastraAgent;
  if (typeof agent !== "string" || agent.length === 0) {
    failures.push(`${PRODUCT_BUNDLES.mastraAgent} が無い、または空`);
  } else {
    if (!agent.includes(EE_STUB_MARK)) {
      failures.push(
        `${PRODUCT_BUNDLES.mastraAgent} に stub の目印（${EE_STUB_MARK}）が無い（stub が当たっていない）`,
      );
    }
    const found = markersIn(agent);
    if (found.length > 0) {
      failures.push(
        `${PRODUCT_BUNDLES.mastraAgent} に ee 固有の文字列が残る: ${found.join(", ")}`,
      );
    }
    if (/\/\/#\s*sourceMappingURL=/.test(agent)) {
      failures.push(
        `${PRODUCT_BUNDLES.mastraAgent} が source map を参照している`,
      );
    }
  }
  if (distEntries.includes(`${PRODUCT_BUNDLES.mastraAgent}.map`)) {
    failures.push(`${PRODUCT_BUNDLES.mastraAgent}.map がある（作らない）`);
  }
  return failures;
}

/** 全 bundle の config に ee の stub plugin が入っていること（plugins を落とす書き換えを検出する）。 */
export function stubPluginFailures(configs = bundleConfigs) {
  return configs
    .filter(
      (config) =>
        !(config.plugins ?? []).some(
          (plugin) => plugin.name === "mastra-ee-stub",
        ),
    )
    .map(
      (config) =>
        `bundle の config に ee の stub plugin が無い: ${path.basename(String(config.outfile))}`,
    );
}

async function buildInMemory(config, rootDir, plugins) {
  const result = await esbuild.build({
    ...config,
    absWorkingDir: rootDir,
    sourcemap: false,
    logLevel: "silent",
    write: false,
    metafile: true,
    plugins,
  });
  return {
    text: result.outputFiles
      .filter((file) => !file.path.endsWith(".map"))
      .map((file) => file.text)
      .join(""),
    mapText: "",
    metafile: result.metafile,
    warnings: result.warnings.length,
  };
}

/**
 * 製品の bundle（`dist-electron/`。先に `node electron/scripts/build.mjs`）に当てる検査（MP-3a）。
 * 失敗は返り値の `failures` に集め、throw しない。
 */
export async function checkDist({
  rootDir = defaultRootDir,
  distDir = path.join(defaultRootDir, "dist-electron"),
} = {}) {
  const failures = [...stubPluginFailures()];
  const read = (name) => {
    try {
      return fs.readFileSync(path.join(distDir, name), "utf8");
    } catch {
      return undefined;
    }
  };
  const distEntries = fs.existsSync(distDir) ? fs.readdirSync(distDir) : [];
  const files = {
    main: read(PRODUCT_BUNDLES.main),
    preload: read(PRODUCT_BUNDLES.preload),
    mastraAgent: read(PRODUCT_BUNDLES.mastraAgent),
  };
  failures.push(
    ...evaluateDistFiles({
      files,
      mapTexts: {
        main: read(`${PRODUCT_BUNDLES.main}.map`),
        preload: read(`${PRODUCT_BUNDLES.preload}.map`),
      },
      distEntries,
    }),
  );

  // config から in-memory で組み直し、陰性対照（stub なし）と陽性（stub あり）を比べる。
  const agentConfig = bundleConfigs.find(
    (config) =>
      path.basename(String(config.outfile)) === PRODUCT_BUNDLES.mastraAgent,
  );
  let picomatch = [];
  let agentEntry;
  if (!agentConfig) {
    failures.push("bundleConfigs に mastra-agent の config が無い");
  } else {
    const raw = await buildInMemory(agentConfig, rootDir, []);
    const stubLog = [];
    const stubbed = await buildInMemory(agentConfig, rootDir, [
      eeStubPlugin(stubLog),
    ]);
    agentEntry = evaluateEntry({
      name: "mastra-agent",
      raw,
      stubbed,
      stubLog,
      rootDir,
    });
    failures.push(...agentEntry.failures.map((f) => `mastra-agent: ${f}`));
    picomatch = picomatchImporters(stubbed.metafile);
    if (picomatch.length === 0) {
      failures.push(
        "picomatch の importer を 1 件も検出できない（検出が壊れているか、依存が変わった）",
      );
    }
    for (const importer of picomatch) {
      if (!PICOMATCH_ALLOWED_IMPORTER.test(importer)) {
        failures.push(
          `picomatch を import する想定外の file: ${importer}（workspace-skills の chunk だけが許される）`,
        );
      }
    }
  }
  // main／preload の config も、in-memory で組み直して @mastra の input が 0 であること。
  const product = {};
  for (const name of ["main", "preload"]) {
    const config = bundleConfigs.find(
      (candidate) =>
        path.basename(String(candidate.outfile)) === PRODUCT_BUNDLES[name],
    );
    if (!config) {
      failures.push(
        `bundleConfigs に ${PRODUCT_BUNDLES[name]} の config が無い`,
      );
      continue;
    }
    const built = await buildInMemory(config, rootDir, config.plugins ?? []);
    const mastraInputs = findMastraInputs(built.metafile);
    product[name] = {
      inputs: Object.keys(built.metafile.inputs).length,
      mastraInputs,
    };
    if (mastraInputs.length > 0) {
      failures.push(
        `${PRODUCT_BUNDLES[name]} の bundle に @mastra/* の input がある: ${mastraInputs.length} 件`,
      );
    }
  }
  const bytes = Object.fromEntries(
    Object.entries(PRODUCT_BUNDLES).map(([key, name]) => {
      try {
        return [name, fs.statSync(path.join(distDir, name)).size];
      } catch {
        return [name, null];
      }
    }),
  );
  return {
    ok: failures.length === 0,
    failures,
    bytes,
    picomatchImporters: picomatch,
    agent: agentEntry?.summary,
    product,
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
      `製品の main bundle に @mastra/* が入っている: ${product.mastraInputs.length} 件`,
    );
  }
  return { ok: failures.length === 0, failures, entries, inventory, product };
}

const isDirectRun =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  const dist = process.argv.includes("--dist");
  const result = await checkMastraEe();
  const failures = [...result.failures];
  const output = { ...result };
  if (dist) {
    const distResult = await checkDist();
    failures.push(...distResult.failures);
    output.dist = distResult;
  }
  output.ok = failures.length === 0;
  output.failures = failures;
  console.log(JSON.stringify(output, null, 2));
  if (!output.ok) {
    console.error(failures.map((failure) => `- ${failure}`).join("\n"));
    process.exitCode = 1;
  }
}
