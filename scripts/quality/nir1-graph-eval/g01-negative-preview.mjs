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
  G01_CONTROL_GAP_MS,
  g01NegativeLaunchEnv,
  g01NegativeSampleOf,
  prepareG01NegativeBeforeDeclaration,
  reopenUntilSealed,
  runG01NegativeControl,
  runG01NegativeStep,
} from "./g01-negatives.mjs";
import { a3AtStartOf } from "./run-sample.mjs";
import { setTimeout as delay } from "node:timers/promises";
import { ROOT, bundleObserver } from "./launcher.mjs";
import { buildHarnessRenderer, startStaticServer } from "./renderer-build.mjs";
import { HARNESS_PAGE, sha256, startSession } from "./session.mjs";
import { captureBodyNonce, runTraceDeclaration } from "./trace-runner.mjs";
import {
  readIndexMetadata,
  readQuerySceneSeedPins,
  readWorkspaceRows,
} from "./workspace-db.mjs";

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
  const report = { run: options.run, problems: [], sessions: [] };
  let server = null;
  let current = null;
  const stopCurrent = async () => {
    if (!current) return;
    const value = current;
    current = null;
    const stopped = await value.session.stop().catch((error) => ({
      problems: [`stop: ${error?.stack ?? error}`],
    }));
    await writeFile(
      path.join(runDir, `${value.label}-main-stderr.log`),
      value.session.stderr(),
    );
    report.sessions.push({
      label: value.label,
      problems: stopped.problems ?? [],
    });
    report.problems.push(...(stopped.problems ?? []));
  };
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
    const pin = (fixture.pins ?? []).find((row) => row.sceneId === declared);
    if (!declared || !pin)
      throw new Error("[precheck] the dev fixture declares no pinned Scene");
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
      entityId: pin.entityId ?? pin.entryId,
      seedEntityId: fixture.graphSeedEntityId,
      querySceneId: fixture.query.sceneId,
    };
    const seed = map.entities[target.seedEntityId];
    const materials = Object.values(map.typedRevisions ?? {}).map(
      (row) => row.revisionId,
    );
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
    const readIndex = () => readIndexMetadata(dbPath, ids.projectId);
    const readGraphInputs = () => readWorkspaceRows(dbPath, ids.projectId);
    // One measurement Main on the B-ROUTE journey seam (the addendum's
    // measurementProcess); its workspace open runs the gated B build.
    const open = async (label) => {
      const bodySeam = { nonce: null };
      const session = await launch({
        label,
        runDir,
        server,
        observer,
        options,
        admission,
        start: (args) =>
          captureBodyNonce(
            startSession,
            bodySeam,
          )({
            ...args,
            extraEnv: g01NegativeLaunchEnv({
              nonce: randomUUID(),
              base: args.extraEnv ?? {},
            }),
          }),
      });
      current = { label, session, bodySeam };
      await openWorkspace(session.page, workspacePath, ids);
      return current;
    };
    const reopenAfterWrites = async (before) => {
      const reopened = await reopenUntilSealed({
        closeCurrent: stopCurrent,
        openSession: async ({ dirLabel }) => {
          const value = await open(dirLabel);
          return { ...value, close: stopCurrent };
        },
        readIndex,
        before,
      });
      return reopened;
    };
    await open("measure");
    // The dev fixture's query Scene has no pin (DR-CP4-S1C2-26): the seed.
    report.seedPin = await current.session.page.evaluate(
      (value) => window.cp4Harness.api.upsertScenePin(value),
      { sceneId: ids.querySceneId, entryId: seed },
    );
    const raw = await current.session.page.evaluate(
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
    report.index = await buildIndex(current.session.page, ids);
    const id = options.negative;
    const indexBeforeWrites = readIndex();
    const before = await prepareG01NegativeBeforeDeclaration({
      id,
      page: current.session.page,
      ids,
      target,
    });
    report.beforeDeclaration = before;
    let blocked = before.blocked;
    // N4's saves before the declaration: B is sealed again first.
    if (!blocked && before.prepared?.kind === "draft-then-original") {
      const reopened = await reopenAfterWrites(indexBeforeWrites);
      report.beforeDeclarationSealAttempts = reopened.sealAttempts;
      if (!reopened.ok) blocked = { reason: "b-seal-not-published" };
      else
        report.indexAfterReopen = await buildIndex(current.session.page, ids);
    }
    let step = { blocked };
    let control = null;
    if (!blocked) {
      const declaration = await runTraceDeclaration({
        page: current.session.page,
        workspacePath,
        projectId: ids.projectId,
        sceneId: map.scenes[declared],
        readIndex,
        readSeam: () =>
          readSeamReceipt(current.session.userData, current.bodySeam.nonce),
        locatorDigest: sha256(Buffer.from(realpathSync(workspacePath))),
      });
      report.declaration = {
        token: declaration.token,
        bindingDigest: declaration.bindingDigest,
        stateAfter: declaration.stateAfter?.snapshot?.state ?? null,
      };
      control = await runG01NegativeControl({
        page: current.session.page,
        ids,
        target,
        readGraphInputs,
      });
      report.control = control;
      step = await runG01NegativeStep({
        id,
        page: current.session.page,
        ids,
        target,
        before: before.prepared,
        readIndex,
        readPins: () =>
          readQuerySceneSeedPins(dbPath, ids.projectId, ids.querySceneId),
        readGraphInputs,
        closeCurrent: stopCurrent,
        openSession: async ({ dirLabel }) => {
          const value = await open(dirLabel);
          return { ...value, close: stopCurrent };
        },
      });
    }
    report.step = {
      ...step,
      session: step.session ? step.session.label : null,
    };
    const samples = [];
    if (!step.blocked) {
      const page = current.session.page;
      report.indexAfterMutation = await buildIndex(page, ids);
      report.declarationAfterMutation = await page.evaluate(
        (input) => window.cp4Harness.declaration.state(input),
        {
          workspacePath,
          projectId: ids.projectId,
          sceneId: map.scenes[declared],
        },
      );
      for (let repeat = 0; repeat < Number(options.samples); repeat++) {
        const a3 = JSON.parse(
          await current.session.addon(
            "nir1GraphEvalReadA3",
            dbPath,
            ids.projectId,
            ids.querySceneId,
            materials,
          ),
        );
        const measure = await page.evaluate(
          (input) => window.cp4Harness.measure(input),
          { sceneId: ids.querySceneId, seed },
        );
        const outcome = measure.graphOutcome;
        samples.push(
          g01NegativeSampleOf({
            row: {
              phase: "measured",
              repeat,
              arm: "graph",
              seed,
              graph: {
                outcome:
                  typeof outcome === "string" &&
                  outcome.startsWith("graph-unavailable")
                    ? "graph-unavailable"
                    : outcome,
              },
              a3AtStart: a3AtStartOf(a3),
              finalSceneIds: measure.finalSceneIds,
            },
            ids,
            target,
            control,
            inputsDigest: step.graphInputs,
          }),
        );
        report.graphOutcomes ??= [];
        report.graphOutcomes.push({
          status: measure.status,
          graphOutcome: outcome,
          graph: measure.graph,
          a3: a3AtStartOf(a3),
        });
        await delay(G01_CONTROL_GAP_MS);
      }
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
    await stopCurrent();
    await server?.close();
  }
  await writeFile(
    path.join(runDir, "preview.json"),
    `${JSON.stringify({ preview: true, ...report }, null, 1)}\n`,
  );
  process.stdout.write(
    `${JSON.stringify({ run: options.run, control: report.control?.status ?? null, sealAttempts: report.step?.sealAttempts?.map((row) => [row.attempt, row.outcome, row.waitedMs]) ?? null, step: report.step ? { blocked: report.step.blocked, spP1: report.step.spP1Recheck?.status } : null, frames: report.samples?.map((row) => row.frameReached) ?? null, assessment: report.assessment ?? null, problems: report.problems.map((row) => row.split("\n")[0]) })}\n`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename)
  await main();
