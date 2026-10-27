/* global window */
// CP-4 S5-B: K24-G01-N2〜N4 の段の dev の予告（DR-CP4-O-1 (5)。integrator だけが
// 見る。CP-4 の記録にしない）。dev fixture（`dev-lantern.v1` など宣言を持つもの）
// の dev setup の写しで、製品の writer による宣言の前の版の用意、K2/4 の宣言、
// 宣言の後の mutation、B と Chronicle の待ち、SP-P1 の照合し直し、seed つきの
// query を短く確かめる。凍結した G-case の材料では使わない（dev の admission）。
//
//   TMPDIR=<short scratch> node scripts/local-ci-xvfb.mjs node \
//     scripts/quality/nir1-graph-eval/g01-negative-preview.mjs --run <name> \
//     --setup .artifacts/cp4/<dev-setup>/setup/setup-receipt.json \
//     --negative K24-G01-N3 [--samples 3] --ja-model <pinned> --en-model <pinned>

import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { admitDevPreview } from "./admission.mjs";
import { loadDevFixture } from "./dev-fixture.mjs";
import { buildIndex, launch, openWorkspace } from "./dprime-check.mjs";
import { assessG01Negative } from "./frozen-diagnostics.mjs";
import {
  g01NegativeLaunchEnv,
  g01NegativeSampleOf,
  prepareG01NegativeBeforeDeclaration,
  runG01NegativeStep,
} from "./g01-negatives.mjs";
import { ROOT, bundleObserver } from "./launcher.mjs";
import { buildHarnessRenderer, startStaticServer } from "./renderer-build.mjs";
import { HARNESS_PAGE, sha256, startSession } from "./session.mjs";
import { captureBodyNonce, runTraceDeclaration } from "./trace-runner.mjs";
import { readIndexMetadata, readQuerySceneSeedPins } from "./workspace-db.mjs";

export const G01_NEGATIVE_PREVIEW_PURPOSE = "g01-negative-preview";

function parseArgs(argv) {
  const options = {
    "eval-build": path.join(ROOT, ".artifacts/cp4/eval-build"),
    samples: "3",
  };
  for (let at = 0; at < argv.length; at += 2) {
    if (!argv[at].startsWith("--") || argv[at + 1] === undefined)
      throw new Error("use --name value arguments");
    options[argv[at].slice(2)] = argv[at + 1];
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(options.run ?? ""))
    throw new Error("--run <name> is required");
  for (const name of ["setup", "negative", "ja-model", "en-model"])
    if (!options[name]) throw new Error(`--${name} is required`);
  return options;
}

