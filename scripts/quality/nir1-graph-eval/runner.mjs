/* global window */
// CP-4 S1c-2 runner: the (a) steady-state preview on a dev fixture (TASK
// §15.9, K6/2 `graph-eval-procedure` steps 1-9; DR-CP4-S1C2-5〜10).
//
//   TMPDIR=<short scratch> node scripts/local-ci-xvfb.mjs node \
//     scripts/quality/nir1-graph-eval/runner.mjs --run <name> \
//     --setup .artifacts/cp4/<setup-run>/setup/setup-receipt.json \
//     --ja-model <pinned> --en-model <pinned> [--variant base]
//
// One measurement Electron (the product `dist-electron/main.cjs` behind the
// NC-1 observer, the evaluation `.node`, a restricted profile, the body
// declaration CI seam) on a copy of the setup's sealed DB at a new path:
//   1. V-10: `nir1GraphEvalStatus` (registration 1, worker configured, gate
//      open, restricted) before anything is measured.
//   2. the Chronicle Index of this process through the query route;
//      §15.5: the B seal and the Chronicle Index at the new path.
//   3. the K2/4 declaration step (D1 (ii)) with the Index metadata before and
//      after, checked by `assertDeclarationCurrent`.
//   4. the AB/BA schedule (warm-up 5, measured 30): before each R+IR+Graph
//      sample the evaluation record log and the next-query cache are cleared,
//      the owner is given a bounded wait for the D′ start (an empty slot, an
//      empty cache, the rebuild interval since the last seeded sample;
//      DR-CP4-S1C2-23), and the A3 record is read on its own read-only
//      connection.
//   5. the run receipt (`nir1-cp4-run-receipt/1`, `preview: true`), checked
//      by `validateCp4Receipt`, with the egress and window samples.
// A preview is never a formal CP-4 measurement; the runner stops after it.

import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { admitDevPreview, readK62FreezeHead } from "./admission.mjs";
import { devVariantOf, loadDevFixture } from "./dev-fixture.mjs";
import { PRODUCT_MAIN, ROOT, bundleObserver } from "./launcher.mjs";
import {
  assertDeclarationCurrent,
  assessMeasurementWindow,
  validateCp4Receipt,
  writeSha256Sums,
} from "./receipt.mjs";
import { buildHarnessRenderer, startStaticServer } from "./renderer-build.mjs";
import {
  MAINTENANCE_MODES,
  assembleRunReceipt,
  measurementSeamEnv,
  quietAtStart,
  runSchedule,
  sampleRow,
} from "./run-sample.mjs";
import { HARNESS_PAGE, sha256, startSession } from "./session.mjs";
import {
  hostSnapshot,
  readAncestorPids,
  startWindowSampler,
} from "./window.mjs";
import {
  openDataVersionProbe,
  readIndexMetadata,
  readRowCounts,
  sampleCommitRate,
} from "./workspace-db.mjs";

const BODY_SEAM = Object.freeze({
  ownerTokenEnv: "GRIMODEX_BODY_DECLARATION_CI_OWNER_TOKEN",
  ownerToken: "cb2-body-declaration-owner-v1",
  nonceEnv: "GRIMODEX_BODY_DECLARATION_CI_NONCE",
  receiptRoot: ".grimodex-body-declaration-ci-receipts",
});
const QUIET_WAIT_MS = 3_000;
const DEFAULT_ADDON = "electron/native/grimodex-node/grimodex-node.node";

function git(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
}
const STATUS_WAIT_MS = 20_000;
const V10_READY_WAIT_MS = 90_000;
/** Tables whose growth during a run discloses the background writers. */
const WRITER_TABLES = Object.freeze([
  "ai_audit_events",
  "narrative_change_events",
  "narrative_change_transactions",
  "change_events",
]);

function parseArgs(argv) {
  const options = {
    variant: "base",
    maintenance: "product",
    "eval-build": path.join(ROOT, ".artifacts/cp4/eval-build"),
  };
  for (let at = 0; at < argv.length; at += 2) {
    if (!argv[at].startsWith("--") || argv[at + 1] === undefined)
      throw new Error("use --name value arguments");
    options[argv[at].slice(2)] = argv[at + 1];
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(options.run ?? ""))
    throw new Error("--run <name> is required");
  for (const name of ["setup", "ja-model", "en-model", "k62-commit"])
    if (!options[name]) throw new Error(`--${name} is required`);
  if (!MAINTENANCE_MODES.includes(options.maintenance))
    throw new Error(
      `--maintenance must be one of ${MAINTENANCE_MODES.join(", ")}`,
    );
  return options;
}

