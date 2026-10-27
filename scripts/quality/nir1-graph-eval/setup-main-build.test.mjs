// CP-4 S1j-2: setup 専用の Main の build と admission（B1）。esbuild は fake で、
// 製品の Main は一時の directory の bytes。凍結した fixture は読むだけ。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import {
  CORPUS_IMPORTER,
  CORPUS_MODULE,
  FAKE_AI_ENV,
  SETUP_MAIN,
  SETUP_TABLE_LANGUAGE,
  assertOneInputDiff,
  assertSetupMainAtLaunch,
  buildSetupMain,
  corpusAliasPlugin,
  irTableRows,
  isSetupMainAdmission,
  setupIrTable,
} from "./setup-main-build.mjs";

function scratch(prefix) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const sha = (text) => createHash("sha256").update(text).digest("hex");

const CORPUS = Object.freeze({
  schemaVersion: "corpus/1",
  languages: {
    en: {
      scenes: [
        {
          id: "c1",
          title: "T",
          body: "A corpus body.",
          interpretationSeed: {
            summary: "A corpus summary.",
            actuality: "actual",
            attribution: "narrator",
            narrativeFrame: "story-world",
          },
        },
      ],
    },
  },
});
const ROW = Object.freeze({
  caseId: "G-09",
  id: "g09-ir",
  title: "IR",
  body: "An IR body.",
  interpretationSeed: {
    summary: "An IR summary.",
    actuality: "actual",
    attribution: "narrator",
    narrativeFrame: "story-world",
  },
});

test("表: fixture の qualifiedIr の行を Scene の本文と title で写し、corpus に 1 つの言語として足す。本文か要約が重なれば（provider が曖昧になる）拒む", () => {
  const rows = irTableRows([
    {
      caseId: "G-09",
      fixture: {
        scenes: [{ id: "g09-ir", title: "IR", body: "An IR body." }],
        qualifiedIr: [{ sceneId: "g09-ir", ...ROW.interpretationSeed }],
      },
    },
  ]);
  assert.deepEqual(rows, [ROW]);
  const table = setupIrTable({ corpus: CORPUS, rows });
  assert.deepEqual(table.languages.en, CORPUS.languages.en);
  assert.deepEqual(table.languages[SETUP_TABLE_LANGUAGE].scenes, [
    {
      id: "g09-ir",
      title: "IR",
      body: "An IR body.",
      interpretationSeed: ROW.interpretationSeed,
    },
  ]);
  for (const bad of [
    { ...ROW, body: "A corpus body." },
    {
      ...ROW,
      interpretationSeed: {
        ...ROW.interpretationSeed,
        summary: "A corpus summary.",
      },
    },
  ])
    assert.throws(
      () => setupIrTable({ corpus: CORPUS, rows: [bad] }),
      /\[precheck\] S1j-2 ir-table/u,
    );
  assert.throws(
    () => setupIrTable({ corpus: CORPUS, rows: [] }),
    /\[precheck\] S1j-2 ir-table/u,
  );
  // A row whose Scene the fixture lacks, or a missing seed field.
  assert.throws(
    () =>
      irTableRows([
        {
          caseId: "G-09",
          fixture: { scenes: [], qualifiedIr: [{ sceneId: "x" }] },
        },
      ]),
    /\[precheck\] S1j-2 ir-table/u,
  );
  assert.throws(
    () =>
      irTableRows([
        {
          caseId: "G-09",
          fixture: {
            scenes: [{ id: "g09-ir", title: "IR", body: "An IR body." }],
            qualifiedIr: [{ sceneId: "g09-ir", summary: "s" }],
          },
        },
      ]),
    /\[precheck\] S1j-2 ir-table/u,
  );
});

test("alias の plugin は corpus の import を、その 1 つの importer のときだけ表に向ける", () => {
  const root = "/repo";
  const state = { redirected: [], otherImporters: [] };
  let resolve = null;
  corpusAliasPlugin({ root, tablePath: "/out/ir-table.json", state }).setup({
    onResolve: (_filter, fn) => {
      resolve = fn;
    },
  });
  assert.deepEqual(
    resolve({
      path: "../../evals/nir1-retrieval/corpus.json",
      resolveDir: "/repo/electron/main",
      importer: `/repo/${CORPUS_IMPORTER}`,
    }),
    { path: "/out/ir-table.json" },
  );
  assert.equal(
    resolve({
      path: "../../evals/nir1-retrieval/corpus.json",
      resolveDir: "/repo/electron/main",
      importer: "/repo/electron/main/other.ts",
    }),
    undefined,
  );
  assert.equal(
    resolve({
      path: "./corpus.json",
      resolveDir: "/repo/elsewhere",
      importer: `/repo/${CORPUS_IMPORTER}`,
    }),
    undefined,
  );
  assert.deepEqual(state, {
    redirected: [CORPUS_IMPORTER],
    otherImporters: ["electron/main/other.ts"],
  });
});

