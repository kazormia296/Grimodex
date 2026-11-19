/**
 * Mastra の ee の stub と検査（mastra-ee-stub-plugin.mjs、mastra-ee-check.mjs）の試験。
 * 実際の `@mastra/core`／`@mastra/memory` を esbuild で bundle する（file には書かない）。
 * 検査そのものが壊れて「0 件で通る」ことを防ぐため、陰性対照と失敗の分岐も試す。
 *
 * 実行: node --test electron/scripts/mastra-ee-check.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import yaml from "js-yaml";

import { rootDir } from "./build.mjs";
import {
  EE_CONTENT_MARKERS,
  EE_INPUT,
  KNOWN_EE_INVENTORY,
  bundleForInspection,
  checkMastraEe,
  evaluateEntry,
  findEeInputs,
  findMastraInputs,
  inventoryEeEntries,
  productBundleMastraInputs,
} from "./mastra-ee-check.mjs";
import {
  EE_STUB_FILE,
  EE_STUB_MARK,
  analyzeEeFile,
  eeStubPlugin,
  exportedPairs,
  stubSource,
} from "./mastra-ee-stub-plugin.mjs";
import esbuild from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const SELF = "electron/scripts/mastra-ee-check.test.mjs";

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const emptyBundle = { text: "", metafile: { inputs: {}, outputs: {} } };

test("exportedPairs は export の各形（ESM・CJS）から公開名と配列かどうかを取り、未対応の形は throw する", () => {
  assert.deepEqual(
    exportedPairs(
      'const d = [1];\nexport { a, b as c } from "./x.js";\nexport { d as D };',
    ),
    [
      { local: "a", exported: "a", array: false },
      { local: "b", exported: "c", array: false },
      { local: "d", exported: "D", array: true },
    ],
  );
  assert.deepEqual(
    exportedPairs(
      "export const A = 1;\nexport async function f() {}\nexport class K {}\nexport let z = 0;",
    ).map((pair) => pair.exported),
    ["A", "f", "K", "z"],
  );
  // 配列は宣言の形（`= [`）で判定する。object や文字列は配列にしない。
  assert.deepEqual(
    exportedPairs(
      'const LIST = [\n  "a",\n];\nconst MAP = { a: 1 };\nexport { LIST as L, MAP as M };',
    ).map(({ exported, array }) => [exported, array]),
    [
      ["L", true],
      ["M", false],
    ],
  );
  // CJS：defineProperty の getter、exports.N = L、exports.N = require_x.M。
  assert.deepEqual(
    exportedPairs(
      [
        'Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });',
        'const require_x = require("./x.cjs");',
        "const ROLES = [];",
        'Object.defineProperty(exports, "ROLES", {\n  enumerable: true,\n  get: function() {\n    return ROLES;\n  }\n});',
        "exports.helper = helper;",
        "exports.viaChunk = require_x.chunkName;",
      ].join("\n"),
    ),
    [
      { local: "ROLES", exported: "ROLES", array: true },
      { local: "helper", exported: "helper", array: false },
      { local: "chunkName", exported: "viaChunk", array: false },
    ],
  );
  assert.throws(() => exportedPairs("export default 1;"), /未対応/);
  assert.throws(() => exportedPairs('export * from "./x.js";'), /未対応/);
  assert.throws(() => exportedPairs("module.exports = {};"), /未対応/);
});

test("EE_INPUT と EE_STUB_FILE は ee/ の下を深さを問わず対象にし、ee の無い path は拾わない", () => {
  const base = "node_modules/.pnpm/x/node_modules/@mastra/core/dist";
  const ee = [
    `${base}/ee-abc123.js`,
    `${base}/ee-abc123.cjs`,
    `${base}/ee-abc123.js.map`,
    `${base}/auth/ee/index.js`,
    `${base}/auth/ee/index.cjs`,
    `${base}/auth/ee/sub/x.js`,
    `${base}/auth/ee/sub/deeper/x.cjs`,
    `${base}/auth/ee/defaults/rbac/roles.d.ts`,
    `${base}/_types/@internal_auth@1.0.0/dist/ee/index.d.ts`,
    "node_modules/.pnpm/y/node_modules/@mastra/memory/dist/ee/index.js",
    "node_modules/.pnpm/y/node_modules/@mastra/memory/dist/ee/a/b/c.js",
    "node_modules/.pnpm/y/node_modules/@mastra/editor/dist/ee-zzz.js",
    "node_modules\\.pnpm\\x\\node_modules\\@mastra\\core\\dist\\auth\\ee\\sub\\x.js",
  ];
  for (const file of ee) assert.ok(EE_INPUT.test(file), file);
  const notEe = [
    `${base}/agent/index.js`,
    `${base}/free-chunk.js`,
    `${base}/employee/index.js`,
    `${base}/auth/index.js`,
    "node_modules/zod/index.js",
    "electron/main/ee-notes.ts",
  ];
  for (const file of notEe) assert.equal(EE_INPUT.test(file), false, file);
  // stub の対象は @mastra/core の ee の .js／.cjs（深さを問わない）。.map・.d.ts・他の package は対象外で、
  // 広い検出との差が「stub を通っていない input」として落ちる。
  for (const file of [ee[0], ee[1], ee[3], ee[4], ee[5], ee[6]]) {
    assert.ok(EE_STUB_FILE.test(file), file);
  }
  for (const file of [ee[2], ee[7], ee[8], ee[9], ee[10], ee[11], ...notEe]) {
    assert.equal(EE_STUB_FILE.test(file), false, file);
  }
});

test("実際の ee の chunk から作った stub：公開名の欠け 0、FGA と RBAC は黙って通さない", async () => {
  const coreDist = fs.realpathSync(
    path.join(repoRoot, "node_modules", "@mastra", "core", "dist"),
  );
  const files = walk(coreDist).filter((file) => EE_STUB_FILE.test(file));
  const relative = files.map((file) =>
    path.relative(coreDist, file).split(path.sep).join("/"),
  );
  // 実体が見つからない（版が変わって配置が動いた）ときに、何も見ないで通らないようにする。
  assert.ok(
    ["js", "cjs"].every(
      (ext) =>
        relative.some((file) => new RegExp(`^ee-[^/]+\\.${ext}$`).test(file)) &&
        relative.includes(`auth/ee/index.${ext}`) &&
        relative.includes(`auth/ee/fga-check.${ext}`) &&
        relative.includes(`agent-builder/ee/index.${ext}`),
    ),
    `ee の file を想定どおり見つけられない: ${relative.join(", ")}`,
  );
  const seen = {
    requireFGA: 0,
    checkFGA: 0,
    rbac: 0,
    isEEEnabled: 0,
    arrays: 0,
  };
  for (const file of files) {
    const pairs = analyzeEeFile(file);
    assert.ok(pairs.length > 0, file);
    const source = stubSource(pairs);
    const mod = await import(
      `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
    );
    assert.equal(mod.__eeStub, EE_STUB_MARK);
    const expected = [...new Set(pairs.map((pair) => pair.exported))].sort();
    assert.deepEqual(
      Object.keys(mod)
        .filter((name) => name !== "__eeStub")
        .sort(),
      expected,
      `${file} の公開名`,
    );
    for (const name of ["requireFGA", "checkFGA"]) {
      if (!(name in mod)) continue;
      seen[name] += 1;
      await assert.rejects(
        () => mod[name]({ fgaProvider: {} }),
        /FGA provider is not supported/,
      );
      assert.equal(await mod[name]({}), undefined);
      assert.equal(await mod[name](undefined), undefined);
    }
    if ("StaticRBACProvider" in mod) {
      seen.rbac += 1;
      assert.throws(
        () => new mod.StaticRBACProvider(),
        /RBAC is not supported/,
      );
    }
    if ("isEEEnabled" in mod) {
      seen.isEEEnabled += 1;
      assert.equal(mod.isEEEnabled(), false);
    }
    if ("FGADeniedError" in mod) {
      assert.ok(new mod.FGADeniedError("x") instanceof Error);
    }
    if ("MastraFGAPermissions" in mod) {
      assert.equal(mod.MastraFGAPermissions.AGENT_READ, "AGENT_READ");
    }
    // 実物で配列として宣言された export は、再 export の file でも空の配列（`.map` で壊れない）。
    for (const name of [
      "ACTIONS",
      "PERMISSIONS",
      "RESOURCES",
      "DEFAULT_ROLES",
    ]) {
      if (!(name in mod)) continue;
      seen.arrays += 1;
      assert.ok(Array.isArray(mod[name]), `${file} の ${name}`);
      assert.deepEqual(
        mod[name].map((x) => x),
        [],
      );
    }
    // 配列でない定数は配列にしない。
    if ("PERMISSION_PATTERNS" in mod) {
      assert.equal(Array.isArray(mod.PERMISSION_PATTERNS), false);
    }
  }
  // 振る舞いの分類が全部 undefined に落ちる欠陥（S2 追補）の再発を防ぐ。
  assert.ok(
    Object.values(seen).every((count) => count >= 2),
    JSON.stringify(seen),
  );
});

test("陰性対照と陽性：素の bundle で ee を検出でき、stub を当てると stub だけになる（core だけ／core＋memory／require の経路）", async () => {
  const result = await checkMastraEe({ rootDir });
  assert.deepEqual(result.failures, []);
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.entries.map((entry) => entry.name),
    ["core", "memory", "require"],
  );
  for (const entry of result.entries) {
    // 陰性対照：stub なしでは ee の実体が入り、固有の文字列も出る。
    assert.ok(entry.summary.raw.eeActive >= 1, entry.name);
    assert.ok(entry.summary.raw.eeBytesInOutput > 0, entry.name);
    assert.deepEqual(
      [...entry.summary.raw.markers].sort(),
      [...EE_CONTENT_MARKERS].sort(),
      entry.name,
    );
    assert.equal(entry.summary.raw.byPackage.memory, undefined, entry.name);
    // 陽性：stub ありでは、ee の input は stub を通ったものだけ、固有の文字列は 0。
    assert.equal(
      entry.summary.stubbed.eeInputs,
      entry.summary.stubbed.stubbedFiles,
      entry.name,
    );
    assert.deepEqual(entry.summary.stubbed.markers, [], entry.name);
    assert.ok(
      entry.summary.stubbed.outputBytes < entry.summary.raw.outputBytes,
      entry.name,
    );
  }
  assert.deepEqual(result.inventory, [...KNOWN_EE_INVENTORY]);
});

test("検査の失敗の分岐：stub なし・大きさの食い違い・素の側の検出の欠落・stub が当たっていないことを落とす", async () => {
  const raw = await bundleForInspection({ entry: "core", rootDir });
  const stubLog = [];
  const stubbed = await bundleForInspection({
    entry: "core",
    rootDir,
    plugins: [eeStubPlugin(stubLog)],
  });
  const ok = evaluateEntry({ name: "core", raw, stubbed, stubLog, rootDir });
  assert.deepEqual(ok.failures, []);
  assert.ok(stubLog.length >= 2);

  // stub を当てない bundle を「stub あり」として渡すと落ちる。
  const unstubbed = evaluateEntry({
    name: "core",
    raw,
    stubbed: raw,
    stubLog: [],
    rootDir,
  });
  assert.equal(unstubbed.ok, false);
  assert.ok(unstubbed.failures.some((f) => f.includes("stub を通っていない")));
  assert.ok(
    unstubbed.failures.some((f) => f.includes("ee 固有の文字列が残る")),
  );
  assert.ok(unstubbed.failures.some((f) => f.includes("stub の目印が無い")));

  // metafile の大きさと stub の大きさが違う（別の内容が読まれた）と落ちる。
  const tampered = evaluateEntry({
    name: "core",
    raw,
    stubbed,
    stubLog: stubLog.map((entry) => ({
      ...entry,
      stubBytes: entry.stubBytes + 1,
    })),
    rootDir,
  });
  assert.ok(tampered.failures.some((f) => f.includes("大きさが stub と違う")));

  // 素の側で ee を検出できない（検出が壊れた）と落ちる。
  const blind = evaluateEntry({
    name: "core",
    raw: emptyBundle,
    stubbed,
    stubLog,
    rootDir,
  });
  assert.ok(
    blind.failures.some((f) =>
      f.includes("陰性対照：素の bundle で ee の input"),
    ),
  );
  assert.ok(
    blind.failures.some((f) => f.includes("陰性対照：素の bundle の出力に")),
  );
  // 素の側に stub 版の出力を渡しても、固有の文字列が無いので落ちる。
  const staleMarkers = evaluateEntry({
    name: "core",
    raw: stubbed,
    stubbed,
    stubLog,
    rootDir,
  });
  assert.ok(
    staleMarkers.failures.some((f) => f.includes("固有の文字列が無い")),
  );

  // stub が当たっていない（ee の input が 0 件）と落ちる。
  const noStub = evaluateEntry({
    name: "core",
    raw,
    stubbed: emptyBundle,
    stubLog: [],
    rootDir,
  });
  assert.ok(noStub.failures.some((f) => f.includes("stub が当たっていない")));
});

test("@mastra/memory に ee の input があると、stub ありでも不合格になる（memory の ee は stub の対象外）", async () => {
  const raw = await bundleForInspection({ entry: "core", rootDir });
  const stubLog = [];
  const stubbed = await bundleForInspection({
    entry: "core",
    rootDir,
    plugins: [eeStubPlugin(stubLog)],
  });
  const memoryEeFile =
    "node_modules/.pnpm/m/node_modules/@mastra/memory/dist/ee/sub/index.js";
  const withMemoryEe = (bundle) => ({
    text: bundle.text,
    metafile: {
      inputs: { [memoryEeFile]: { bytes: 10 }, ...bundle.metafile.inputs },
      outputs: {
        out: {
          inputs: {
            [memoryEeFile]: { bytesInOutput: 10 },
            ...Object.values(bundle.metafile.outputs)[0].inputs,
          },
        },
      },
    },
  });
  const memory = evaluateEntry({
    name: "memory",
    raw: withMemoryEe(raw),
    stubbed: withMemoryEe(stubbed),
    stubLog,
    rootDir,
  });
  assert.equal(memory.ok, false);
  assert.ok(
    memory.failures.some((f) => f.includes("@mastra/memory に ee の input")),
  );
  assert.ok(
    memory.failures.some(
      (f) =>
        f.includes("stub を通っていない ee の input") &&
        f.includes(memoryEeFile),
    ),
  );
});

test("require() の経路（.cjs）：stub は .cjs にも当たる。ESM だけの stub では .cjs の ee が残り、検査が落とす", async () => {
  const eeEsmOnly =
    /[\\/]@mastra[\\/]core[\\/]dist[\\/](?:ee-[A-Za-z0-9_-]+\.m?js|(?:[^\\/]+[\\/])*ee[\\/](?:[^\\/]+[\\/])*[^\\/]+\.m?js)$/;
  const raw = await bundleForInspection({ entry: "require", rootDir });
  const rawEe = findEeInputs(raw.metafile).filter((i) => i.bytesInOutput > 0);
  // require の経路では .cjs の ee が解決される（ESM の .js ではない）。
  assert.ok(rawEe.length >= 1);
  assert.ok(
    rawEe.every((input) => input.path.endsWith(".cjs")),
    JSON.stringify(rawEe),
  );

  const logAll = [];
  const stubbedAll = await bundleForInspection({
    entry: "require",
    rootDir,
    plugins: [eeStubPlugin(logAll)],
  });
  const good = evaluateEntry({
    name: "require",
    raw,
    stubbed: stubbedAll,
    stubLog: logAll,
    rootDir,
  });
  assert.deepEqual(good.failures, []);
  assert.ok(
    logAll.length >= 2 && logAll.every((entry) => entry.path.endsWith(".cjs")),
  );

  const logEsm = [];
  const stubbedEsm = await bundleForInspection({
    entry: "require",
    rootDir,
    plugins: [eeStubPlugin(logEsm, { filter: eeEsmOnly })],
  });
  const bad = evaluateEntry({
    name: "require",
    raw,
    stubbed: stubbedEsm,
    stubLog: logEsm,
    rootDir,
  });
  assert.equal(bad.ok, false);
  assert.ok(
    bad.failures.some(
      (f) =>
        f.includes("stub を通っていない ee の input") && f.includes(".cjs"),
    ),
  );
  assert.ok(bad.failures.some((f) => f.includes("ee 固有の文字列が残る")));
});

test("ee/ の下の入れ子（auth/ee/sub/x.js）も stub になり、検出と棚卸しからすり抜けない（合成した fixture）", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mastra-ee-fixture-"));
  try {
    const pkg = path.join(dir, "node_modules", "@mastra", "core", "dist");
    const nested = path.join(pkg, "auth", "ee", "sub", "deeper");
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(
      path.join(pkg, "package.json"),
      JSON.stringify({
        name: "@mastra/core",
        exports: { "./real": "./real.js" },
      }),
    );
    fs.writeFileSync(
      path.join(nested, "x.js"),
      'export const ROLES = ["secret-ee-role"];\nexport function requireFGA() { return "REAL_EE_IMPLEMENTATION"; }\n',
    );
    fs.writeFileSync(
      path.join(dir, "node_modules", "@mastra", "core", "package.json"),
      JSON.stringify({
        name: "@mastra/core",
        exports: { "./x": "./dist/auth/ee/sub/deeper/x.js" },
      }),
    );
    const build = (plugins) =>
      esbuild.build({
        absWorkingDir: dir,
        stdin: {
          contents:
            'import { ROLES, requireFGA } from "@mastra/core/x"; export const used = [ROLES, requireFGA];',
          resolveDir: dir,
          loader: "ts",
        },
        bundle: true,
        platform: "node",
        format: "cjs",
        write: false,
        metafile: true,
        logLevel: "silent",
        plugins,
      });
    const raw = await build([]);
    const log = [];
    const stubbed = await build([eeStubPlugin(log)]);
    // 検出：入れ子の ee の input を見つける。
    const rawEe = findEeInputs(raw.metafile);
    assert.equal(rawEe.length, 1);
    assert.ok(rawEe[0].path.endsWith("auth/ee/sub/deeper/x.js"));
    assert.ok(raw.outputFiles[0].text.includes("REAL_EE_IMPLEMENTATION"));
    // stub：入れ子の file も stub になり、実装は出力に残らない。配列は空の配列。
    assert.equal(log.length, 1);
    const text = stubbed.outputFiles[0].text;
    assert.equal(text.includes("REAL_EE_IMPLEMENTATION"), false);
    assert.equal(text.includes("secret-ee-role"), false);
    assert.match(text, /__ee_\d+_ROLES = \[\]/);
    const result = evaluateEntry({
      name: "nested",
      raw: { text: raw.outputFiles[0].text, metafile: raw.metafile },
      stubbed: { text, metafile: stubbed.metafile },
      stubLog: log,
      rootDir: dir,
    });
    // 目印が fixture に無いので陰性対照だけが落ち、stub を通っていないという失敗は無い。
    assert.equal(
      result.failures.some((f) => f.includes("stub を通っていない")),
      false,
    );
    // 棚卸し：pnpm の store 形式の fixture で、入れ子のディレクトリが列挙される。
    const store = path.join(
      dir,
      "node_modules",
      ".pnpm",
      "@mastra+core@9",
      "node_modules",
      "@mastra",
      "core",
      "dist",
      "auth",
      "ee",
      "sub",
      "deeper",
    );
    fs.mkdirSync(store, { recursive: true });
    assert.deepEqual(inventoryEeEntries(dir), [
      "@mastra/core/dist/auth/ee",
      "@mastra/core/dist/auth/ee/sub",
      "@mastra/core/dist/auth/ee/sub/deeper",
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ee 固有の目印は、ee の外の Apache-2.0 の部分（source map の sourcesContent）に当たらない", async () => {
  const oldMarkers = ["captureEEEvent", "ee_feature_used", "ee_license_check"];
  const log = [];
  const stubbed = await bundleForInspection({
    entry: "core",
    rootDir,
    plugins: [eeStubPlugin(log)],
    sourcemap: "external",
  });
  const raw = await bundleForInspection({
    entry: "core",
    rootDir,
    sourcemap: "external",
  });
  // 素の側は、本文にも map にも目印が出る（目印として有効）。
  for (const marker of EE_CONTENT_MARKERS) {
    assert.ok(raw.text.includes(marker), `素の本文に ${marker}`);
    assert.ok(raw.mapText.includes(marker), `素の map に ${marker}`);
  }
  // stub ありは、本文にも map にも目印が無い。
  for (const marker of EE_CONTENT_MARKERS) {
    assert.equal(
      stubbed.text.includes(marker),
      false,
      `stub の本文に ${marker}`,
    );
    assert.equal(
      stubbed.mapText.includes(marker),
      false,
      `stub の map に ${marker}`,
    );
  }
  // ee の外の部分（telemetry）の文字列は、stub ありの map に残る。これらを目印にすると誤って不合格になる。
  for (const marker of oldMarkers) {
    assert.equal(EE_CONTENT_MARKERS.includes(marker), false, marker);
    assert.ok(
      stubbed.mapText.includes(marker),
      `Apache の部分の ${marker} が map に残る`,
    );
  }
});

test("findEeInputs は tree-shake で出力から消えた input を bytesInOutput 0 として区別する", () => {
  const file = "node_modules/@mastra/core/dist/ee-aaa.js";
  const metafile = {
    inputs: { [file]: { bytes: 100 }, "src/app.ts": { bytes: 5 } },
    outputs: { out: { inputs: { "src/app.ts": { bytesInOutput: 5 } } } },
  };
  assert.deepEqual(findEeInputs(metafile), [
    { path: file, bytes: 100, bytesInOutput: 0 },
  ]);
  assert.deepEqual(findMastraInputs(metafile), [file]);
});

test("MP-1：製品の main bundle に @mastra/* は入らない（MP-3 で ee の検査に差し替える）", async () => {
  const product = await productBundleMastraInputs(rootDir);
  assert.ok(product.inputs > 100, "製品の bundle を組めている");
  assert.deepEqual(product.mastraInputs, []);
});

test("Mastra の版が変わる PR（package.json／lockfile）で、この検査が必ず走る CI の配線", () => {
  const scope = JSON.parse(
    fs.readFileSync(
      path.join(repoRoot, "scripts/ci-change-scope.json"),
      "utf8",
    ),
  );
  // 変更範囲の絞り込みは forceAll に当たる path では行わない。
  for (const pattern of ["package.json", "pnpm-lock.yaml", "electron/**"]) {
    assert.ok(scope.forceAll.includes(pattern), `forceAll に ${pattern}`);
  }
  // electron job は、どの lane の gatedJobs／cascadeJobs にも入っておらず、絞り込みで skip されない。
  for (const [lane, config] of Object.entries(scope.lanes)) {
    for (const job of [
      ...(config.gatedJobs ?? []),
      ...(config.cascadeJobs ?? []),
    ]) {
      assert.notEqual(
        job,
        "electron",
        `${lane} が electron job を skip しうる`,
      );
    }
  }
  const workflow = yaml.load(
    fs.readFileSync(path.join(repoRoot, ".github/workflows/ci.yml"), "utf8"),
  );
  const step = workflow.jobs.electron.steps.find(
    (candidate) =>
      typeof candidate.run === "string" && candidate.run.includes(SELF),
  );
  assert.ok(step, "ci.yml の electron job が ee の検査の試験を走らせる");
  assert.equal(step.if, "${{ !inputs.source_focused }}");
  const registry = JSON.parse(
    fs.readFileSync(
      path.join(repoRoot, "scripts/local-ci-registry.json"),
      "utf8",
    ),
  );
  const contracts = registry.stages.electron.commands.find(
    ({ id }) => id === "electron.contracts",
  );
  assert.ok(
    contracts.args.includes(SELF),
    "local CI の electron.contracts に登録",
  );
  assert.equal(registry.hostedJobs.electron.localStage, "electron");

  // asar の検査（package-check）の試験も同じ所に登録し、実物の asar の検査（packaged-smoke）は、
  // 依存・配布の設定・ee の識別子が変わる PR で走る。
  const PACKAGE_CHECK =
    "electron/scripts/packaged-smoke/package-check.test.mjs";
  assert.ok(
    contracts.args.includes(PACKAGE_CHECK),
    "package-check の試験を登録",
  );
  assert.ok(
    workflow.jobs.electron.steps.some(
      (candidate) =>
        typeof candidate.run === "string" &&
        candidate.run.includes(PACKAGE_CHECK),
    ),
    "ci.yml の electron job が package-check の試験を走らせる",
  );
  const smoke = yaml.load(
    fs.readFileSync(
      path.join(repoRoot, ".github/workflows/packaged-smoke.yml"),
      "utf8",
    ),
  );
  for (const trigger of [
    "package.json",
    "pnpm-lock.yaml",
    "electron-builder.yml",
    "electron/scripts/mastra-ee-*.mjs",
    "electron/scripts/packaged-smoke/**",
  ]) {
    assert.ok(
      smoke.on.pull_request.paths.includes(trigger),
      `packaged-smoke.yml の PR の paths に ${trigger}`,
    );
  }
});

test("Mastra は exact pin で手動でだけ上げる：dependabot の npm から @mastra/* を外している", () => {
  const dependabot = yaml.load(
    fs.readFileSync(path.join(repoRoot, ".github/dependabot.yml"), "utf8"),
  );
  const npm = dependabot.updates.find(
    (update) => update["package-ecosystem"] === "npm",
  );
  assert.ok(npm.ignore.some((rule) => rule["dependency-name"] === "@mastra/*"));
  const manifest = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"),
  );
  for (const name of ["@mastra/core", "@mastra/memory"]) {
    assert.match(
      manifest.dependencies[name],
      /^\d+\.\d+\.\d+$/,
      `${name} は exact pin`,
    );
  }
});

test("inventoryEeEntries は pnpm の store に無い root では空を返す", () => {
  assert.deepEqual(inventoryEeEntries(path.join(repoRoot, "nonexistent")), []);
});