async function evaluateOk(page, label, fn, arg) {
  const result = await page.evaluate(fn, arg);
  if (!result?.ok)
    throw new Error(
      `${label} failed: ${result?.error ?? JSON.stringify(result)}`,
    );
  return result.value;
}

function invokeOk(page, cmd, args = {}) {
  return evaluateOk(
    page,
    cmd,
    ([name, input]) => window.cp4Harness.call(name, input),
    [cmd, args],
  );
}

const json = async (promise) => JSON.parse(await promise);
const stripSha = (value) =>
  typeof value === "string" ? value.replace(/^sha256:/u, "") : value;
const indexPair = (metadata) => ({
  b: {
    generation: metadata.b?.generation ?? -1,
    dirty: metadata.b?.dirty ?? true,
  },
  chronicle: {
    generation: metadata.chronicle?.generation ?? -1,
    dirty: metadata.chronicle?.dirty ?? true,
  },
});

async function readSeamReceipt(userData, nonce) {
  const file = path.join(
    userData,
    BODY_SEAM.receiptRoot,
    sha256(Buffer.from(nonce)),
    "receipt.json",
  );
  if (!existsSync(file)) return null;
  const bytes = await readFile(file);
  return { sha256: sha256(bytes), value: JSON.parse(bytes) };
}

/**
 * CQ-DEFER（D′、DR-CP4-S1C2-23）：Graph の sample の前の有界の待ち。D′ では
 * Related Scenes の query は READY を残さないので、slot が `empty` に戻り
 * （前の保留つきの session の終わり）、next-query cache が空で、前の seed つきの
 * sample の終わり（`lastSeededEndedAt`、null なら問わない）から owner の
 * rebuild の間隔が経つのを待つ。前の sample の `unused` の settle が遅れて cache を
 * 埋めることがあるので、slot が `empty` の間は cache を毎回空にする。
 */
