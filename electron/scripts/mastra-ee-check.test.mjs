/**
 * Mastra の ee の stub と検査（mastra-ee-stub-plugin.mjs、mastra-ee-check.mjs）の試験。
 * 実際の `@mastra/core`／`@mastra/memory` を esbuild で bundle する（file には書かない）。
 * 検査そのものが壊れて「0 件で通る」ことを防ぐため、陰性対照と失敗の分岐も試す。
 *
 * 実行: node --test electron/scripts/mastra-ee-check.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
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
  eeStubPlugin,
  exportedPairs,
  stubSource,
} from "./mastra-ee-stub-plugin.mjs";

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

test("exportedPairs は export の各形から公開名を取り、未対応の形は throw する", () => {
  assert.deepEqual(
    exportedPairs('export { a, b as c } from "./x.js";\nexport { d as D };'),
    [
      { local: "a", exported: "a" },
      { local: "b", exported: "c" },
      { local: "d", exported: "D" },
    ],
  );
  assert.deepEqual(
    exportedPairs(
      "export const A = 1;\nexport async function f() {}\nexport class K {}\nexport let z = 0;",
    ).map((pair) => pair.exported),
    ["A", "f", "K", "z"],
  );
  assert.throws(() => exportedPairs("export default 1;"), /未対応/);
  assert.throws(() => exportedPairs('export * from "./x.js";'), /未対応/);
});

test("EE_INPUT は stub の対象より広く（.cjs・.map・他の package・_types）取り、ee の無い path は拾わない", () => {
  const ee = [
    "node_modules/.pnpm/x/node_modules/@mastra/core/dist/ee-abc123.js",
    "node_modules/.pnpm/x/node_modules/@mastra/core/dist/ee-abc123.cjs",
    "node_modules/.pnpm/x/node_modules/@mastra/core/dist/ee-abc123.js.map",
    "node_modules/.pnpm/x/node_modules/@mastra/core/dist/auth/ee/index.js",
    "node_modules/.pnpm/x/node_modules/@mastra/core/dist/_types/@internal_auth@1.0.0/dist/ee/index.d.ts",
    "node_modules/.pnpm/y/node_modules/@mastra/memory/dist/ee/index.js",
    "node_modules/.pnpm/y/node_modules/@mastra/editor/dist/ee-zzz.js",
    "node_modules\\.pnpm\\x\\node_modules\\@mastra\\core\\dist\\auth\\ee\\index.js",
  ];
  for (const file of ee) assert.ok(EE_INPUT.test(file), file);
  const notEe = [
    "node_modules/.pnpm/x/node_modules/@mastra/core/dist/agent/index.js",
    "node_modules/.pnpm/x/node_modules/@mastra/core/dist/free-chunk.js",
    "node_modules/.pnpm/x/node_modules/@mastra/core/dist/employee/index.js",
    "node_modules/zod/index.js",
    "electron/main/ee-notes.ts",
  ];
  for (const file of notEe) assert.equal(EE_INPUT.test(file), false, file);
  // stub の対象は ESM の core の ee だけ。広い検出との差が「stub を通っていない input」として落ちる。
  assert.ok(EE_STUB_FILE.test(ee[0]));
  for (const file of [ee[1], ee[2], ee[5], ee[6]]) {
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
    relative.some((file) => /^ee-[^/]+\.js$/.test(file)) &&
      relative.includes("auth/ee/index.js") &&
      relative.includes("auth/ee/fga-check.js") &&
      relative.includes("agent-builder/ee/index.js"),
    `ee の file を想定どおり見つけられない: ${relative.join(", ")}`,
  );
  const seen = { requireFGA: 0, checkFGA: 0, rbac: 0, isEEEnabled: 0 };
  for (const file of files) {
    const pairs = exportedPairs(fs.readFileSync(file, "utf8"));
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
  }
  // 振る舞いの分類が全部 undefined に落ちる欠陥（S2 追補）の再発を防ぐ。
  assert.ok(
    Object.values(seen).every((count) => count >= 2),
    JSON.stringify(seen),
  );
});

test("陰性対照と陽性：素の bundle で ee を検出でき、stub を当てると stub だけになる（core だけ／core＋memory）", async () => {
  const result = await checkMastraEe({ rootDir });
  assert.deepEqual(result.failures, []);
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.entries.map((entry) => entry.name),
    ["core", "memory"],
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

test("検査の失敗の分岐：stub なし・大きさの食い違い・検出の欠落・他の package の ee を落とす", async () => {
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

  // 他の package（memory）の ee は、stub の対象外なので「stub を通っていない」で落ちる。
  const memoryEe = {
    text: raw.text,
    metafile: {
      inputs: {
        "node_modules/.pnpm/m/node_modules/@mastra/memory/dist/ee/index.js": {
          bytes: 10,
        },
        ...raw.metafile.inputs,
      },
      outputs: {
        out: {
          inputs: {
            "node_modules/.pnpm/m/node_modules/@mastra/memory/dist/ee/index.js":
              { bytesInOutput: 10 },
            ...Object.values(raw.metafile.outputs)[0].inputs,
          },
        },
      },
    },
  };
  const memory = evaluateEntry({
    name: "memory",
    raw: memoryEe,
    stubbed: memoryEe,
    stubLog,
    rootDir,
  });
  assert.ok(
    memory.failures.some((f) => f.includes("@mastra/memory に ee の input")),
  );
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
});

test("inventoryEeEntries は pnpm の store に無い root では空を返す", () => {
  assert.deepEqual(inventoryEeEntries(path.join(repoRoot, "nonexistent")), []);
});
