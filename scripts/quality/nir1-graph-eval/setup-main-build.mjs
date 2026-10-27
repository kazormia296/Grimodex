// CP-4 S1j-2: setup 専用の Main（DR-CP4-L-1。integrator の決定 B1 (i)）。
//
// qualified-ir の段（Chronicle の抽出 → child → Decision）だけが使う Main を、
// 製品の Main と同じ build の command（`electron/scripts/build.mjs` の
// `bundleConfigs[0]`、esbuild）で作る。違いは 1 つだけ:
// `electron/main/productJourneyNir1Ai.ts` が import する
// `evals/nir1-retrieval/corpus.json` を、harness の build が書く表
// （24 件の corpus をそのまま写し、`cp4-setup-ir` の言語に fixture の qualifiedIr
// の行を足したもの）に向ける。決定論の provider は製品のままの gate
// （unpackaged、`GRIMODEX_PRODUCT_JOURNEY_FAKE_AI=deterministic-v1`）の後ろで、
// 表の本文と一致する Scene にだけ答える（K2/4 :352、:99）。
//
//   - 表は fixture から導く（凍結した G-case は凍結の bytes を照合してから読む）。
//     表は harness の build の出力（`.artifacts/cp4/<run>/setup-main/`）にだけ置き、
//     sha256 を manifest と受領書に残す。製品の file は変えない。
//   - admission: 同じ候補から同じ build の command で製品の Main を作り直し、
//     `dist-electron/main.cjs` と byte で同じであること（同じ command であること）、
//     setup 専用の Main の input の差が corpus → 表の 1 file だけであることを
//     metafile で照合する。admission は module の WeakSet で封印し、session は
//     封印した admission の Main だけを起動する（測定の Main には使わない）。
//   - 出力の Main は `dist-electron/main-setup-ir.cjs`（Main は `__dirname/..` を
//     repository の root として resource を解決するため、同じ directory に置く）。

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const SETUP_MAIN_SCHEMA = "nir1-cp4-setup-main/1";
/** The setup-only Main, beside the product Main (same resource root). */
export const SETUP_MAIN = "dist-electron/main-setup-ir.cjs";
export const PRODUCT_MAIN_PATH = "dist-electron/main.cjs";
/** The one import the setup-only Main redirects, and its only importer. */
export const CORPUS_MODULE = "evals/nir1-retrieval/corpus.json";
export const CORPUS_IMPORTER = "electron/main/productJourneyNir1Ai.ts";
/** The language key the table adds to the corpus (never a corpus language). */
export const SETUP_TABLE_LANGUAGE = "cp4-setup-ir";
export const SETUP_TABLE_FILE = "ir-table.json";
export const SETUP_MAIN_MANIFEST = "setup-main.json";
/** Review P3 (a): the table's directory (one per source, run independent). */
export const SETUP_TABLE_PARENT = ".artifacts/cp4/setup-main-table";

function tableSlug(source) {
  const slug = String(source ?? "").replace(/[^A-Za-z0-9._-]+/gu, "-");
  if (!/^[A-Za-z0-9]/u.test(slug))
    fail("setup-main", `the table source ${String(source)} has no name`);
  return slug;
}
/** The env gate of the product's deterministic Journey provider. */
export const FAKE_AI_ENV = Object.freeze({
  GRIMODEX_PRODUCT_JOURNEY_FAKE_AI: "deterministic-v1",
});
export const SETUP_MAIN_PLUGIN = "cp4-setup-ir-corpus-alias";

const ADMITTED = new WeakSet();