test("admission: input の差は corpus → 表の 1 file だけ（ほかの file の差、別の importer、alias の不適用を拒む）", () => {
  const root = "/repo";
  const tablePath = "/repo/.artifacts/cp4/r/setup-main/ir-table.json";
  const table = ".artifacts/cp4/r/setup-main/ir-table.json";
  const product = {
    inputs: { "a.ts": { bytes: 1 }, [CORPUS_MODULE]: { bytes: 9 } },
  };
  const setup = { inputs: { "a.ts": { bytes: 1 }, [table]: { bytes: 12 } } };
  const state = { redirected: [CORPUS_IMPORTER], otherImporters: [] };
  assert.deepEqual(
    assertOneInputDiff({ root, product, setup, tablePath, state }),
    { removed: [CORPUS_MODULE], added: [table], inputs: 2 },
  );
  for (const [label, args] of [
    [
      "another input",
      { setup: { inputs: { ...setup.inputs, "b.ts": { bytes: 1 } } } },
    ],
    [
      "a changed input",
      { setup: { inputs: { "a.ts": { bytes: 2 }, [table]: { bytes: 12 } } } },
    ],
    ["the corpus kept", { setup: { inputs: { ...product.inputs } } }],
    [
      "a product input dropped",
      {
        product: {
          inputs: { ...product.inputs, "c.ts": { bytes: 3 } },
        },
      },
    ],
    [
      "another importer",
      { state: { ...state, otherImporters: ["electron/main/x.ts"] } },
    ],
    ["no alias", { state: { redirected: [], otherImporters: [] } }],
  ])
    assert.throws(
      () =>
        assertOneInputDiff({
          root,
          product,
          setup,
          tablePath,
          state,
          ...args,
        }),
      /\[precheck\] S1j-2 setup-main/u,
      label,
    );
});

/** A repository with a product Main and a fake esbuild over it. */
function fakeRepo({ reproduces = true } = {}) {
  const root = scratch("cp4-s1j2-main-");
  mkdirSync(path.join(root, "dist-electron"));
  mkdirSync(path.join(root, "evals/nir1-retrieval"), { recursive: true });
  writeFileSync(
    path.join(root, "evals/nir1-retrieval/corpus.json"),
    JSON.stringify(CORPUS),
  );
  writeFileSync(path.join(root, "dist-electron/main.cjs"), "PRODUCT MAIN");
  const builds = [];
  const build = async (options) => {
    builds.push(options);
    const plugin = (options.plugins ?? []).find(
      (row) => row.name === "cp4-setup-ir-corpus-alias",
    );
    let table = null;
    if (plugin)
      plugin.setup({
        onResolve: (_filter, fn) => {
          table = fn({
            path: "../../evals/nir1-retrieval/corpus.json",
            resolveDir: path.join(root, "electron/main"),
            importer: path.join(root, CORPUS_IMPORTER),
          }).path;
        },
      });
    writeFileSync(
      options.outfile,
      plugin ? `SETUP MAIN ${table}` : reproduces ? "PRODUCT MAIN" : "OTHER",
    );
    return {
      metafile: {
        inputs: {
          "electron/main/index.ts": { bytes: 10 },
          ...(table
            ? { [path.relative(root, table)]: { bytes: 20 } }
            : { [CORPUS_MODULE]: { bytes: 15 } }),
        },
      },
    };
  };
  return {
    root,
    builds,
    deps: {
      build,
      bundleConfigs: [
        { outfile: path.join(root, "dist-electron/main.cjs"), bundle: true },
        { outfile: path.join(root, "dist-electron/preload.cjs") },
      ],
    },
  };
}

test("build: 同じ command で製品の Main を作り直して byte で一致、setup 専用の Main を dist-electron/main-setup-ir.cjs に、manifest と封印した admission", async () => {
  const repo = fakeRepo();
  const outDir = path.join(repo.root, ".artifacts/cp4/r/setup-main");
  const admission = await buildSetupMain({
    root: repo.root,
    outDir,
    rows: [ROW],
    source: "frozen",
    candidate: { commit: "c" },
    deps: repo.deps,
  });
  assert.equal(isSetupMainAdmission(admission), true);
  assert.equal(isSetupMainAdmission({ ...admission }), false);
  assert.equal(admission.productMain.sha256, sha("PRODUCT MAIN"));
  assert.equal(admission.reproducedProductMainSha256, sha("PRODUCT MAIN"));
  assert.equal(admission.setupMain.path, SETUP_MAIN);
  assert.deepEqual(admission.inputDiff.removed, [CORPUS_MODULE]);
  assert.deepEqual(admission.table.rows, [
    { caseId: "G-09", sceneId: "g09-ir" },
  ]);
  assert.deepEqual(admission.env, FAKE_AI_ENV);
  // Both builds used the product's main.cjs options (same command).
  assert.equal(repo.builds.length, 2);
  for (const options of repo.builds) {
    assert.equal(options.bundle, true);
    assert.equal(options.absWorkingDir, repo.root);
  }
  assert.equal(repo.builds[1].outfile, path.join(repo.root, SETUP_MAIN));
  // At launch the Main still has the admitted bytes; a rebuilt or unsealed
  // one is refused.
  const launch = assertSetupMainAtLaunch(admission);
  assert.equal(launch.mainPath, path.join(repo.root, SETUP_MAIN));
  assert.deepEqual(launch.env, FAKE_AI_ENV);
  assert.throws(
    () => assertSetupMainAtLaunch({ ...admission }),
    /\[precheck\] S1j-2 setup-main/u,
  );
  writeFileSync(path.join(repo.root, SETUP_MAIN), "CHANGED");
  assert.throws(
    () => assertSetupMainAtLaunch(admission),
    /\[precheck\] S1j-2 setup-main/u,
  );
  // One build per run directory.
  await assert.rejects(
    buildSetupMain({
      root: repo.root,
      outDir,
      rows: [ROW],
      source: "frozen",
      deps: repo.deps,
    }),
    /\[precheck\] S1j-2 setup-main/u,
  );
});

test("build: 同じ command が製品の Main を再現しなければ止まる", async () => {
  const repo = fakeRepo({ reproduces: false });
  await assert.rejects(
    buildSetupMain({
      root: repo.root,
      outDir: path.join(repo.root, ".artifacts/cp4/r/setup-main"),
      rows: [ROW],
      source: "frozen",
      deps: repo.deps,
    }),
    /does not reproduce/u,
  );
});