async function waitQuiet(session, lastSeededEndedAt) {
  const started = Date.now();
  let status;
  let cacheCleared = 0;
  let quiet = false;
  while (Date.now() - started < QUIET_WAIT_MS) {
    status = await json(session.addon("nir1GraphEvalStatus"));
    if (status.owner?.slot === "empty" && status.owner?.cacheOccupied) {
      cacheCleared += (
        await json(session.addon("nir1GraphEvalClearNextQueryCache"))
      ).cleared
        ? 1
        : 0;
      status = await json(session.addon("nir1GraphEvalStatus"));
    }
    quiet = quietAtStart({
      slot: status.owner?.slot ?? null,
      cacheOccupied: status.owner?.cacheOccupied,
      sinceLastSeededMs:
        lastSeededEndedAt === null ? null : Date.now() - lastSeededEndedAt,
    });
    if (quiet) break;
    await sleep(5);
  }
  const diagnostics = await json(session.addon("nir1GraphEvalDiagnostics"));
  return {
    precondition: "dprime-empty-slot",
    waitedMs: Date.now() - started,
    slot: status?.owner?.slot ?? null,
    cacheOccupied: status?.owner?.cacheOccupied ?? null,
    cacheCleared,
    sinceLastSeededMs:
      lastSeededEndedAt === null ? null : Date.now() - lastSeededEndedAt,
    preparesReady: diagnostics?.preparesReady ?? null,
    deferredReleased: diagnostics?.deferredReleased ?? null,
    reachedQuiet: quiet,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const runDir = path.join(ROOT, ".artifacts/cp4", options.run);
  await mkdir(runDir, { recursive: false });
  const setupPath = path.resolve(options.setup);
  const setupBytes = await readFile(setupPath);
  const setup = JSON.parse(setupBytes);
  if (setup.status !== "setup-complete")
    throw new Error("[precheck] the setup receipt is not setup-complete");
  const loaded = loadDevFixture({
    root: ROOT,
    fixturePath: setup.fixture.path,
  });
  if (loaded.sha256 !== setup.fixture.sha256)
    throw new Error("[precheck] the dev fixture changed since its setup");
  const variant = devVariantOf(loaded, options.variant);
  const ids = setup.logicalToRuntime;
  const seed = ids.entities[loaded.fixture.graphSeedEntityId];
  const evalDir = path.resolve(options["eval-build"]);
  const nativePath = realpathSync(path.join(evalDir, "grimodex-node.node"));
  const workerPath = path.join(evalDir, "nir1-c-query-worker");
  // §15.2: the default addon path never holds the evaluation build.
  const defaultAddon = path.join(ROOT, DEFAULT_ADDON);
  if (
    existsSync(defaultAddon) &&
    sha256(readFileSync(defaultAddon)) === sha256(readFileSync(nativePath))
  )
    throw new Error(
      "[precheck] the default addon path holds the evaluation build",
    );
  const coldDb = path.join(ROOT, setup.coldDatabase.path);
  if (sha256(await readFile(coldDb)) !== setup.coldDatabase.sha256)
    throw new Error("[precheck] the sealed setup DB changed");
  const workspacePath = path.join(runDir, "measure", "workspace");
  await mkdir(workspacePath, { recursive: true });
  const dbPath = path.join(workspacePath, "grimodex.db");
  await copyFile(coldDb, dbPath);

  const report = { runId: options.run, problems: [], stopped: null };
  const problem = (text) => report.problems.push(text);
  const head = {
    k62: readK62FreezeHead({ root: ROOT, commit: options["k62-commit"] }),
    runStartedAtUtc: new Date().toISOString(),
  };
  const commit = git(["rev-parse", "HEAD"]);
  const candidate = await candidateBlock({
    commit,
    options,
    nativePath,
    workerPath,
  });
  const server = { close: async () => {} };
  let staticServer;
  let session;
  let windowSampler;
  const samples = [];
  let run = null;
  let declaration = null;
  let measurementWorkspace = null;
  let dataVersion = null;
  const checks = {};
  try {
    const rendererBuild = await buildHarnessRenderer({
      root: ROOT,
      outDir: path.relative(ROOT, path.join(runDir, "renderer-dist")),
      input: {
        index: path.join(ROOT, "index.html"),
        harness: path.join(ROOT, HARNESS_PAGE.slice(1)),
      },
      timingShim: true,
    });
    checks.rendererBundleSha256 = rendererBuild.rendererBundleSha256;
    checks.rendererAlias = rendererBuild.alias;
    checks.timingShim = rendererBuild.timingShim;
    candidate.harnessFiles["renderer-bundle"] =
      rendererBuild.rendererBundleSha256;
    staticServer = await startStaticServer({
      dir: path.join(runDir, "renderer-dist"),
    });
    server.close = () => staticServer.close();
    const observer = await bundleObserver({
      outDir: path.join(runDir, "observer"),
    });
    candidate.harnessFiles["observer.cjs"] = observer.sha256;
    const nonce = randomUUID();
    const maintenance = options.maintenance;
    session = await startSession({
      runDir: path.join(runDir, "measure"),
      label: "session",
      server: staticServer,
      observer,
      nativePath,
      d2aMode: "restricted",
      models: { ja: options["ja-model"], en: options["en-model"] },
      tmpRoot: options.tmp ? path.join(options.tmp, options.run) : null,
      admission: admitDevPreview({
        purpose: "runner-preview",
        fixture: loaded,
      }),
      extraEnv: measurementSeamEnv({
        bodyNonce: nonce,
        maintenance,
        maintenanceNonce: randomUUID(),
      }),
    });
    if (session.evidence.problems.length > 0)
      throw new Error(session.evidence.problems.join("; "));
    const page = session.page;
    const launcherChain = readAncestorPids();
    windowSampler = startWindowSampler({
      root: ROOT,
      ownPids: () => [...launcherChain, ...session.pids()],
    });

    // V-10 (registration, worker path, gate) before anything is measured.
    const statusStarted = Date.now();
    let status = await json(session.addon("nir1GraphEvalStatus"));
    while (
      Date.now() - statusStarted < STATUS_WAIT_MS &&
      !(
        status.registrations === 1 &&
        status.worker?.state === "configured" &&
        status.gateOpened === true
      )
    ) {
      await sleep(100);
      status = await json(session.addon("nir1GraphEvalStatus"));
    }
    checks.v10Status = status;
    if (
      status.registrations !== 1 ||
      status.worker?.state !== "configured" ||
      status.gateOpened !== true ||
      status.owner?.profile?.restricted !== true ||
      status.owner?.profile?.inFlightStopped !== true
    )
      throw new Error(
        `[precheck] V-10: the evaluation owner is not ready: ${JSON.stringify(status)}`,
      );

    await evaluateOk(
      page,
      "open workspace",
      (input) => window.cp4Harness.openWorkspace(input),
      {
        workspacePath,
        projectId: ids.projectId,
        activeSceneId: ids.querySceneId,
      },
    );
    const metadataAtOpen = readIndexMetadata(dbPath, ids.projectId);
    // The Raw vectors are rebuilt in the measurement workspace (P harness
    // `buildRaw`; the copied DB keeps none), before the Chronicle Index.
    checks.rawIndex = await evaluateOk(
      page,
      "build Raw",
      (input) => window.cp4Harness.buildRaw(input),
      {
        projectId: ids.projectId,
        label: `cp4-${options.run}`,
        sceneIds: Object.keys(ids.scenes),
        queryBody: loaded.fixture.query.body,
      },
    );
    if (!checks.rawIndex.ok)
      throw new Error(
        `[artifact] the Raw index did not publish every Scene: ${JSON.stringify(checks.rawIndex)}`,
      );
    const index = await page.evaluate(
      (input) => window.cp4Harness.buildIndex(input),
      {
        sceneId: ids.querySceneId,
        limitMs: 60_000,
      },
    );
    const metadataAfterIndex = readIndexMetadata(dbPath, ids.projectId);
    // §15.5: at the new path, the sealed B generation and the Chronicle
    // Index are current (same generation, not dirty) and usable.
    const sealed = setup.coldDatabase.metadata;
    checks.pathChange = {
      setupWorkspace: path.relative(
        ROOT,
        path.join(path.dirname(setupPath), "workspace"),
      ),
      measurementWorkspace: path.relative(ROOT, workspacePath),
      sealedAtSetup: indexPair(sealed),
      atOpen: indexPair(metadataAtOpen),
      afterIndexBuild: indexPair(metadataAfterIndex),
      bSourceDigestSame:
        metadataAfterIndex.b?.sourceDigest === sealed.b?.sourceDigest,
      chronicleIndexBuild: {
        ok: index.ok,
        durationMs: index.durationMs,
        probes: index.probes.length,
      },
    };
    if (!index.ok)
      throw new Error(
        `[precheck] §15.5: the Chronicle Index is not usable at the new path: ${JSON.stringify(index.probes.at(-1))}`,
      );
    if (
      metadataAfterIndex.b?.generation !== sealed.b?.generation ||
      metadataAfterIndex.b?.dirty !== false ||
      !checks.pathChange.bSourceDigestSame
    )
      throw new Error(
        `[precheck] §15.5: the sealed B generation is not current at the new path: ${JSON.stringify(checks.pathChange)}`,
      );

    // V-10 (READY): a seeded query hands the query to the owner, which
    // prepares the worker. Bounded: a few seeded probes until the owner has
    // reached READY once (the probes are recorded, never measured).
    // Background commits by the measurement Main (maintenance, Freshness)
    // while nothing is queried (D2 / §15.5 disclosure).
    checks.commitRateIdle = await sampleCommitRate(dbPath, {
      durationMs: 3_000,
    });
    const probes = [];
    const v10Started = Date.now();
    let diagnostics = await json(session.addon("nir1GraphEvalDiagnostics"));
    while (
      Date.now() - v10Started < V10_READY_WAIT_MS &&
      (diagnostics.preparesReady ?? 0) < 1
    ) {
      await session.addon("nir1GraphEvalClearSamples");
      const probe = await page.evaluate(
        (input) => window.cp4Harness.measure(input),
        {
          sceneId: ids.querySceneId,
          seed,
        },
      );
      // D′：保留つきの session が終わる（slot が empty に戻る）まで待つ。
      const ready = await waitQuiet(session, null);
      diagnostics = await json(session.addon("nir1GraphEvalDiagnostics"));
      probes.push({
        atMs: Date.now() - v10Started,
        graphOutcome: probe.graphOutcome,
        native: (await json(session.addon("nir1GraphEvalSamples"))).records,
        ready,
        preparesStarted: diagnostics.preparesStarted,
        preparesReady: diagnostics.preparesReady,
        prepareFailures: diagnostics.prepareFailures,
      });
      if ((diagnostics.preparesReady ?? 0) < 1) await sleep(1_000);
    }
    const quietAfterProbe = await waitQuiet(session, null);
    checks.v10Ready = {
      probes,
      after: quietAfterProbe,
      diagnostics,
      status: await json(session.addon("nir1GraphEvalStatus")),
    };
    if ((diagnostics.preparesReady ?? 0) < 1)
      throw new Error(
        `[precheck] V-10: the worker never reached READY: ${JSON.stringify(checks.v10Ready).slice(0, 4000)}`,
      );

    // K2/4 declaration step (D1 (ii)) before the first measured Graph query.
    const declared = loaded.fixture.declarations[0];
    const capture = await invokeOk(
      page,
      "narrative_extraction_capture_workspace_binding",
      {
        expectedWorkspacePath: workspacePath,
      },
    );
    const indexBefore = indexPair(readIndexMetadata(dbPath, ids.projectId));
    const scene = {
      workspacePath,
      projectId: ids.projectId,
      sceneId: declared.sceneId,
    };
    const declare = await page.evaluate(
      (input) => window.cp4Harness.declaration.declare(input),
      scene,
    );
    const indexAfter = indexPair(readIndexMetadata(dbPath, ids.projectId));
    const stateAfter = await page.evaluate(
      (input) => window.cp4Harness.declaration.state(input),
      scene,
    );
    const seam = await readSeamReceipt(session.userData, nonce);
    const lastDigest = stripSha(
      seam?.value?.approvedBindingDigests?.at(-1) ?? null,
    );
    const locatorDigest = sha256(Buffer.from(realpathSync(workspacePath)));
    declaration = {
      sceneId: declared.sceneId,
      result: declare,
      workspaceId: capture.authorityId,
      canonicalLocatorDigest: locatorDigest,
      token: stateAfter.ok ? stateAfter.snapshot.declarationToken : null,
      bindingDigest: lastDigest,
      seamReceipt: seam
        ? {
            version: String(seam.value.version),
            envNames: Object.values(seam.value.envNames ?? {}),
            nonceDigest: stripSha(seam.value.nonceDigest),
            approvedGrantCount: seam.value.approvedGrantCount,
            bindingDigest: lastDigest,
            receiptSha256: seam.sha256,
          }
        : null,
      indexBefore,
      indexAfter,
      stateAfter,
      verified: false,
    };
    // The measurement workspace just before the first measured Graph query:
    // the same authority and locator, and the declaration still effective
    // with the same token (the state read carries no digest; the seam digest
    // stands for it only while the token and effectiveness are unchanged).
    const stateNow = await page.evaluate(
      (input) => window.cp4Harness.declaration.state(input),
      scene,
    );
    const captureNow = await invokeOk(
      page,
      "narrative_extraction_capture_workspace_binding",
      {
        expectedWorkspacePath: workspacePath,
      },
    );
    const effective =
      stateNow.ok &&
      stateNow.snapshot.state.kind === "declared" &&
      stateNow.snapshot.state.effective === true &&
      stateNow.snapshot.declarationToken === declaration.token;
    measurementWorkspace = {
      path: path.relative(ROOT, workspacePath),
      workspaceId: captureNow.authorityId,
      canonicalLocatorDigest: sha256(Buffer.from(realpathSync(workspacePath))),
      bindingDigest: effective ? lastDigest : null,
      state: stateNow,
    };
    try {
      assertDeclarationCurrent({ declaration, measurementWorkspace });
      declaration.verified = true;
    } catch (error) {
      declaration.verified = false;
      declaration.refusal = error.message;
      throw error;
    }

    // (a) the predeclared AB/BA schedule.
    checks.rowCountsBefore = readRowCounts(dbPath, WRITER_TABLES);
    dataVersion = openDataVersionProbe(dbPath);
    run = { startedAtMs: Date.now() };
    let lastSeededEndedAt = Date.now();
    for (const slot of runSchedule()) {
      if (slot.arm === "graph") {
        await session.addon("nir1GraphEvalClearSamples");
        await session.addon("nir1GraphEvalClearNextQueryCache");
        const readyWait = await waitQuiet(session, lastSeededEndedAt);
        const dvAtReady = dataVersion.read();
        const a3 = await json(
          session.addon(
            "nir1GraphEvalReadA3",
            dbPath,
            ids.projectId,
            ids.querySceneId,
            Object.values(ids.typedRevisions).map((row) => row.revisionId),
          ),
        );
        const dvBeforeQuery = dataVersion.read();
        const measure = await page.evaluate(
          (input) => window.cp4Harness.measure(input),
          {
            sceneId: ids.querySceneId,
            seed,
          },
        );
        const dvAfterQuery = dataVersion.read();
        lastSeededEndedAt = Date.now();
        const records = (await json(session.addon("nir1GraphEvalSamples")))
          .records;
        if (records.length !== 1)
          throw new Error(
            `[artifact] expected one Native begin record per sample, saw ${records.length}`,
          );
        samples.push(
          sampleRow({
            variantKey: variant.key,
            ...slot,
            d2aMode: "restricted",
            measure,
            nativeRecord: records[0],
            a3,
            readyWait: {
              ...readyWait,
              commitBetweenReadyAndQuery: dvBeforeQuery !== dvAtReady,
              commitDuringQuery: dvAfterQuery !== dvBeforeQuery,
            },
          }),
        );
      } else {
        await session.addon("nir1GraphEvalClearSamples");
        const measure = await page.evaluate(
          (input) => window.cp4Harness.measure(input),
          {
            sceneId: ids.querySceneId,
            seed: null,
          },
        );
        samples.push(
          sampleRow({
            variantKey: variant.key,
            ...slot,
            d2aMode: "restricted",
            measure,
          }),
        );
      }
    }
    run.finishedAtMs = Date.now();
    checks.rowCountsAfter = readRowCounts(dbPath, WRITER_TABLES);
    checks.diagnosticsAfter = await json(
      session.addon("nir1GraphEvalDiagnostics"),
    );
    checks.metadataAfterRun = indexPair(
      readIndexMetadata(dbPath, ids.projectId),
    );
  } catch (error) {
    problem(error?.stack ?? String(error));
    process.exitCode = 1;
  } finally {
    dataVersion?.close();
    const windowSamples = windowSampler?.stop() ?? [];
    report.session = session ? await session.stop() : null;
    await server.close();
    report.windowSamples = windowSamples;
  }
  const evidence = report.session ?? {};
  if (evidence.problems?.length) report.problems.push(...evidence.problems);
  const ownPids = [
    ...readAncestorPids(),
    ...(evidence.recordedPids ?? []).map((row) => row.pid),
  ];
  const runWindow = run ?? {
    startedAtMs: Date.now(),
    finishedAtMs: Date.now(),
  };
  const environment = {
    hostSnapshot: hostSnapshot(),
    windowSamples: report.windowSamples,
    windowAssessment: assessMeasurementWindow({
      samples: report.windowSamples,
      run: runWindow,
      ownPids,
    }),
    ownPids,
    xvfbDisplay: process.env.DISPLAY,
    // B-2: the names the launch env actually dropped (handle.launch).
    removedEnv: evidence.launch?.removedEnv ?? null,
    launchEnvChecked: evidence.launch?.checkedAbsent ?? null,
    netns: evidence.launch?.netns ?? null,
    netLog: evidence.netLog ?? null,
    socketSamples: evidence.socketSamples ?? [],
    x11: {
      before: evidence.x11Before ?? null,
      after: evidence.x11After ?? null,
    },
    profileEgress: {
      dictionaries: evidence.dictionaries ?? null,
      networkPersistentServers: evidence.networkPersistentServers ?? null,
    },
    observer: evidence.observerCheck ?? null,
    stop: evidence.stop ?? null,
    mainWorker: evidence.mainWorker ?? null,
  };
  // B-2: a problem seen at the stop (processes left, X11, profile egress,
  // net log, Main's worker) fails the run as much as a thrown error.
  if (report.problems.length > 0) process.exitCode = 1;
  const settings = {
    maintenance: options.maintenance,
    d2aModes: { hybrid: "restricted", graph: "restricted" },
    reauthorization: {
      mode: "restricted",
      placedStateFile: true,
      note: "restricted profile state placed before launch (placeD2aProfileState); no activation UI",
    },
    setupReceipt: {
      path: path.relative(ROOT, setupPath),
      sha256: sha256(setupBytes),
      logicalToRuntime: ids,
    },
    seed: { logical: loaded.fixture.graphSeedEntityId, runtime: seed },
  };
  if (samples.length > 0 && run) {
    const receipt = assembleRunReceipt({
      runId: options.run,
      fixture: { path: loaded.path, sha256: loaded.sha256, kind: "dev" },
      variant,
      head,
      candidate,
      environment,
      run,
      settings,
      declaration,
      measurementWorkspace,
      samples,
      checks,
    });
    const errors = validateCp4Receipt(receipt);
    await writeFile(
      path.join(runDir, "receipt.json"),
      `${JSON.stringify(receipt, null, 2)}\n`,
    );
    await writeFile(
      path.join(runDir, "validation.json"),
      `${JSON.stringify({ valid: errors.length === 0, errors }, null, 2)}\n`,
    );
    await writeSha256Sums(runDir, ["receipt.json", "validation.json"]);
    process.stdout.write(
      `${JSON.stringify({ run: options.run, valid: errors.length === 0, errors, preview: receipt.previewSummary, problems: report.problems.map((row) => row.split("\n")[0]) }, null, 1)}\n`,
    );
  } else {
    await writeFile(
      path.join(runDir, "run-report.json"),
      `${JSON.stringify({ ...report, checks, declaration, measurementWorkspace, environment }, null, 2)}\n`,
    );
    process.stdout.write(
      `${JSON.stringify({ run: options.run, stopped: true, problems: report.problems.map((row) => row.split("\n").slice(0, 3).join(" | ")) })}\n`,
    );
  }
}

/** Candidate block (§7.2): commit, tree, clean, receipts, models, harness. */
async function candidateBlock({ commit, options, nativePath, workerPath }) {
  const evalDir = path.dirname(nativePath);
  const read = (file) => (existsSync(file) ? readFileSync(file) : null);
  const evalReceipt = read(path.join(evalDir, "eval-build.json"));
  const productReceipt = options["product-receipt"]
    ? read(path.resolve(options["product-receipt"]))
    : null;
  const manifest = JSON.parse(
    readFileSync(path.join(ROOT, "evals/nir1-retrieval/manifest.json"), "utf8"),
  );
  const harnessFiles = {};
  for (const file of [
    "scripts/quality/nir1-graph-eval/runner.mjs",
    "scripts/quality/nir1-graph-eval/run-sample.mjs",
    "scripts/quality/nir1-graph-eval/session.mjs",
    "scripts/quality/nir1-graph-eval/window.mjs",
    "scripts/quality/nir1-graph-eval/workspace-db.mjs",
    "scripts/quality/nir1-graph-eval/dev-fixture.mjs",
    "scripts/quality/nir1-graph-eval/renderer/cp4-harness.ts",
    "scripts/quality/nir1-graph-eval/availability.mjs",
    "scripts/quality/nir1-graph-eval/receipt.mjs",
    "scripts/quality/nir1-graph-eval/native-sample.mjs",
    "scripts/quality/nir1-graph-eval/launcher.mjs",
    "scripts/quality/nir1-graph-eval/egress.mjs",
    PRODUCT_MAIN,
  ])
    harnessFiles[file] = sha256(readFileSync(path.join(ROOT, file)));
  return {
    commit,
    tree: git(["rev-parse", "HEAD^{tree}"]),
    clean: git(["status", "--porcelain", "--untracked-files=all"]) === "",
    productReceiptSha256: productReceipt ? sha256(productReceipt) : null,
    evalReceiptSha256: evalReceipt ? sha256(evalReceipt) : null,
    evalReceiptHead: evalReceipt
      ? (JSON.parse(evalReceipt).candidate?.resolvedHeadSha ?? null)
      : null,
    nativeSha256: sha256(readFileSync(nativePath)),
    workerSha256: existsSync(workerPath)
      ? sha256(readFileSync(workerPath))
      : null,
    features: ["nir1-graph-eval"],
    models: Object.fromEntries(
      ["ja", "en"].map((language) => [
        language,
        {
          modelSha256: manifest.models[language].artifactSha256,
          tokenizerSha256: manifest.models[language].tokenizerSha256,
        },
      ]),
    ),
    electronVersion: JSON.parse(
      readFileSync(
        path.join(ROOT, "node_modules/electron/package.json"),
        "utf8",
      ),
    ).version,
    harnessFiles,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename)
  await main();