function fail(code, detail) {
  throw new Error(`[precheck] S1j-2 ${code}: ${detail}`);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

const nonBlank = (value) =>
  typeof value === "string" && value.trim().length > 0;

/**
 * The table rows of fixtures' `qualifiedIr` (in the given order): each row is
 * the provider's Scene (`id` the logical Scene ID, the fixture's title and
 * body, the interpretation seed). `[precheck]` when a row names no Scene of
 * its fixture or lacks a seed field.
 */
export function irTableRows(sources) {
  const rows = [];
  for (const { caseId, fixture } of sources)
    for (const ir of fixture?.qualifiedIr ?? []) {
      const scene = (fixture.scenes ?? []).find(
        (row) => row?.id === ir?.sceneId,
      );
      if (!scene || !nonBlank(scene.body) || !nonBlank(scene.title))
        fail(
          "ir-table",
          `${caseId}: the qualifiedIr Scene ${String(ir?.sceneId)} is not a Scene with a body`,
        );
      for (const field of [
        "summary",
        "actuality",
        "attribution",
        "narrativeFrame",
      ])
        if (!nonBlank(ir[field]))
          fail("ir-table", `${caseId}: ${ir.sceneId} has no ${field}`);
      rows.push({
        caseId,
        id: ir.sceneId,
        title: scene.title,
        body: scene.body,
        interpretationSeed: {
          summary: ir.summary,
          actuality: ir.actuality,
          attribution: ir.attribution,
          narrativeFrame: ir.narrativeFrame,
        },
      });
    }
  return rows;
}

/**
 * The provider's table: the corpus as it is, plus one language holding the
 * rows. The provider matches a Scene by its exact body (observation) and by
 * its exact summary (synthesis), and throws on two matches, so every body
 * and every summary must be distinct across the corpus and the rows.
 */
export function setupIrTable({ corpus, rows }) {
  if (!corpus?.languages || typeof corpus.languages !== "object")
    fail("ir-table", "the corpus has no languages");
  if (Object.hasOwn(corpus.languages, SETUP_TABLE_LANGUAGE))
    fail("ir-table", `the corpus already has ${SETUP_TABLE_LANGUAGE}`);
  if (!Array.isArray(rows) || rows.length === 0)
    fail("ir-table", "no qualifiedIr row");
  const scenes = Object.values(corpus.languages).flatMap(
    (language) => language.scenes ?? [],
  );
  const bodies = new Map();
  const summaries = new Map();
  for (const scene of [...scenes, ...rows]) {
    const body = String(scene.body).trim();
    if (bodies.has(body))
      fail(
        "ir-table",
        `two Scenes share a body (${bodies.get(body)}, ${scene.id})`,
      );
    bodies.set(body, scene.id);
    const summary = scene.interpretationSeed?.summary;
    if (summary === undefined) continue;
    if (summaries.has(summary))
      fail(
        "ir-table",
        `two Scenes share a summary (${summaries.get(summary)}, ${scene.id})`,
      );
    summaries.set(summary, scene.id);
  }
  if (new Set(rows.map((row) => row.id)).size !== rows.length)
    fail("ir-table", "two rows share a Scene ID");
  return {
    ...corpus,
    languages: {
      ...corpus.languages,
      [SETUP_TABLE_LANGUAGE]: {
        scenes: rows.map((row) => ({
          id: row.id,
          title: row.title,
          body: row.body,
          interpretationSeed: { ...row.interpretationSeed },
        })),
      },
    },
  };
}

export function tableBytes(table) {
  return Buffer.from(`${JSON.stringify(table, null, 2)}\n`, "utf8");
}

/**
 * The esbuild plugin: the corpus import of the one importer resolves to the
 * table; any other importer of the corpus is recorded (and refused after the
 * build).
 */
export function corpusAliasPlugin({ root, tablePath, state }) {
  const corpus = path.join(root, CORPUS_MODULE);
  const importer = path.join(root, CORPUS_IMPORTER);
  return {
    name: SETUP_MAIN_PLUGIN,
    setup(build) {
      build.onResolve({ filter: /corpus\.json$/ }, (args) => {
        const resolved = path.resolve(args.resolveDir, args.path);
        if (resolved !== corpus) return undefined;
        if (args.importer === importer) {
          state.redirected.push(path.relative(root, args.importer));
          return { path: tablePath };
        }
        state.otherImporters.push(path.relative(root, args.importer));
        return undefined;
      });
    },
  };
}

/**
 * The admission's comparison of the two builds' metafile inputs: the setup
 * Main reads exactly the product Main's inputs with the corpus replaced by
 * the table (one file), and the alias applied to the one importer only.
 */
export function assertOneInputDiff({ root, product, setup, tablePath, state }) {
  const productInputs = Object.keys(product?.inputs ?? {}).sort();
  const setupInputs = Object.keys(setup?.inputs ?? {}).sort();
  const table = path.relative(root, tablePath);
  const removed = productInputs.filter((name) => !setupInputs.includes(name));
  const added = setupInputs.filter((name) => !productInputs.includes(name));
  const problems = [];
  if (JSON.stringify(removed) !== JSON.stringify([CORPUS_MODULE]))
    problems.push(`removed inputs ${JSON.stringify(removed)}`);
  if (JSON.stringify(added) !== JSON.stringify([table]))
    problems.push(`added inputs ${JSON.stringify(added)}`);
  for (const name of productInputs)
    if (
      name !== CORPUS_MODULE &&
      product.inputs[name]?.bytes !== setup.inputs[name]?.bytes
    )
      problems.push(`input ${name} differs in size`);
  if (
    JSON.stringify(state?.redirected ?? []) !==
    JSON.stringify([CORPUS_IMPORTER])
  )
    problems.push(
      `the alias applied to ${JSON.stringify(state?.redirected ?? [])}`,
    );
  if ((state?.otherImporters ?? []).length > 0)
    problems.push(
      `another importer reads the corpus: ${state.otherImporters.join(", ")}`,
    );
  if (problems.length > 0)
    fail(
      "setup-main",
      `the setup-only Main is not the product build with one input replaced: ${problems.join("; ")}`,
    );
  return { removed, added, inputs: setupInputs.length };
}

/**
 * Builds the setup-only Main for one run and returns its sealed admission.
 * `outDir` is the run's own new directory (the table, the reproduced product
 * Main and the manifest go there); the Main itself goes to `SETUP_MAIN`.
 * `deps.build` replaces esbuild (tests).
 */
export async function buildSetupMain({
  root,
  outDir,
  rows,
  source,
  candidate = null,
  deps = {},
}) {
  const esbuild = deps.build ?? (await import("esbuild")).default.build;
  const configs =
    deps.bundleConfigs ??
    (await import("../../../electron/scripts/build.mjs")).bundleConfigs;
  if (existsSync(outDir))
    fail("setup-main", `${outDir} already exists (one build per run)`);
  await mkdir(path.join(outDir, "repro"), { recursive: true });
  const corpus = JSON.parse(
    readFileSync(path.join(root, CORPUS_MODULE), "utf8"),
  );
  const table = setupIrTable({ corpus, rows });
  // Review P3 (a): the table sits at one path per source (its path is in the
  // bundle's comments), so the setup-only Main's bytes do not depend on the
  // run; the bytes are the fixture's rows (rewritten, never appended).
  const tablePath = path.join(
    root,
    SETUP_TABLE_PARENT,
    tableSlug(source),
    SETUP_TABLE_FILE,
  );
  await mkdir(path.dirname(tablePath), { recursive: true });
  const bytes = tableBytes(table);
  await writeFile(tablePath, bytes);
  const main = configs.find(
    (row) => path.basename(row.outfile ?? "") === "main.cjs",
  );
  if (!main) fail("setup-main", "electron/scripts/build.mjs has no main.cjs");
  const options = { ...main, absWorkingDir: root, metafile: true };
  // The same command reproduces the product Main (byte for byte).
  const reproFile = path.join(outDir, "repro", "main.cjs");
  const product = await esbuild({
    ...options,
    outfile: reproFile,
    logLevel: "error",
  });
  const productMainSha256 = sha256(
    await readFile(path.join(root, PRODUCT_MAIN_PATH)),
  );
  const reproducedSha256 = sha256(await readFile(reproFile));
  if (reproducedSha256 !== productMainSha256)
    fail(
      "setup-main",
      `the build command does not reproduce ${PRODUCT_MAIN_PATH} (${reproducedSha256} ≠ ${productMainSha256})`,
    );
  const state = { redirected: [], otherImporters: [] };
  const setupFile = path.join(root, SETUP_MAIN);
  const setup = await esbuild({
    ...options,
    outfile: setupFile,
    logLevel: "error",
    plugins: [
      ...(options.plugins ?? []),
      corpusAliasPlugin({ root, tablePath, state }),
    ],
  });
  const diff = assertOneInputDiff({
    root,
    product: product.metafile,
    setup: setup.metafile,
    tablePath,
    state,
  });
  const setupMainSha256 = sha256(await readFile(setupFile));
  if (setupMainSha256 === productMainSha256)
    fail("setup-main", "the setup-only Main equals the product Main");
  const manifest = {
    schema: SETUP_MAIN_SCHEMA,
    source,
    candidate,
    buildCommand:
      "electron/scripts/build.mjs bundleConfigs (main.cjs; esbuild, absWorkingDir = root) + the corpus alias of electron/main/productJourneyNir1Ai.ts",
    productMain: { path: PRODUCT_MAIN_PATH, sha256: productMainSha256 },
    reproducedProductMainSha256: reproducedSha256,
    setupMain: { path: SETUP_MAIN, sha256: setupMainSha256 },
    table: {
      path: path.relative(root, tablePath),
      sha256: sha256(bytes),
      language: SETUP_TABLE_LANGUAGE,
      rows: rows.map((row) => ({ caseId: row.caseId, sceneId: row.id })),
    },
    inputDiff: diff,
    env: { ...FAKE_AI_ENV },
  };
  await writeFile(
    path.join(outDir, SETUP_MAIN_MANIFEST),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  const sealed = deepFreeze({
    ...manifest,
    root,
    mainPath: setupFile,
  });
  ADMITTED.add(sealed);
  return sealed;
}

export function isSetupMainAdmission(value) {
  return value !== null && typeof value === "object" && ADMITTED.has(value);
}

/**
 * At a launch: the admission is sealed and the Main at its path still has
 * the admitted bytes. Returns the absolute Main path and the env to add.
 */
export function assertSetupMainAtLaunch(
  admission,
  { hashFile = (file) => sha256(readFileSync(file)) } = {},
) {
  if (!isSetupMainAdmission(admission))
    fail("setup-main", "the setup-only Main launches only with its admission");
  const digest = (() => {
    try {
      return hashFile(admission.mainPath);
    } catch {
      return null;
    }
  })();
  if (digest !== admission.setupMain.sha256)
    fail(
      "setup-main",
      `${SETUP_MAIN} is not the admitted bytes (it changed after the build)`,
    );
  return {
    mainPath: admission.mainPath,
    env: { ...FAKE_AI_ENV },
    record: {
      kind: "setup-ir",
      path: SETUP_MAIN,
      sha256: admission.setupMain.sha256,
      tableSha256: admission.table.sha256,
    },
  };
}

/**
 * Review P3 (c): the setup-only Main lies under `dist-electron/`, which the
 * packaging takes whole (`electron-builder.yml`); the run removes it and its
 * source map when it ends. Returns the removed paths.
 */
export function removeSetupMain(admission, { remove = rmSync } = {}) {
  if (!isSetupMainAdmission(admission)) return [];
  const files = [admission.mainPath, `${admission.mainPath}.map`];
  for (const file of files) remove(file, { force: true });
  return files;
}