async function readSeamReceipt(userData, nonce) {
  if (!nonce) return null;
  const file = path.join(
    userData,
    ".grimodex-body-declaration-ci-receipts",
    sha256(Buffer.from(nonce)),
    "receipt.json",
  );
  if (!existsSync(file)) return null;
  const bytes = await readFile(file);
  return { sha256: sha256(bytes), value: JSON.parse(bytes) };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const runDir = path.join(ROOT, ".artifacts/cp4", options.run);
  await mkdir(runDir, { recursive: false });
  const report = { run: options.run, problems: [] };
  let server = null;
  let session = null;
  try {
    const setup = JSON.parse(await readFile(path.resolve(options.setup)));
    const loaded = loadDevFixture({
      root: ROOT,
      fixturePath: setup.fixture.path,
    });
    if (loaded.sha256 !== setup.fixture.sha256)
      throw new Error("[precheck] the dev fixture changed since its setup");
    const fixture = loaded.fixture;
    const declared = fixture.declarations?.[0]?.sceneId;
    if (!declared)
      throw new Error("[precheck] the dev fixture declares no Scene");
    const admission = admitDevPreview({
      purpose: G01_NEGATIVE_PREVIEW_PURPOSE,
      fixture: loaded,
    });
    const map = setup.logicalToRuntime;
    const ids = {
      projectId: map.projectId,
      querySceneId: map.querySceneId,
      scenes: map.scenes,
      entities: map.entities,
    };
    const target = {
      sceneId: declared,
      seedEntityId: fixture.graphSeedEntityId,
      querySceneId: fixture.query.sceneId,
    };
    const seed = map.entities[target.seedEntityId];
    const workspacePath = path.join(runDir, "workspace");
    await mkdir(workspacePath, { recursive: true });
    const dbPath = path.join(workspacePath, "grimodex.db");
    await copyFile(path.resolve(ROOT, setup.coldDatabase.path), dbPath);
    await buildHarnessRenderer({
      root: ROOT,
      outDir: path.relative(ROOT, path.join(runDir, "renderer-dist")),
      input: {
        index: path.join(ROOT, "index.html"),
        harness: path.join(ROOT, HARNESS_PAGE.slice(1)),
      },
      timingShim: true,
      fetchTiming: true,
    });
    server = await startStaticServer({
      dir: path.join(runDir, "renderer-dist"),
    });
    const observer = await bundleObserver({
      outDir: path.join(runDir, "observer"),
    });
    const bodySeam = { nonce: null };
    const maintenanceNonce = randomUUID();
    session = await launch({
      label: "measure",
      runDir,
      server,
      observer,
      options,
      admission,
      // The addendum's measurementProcess: the B-ROUTE journey seam.
      start: (args) =>
        captureBodyNonce(
          startSession,
          bodySeam,
        )({
          ...args,
          extraEnv: g01NegativeLaunchEnv({
            nonce: maintenanceNonce,
            base: args.extraEnv ?? {},
          }),
        }),
    });
    const page = session.page;
    await openWorkspace(page, workspacePath, ids);
    // The dev fixture's query Scene has no pin (DR-CP4-S1C2-26): the seed.
    report.seedPin = await page.evaluate(
      (value) => window.cp4Harness.api.upsertScenePin(value),
      { sceneId: ids.querySceneId, entryId: seed },
    );
    const raw = await page.evaluate(
      (input) => window.cp4Harness.buildRaw(input),
      {
        projectId: ids.projectId,
        label: `cp4-${options.run}`,
        sceneIds: Object.values(ids.scenes),
        queryBody: fixture.query.body,
      },
    );
    if (!raw.ok || !raw.value.ok)
      throw new Error("[artifact] the Raw index build failed");
    report.index = await buildIndex(page, ids);
    const id = options.negative;
    const before = await prepareG01NegativeBeforeDeclaration({
      id,
      page,
      ids,
      target,
    });
    report.beforeDeclaration = before;
    const declaration = await runTraceDeclaration({
      page,
      workspacePath,
      projectId: ids.projectId,
      sceneId: map.scenes[declared],
      readIndex: () => readIndexMetadata(dbPath, ids.projectId),
      readSeam: () => readSeamReceipt(session.userData, bodySeam.nonce),
      locatorDigest: sha256(Buffer.from(realpathSync(workspacePath))),
    });
    report.declaration = {
      token: declaration.token,
      bindingDigest: declaration.bindingDigest,
      stateAfter: declaration.stateAfter?.snapshot?.state ?? null,
    };
    const step = before.blocked
      ? { blocked: before.blocked }
      : await runG01NegativeStep({
          id,
          page,
          ids,
          target,
          before: before.prepared,
          readIndex: () => readIndexMetadata(dbPath, ids.projectId),
          readPins: () =>
            readQuerySceneSeedPins(dbPath, ids.projectId, ids.querySceneId),
        });
    report.step = step;
    report.declarationAfterMutation = await page.evaluate(
      (input) => window.cp4Harness.declaration.state(input),
      {
        workspacePath,
        projectId: ids.projectId,
        sceneId: map.scenes[declared],
      },
    );
    const samples = [];
    if (!step.blocked)
      for (let repeat = 0; repeat < Number(options.samples); repeat++) {
        const measure = await page.evaluate(
          (input) => window.cp4Harness.measure(input),
          { sceneId: ids.querySceneId, seed },
        );
        samples.push(
          g01NegativeSampleOf({
            row: {
              phase: "measured",
              repeat,
              arm: "graph",
              seed,
              finalSceneIds: measure.finalSceneIds,
            },
            ids,
          }),
        );
        report.graphOutcomes ??= [];
        report.graphOutcomes.push({
          status: measure.status,
          graphOutcome: measure.graphOutcome,
          graph: measure.graph,
        });
      }
    report.samples = samples;
    report.assessment = assessG01Negative({
      id,
      blocked: step.blocked,
      spP1Recheck: step.spP1Recheck,
      samples,
      target,
    });
  } catch (error) {
    report.problems.push(error?.stack ?? String(error));
    process.exitCode = 1;
  } finally {
    if (session) {
      const stopped = await session.stop().catch((error) => ({
        problems: [`stop: ${error?.stack ?? error}`],
      }));
      report.problems.push(...(stopped.problems ?? []));
      await writeFile(path.join(runDir, "main-stderr.log"), session.stderr());
    }
    await server?.close();
  }
  await writeFile(
    path.join(runDir, "preview.json"),
    `${JSON.stringify({ preview: true, ...report }, null, 1)}\n`,
  );
  process.stdout.write(
    `${JSON.stringify({ run: options.run, step: report.step ? { blocked: report.step.blocked, spP1: report.step.spP1Recheck?.status, wait: report.step.wait?.waitedMs } : null, assessment: report.assessment ?? null, problems: report.problems.map((row) => row.split("\n")[0]) })}\n`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename)
  await main();
