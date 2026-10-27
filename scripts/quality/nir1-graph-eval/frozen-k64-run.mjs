/* global window */
// CP-4 S5-A: 凍結した G-case の正式の Graph arm の run（DR-CP4-N-1〜N-6）。
//
//   TMPDIR=<short scratch> node scripts/local-ci-xvfb.mjs node \
//     scripts/quality/nir1-graph-eval/frozen-k64-run.mjs --run <name> \
//     --candidate <sha> --prep-commit <S4 commit> --k62-commit <K6/2 freeze> \
//     --k64-commit <K6/4 freeze> --product-receipt <standard build receipt> \
//     --setups <variantKey → complete setup receipt の JSON> \
//     --ja-model <pinned> --en-model <pinned> [--variant <key>] \
//     [--d2a-mode unrestricted]  (d10 の parity の run: R+IR だけ)
//
// dev の形の確認（予告。集計しない）は `--dev-fixture <dev graph case>` で、
// `frozen-setup-driver.mjs --dev-fixture` の完全な setup の受領書を測る。
//
// 流れ: admission（`admitFormalK64Run`。receipt を書く前に止まる）→ 13 個の
// 完全な setup と run の仕様（`formalRunPlan`）→ seed の pin の gate（13 の cold
// DB。Graph arm を含むどの process よりも前）→ variant ごとの測定（定常状態は
// 1 process、one-shot は 70 process）→ variant ごとの receipt と検証。

import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";
import { setTimeout as delay } from "node:timers/promises";
import {
  admitDevPreview,
  collectRatification5Evidence,
  collectRatification5EvidenceWithKeepTest,
  readK62FreezeHead,
  readK64FreezeHead,
} from "./admission.mjs";
import { checkRunnerBuildReceipts } from "./build-receipt-check.mjs";
import { K64_W_F_MS, devVariant, variantByKey } from "./constants.mjs";
import {
  admitFormalK64Run,
  assertCandidateFixed,
  assertParityBefore,
  finishAttempt,
  listAttempts,
  startAttempt,
} from "./frozen-k64-admission.mjs";
import {
  blockedJudgement,
  d2ProbeCheck,
  declarationInvariantCheck,
  devRunSpec,
  formalRunPlan,
  measurementCopySeedCheck,
  oneShotProcessSchedule,
  parityVariantKeys,
  scheduleOrder,
  validateParitySchedule,
} from "./frozen-k64-plan.mjs";
import {
  loadDevGraphCasePlans,
  loadFrozenSetupPlans,
} from "./frozen-setup-plan.mjs";
import { k64GraphSampleRow, r2Record } from "./k64-record.mjs";
import {
  K64_DEV_PREVIEW_PURPOSE,
  assembleK64Receipt,
  candidateBlock,
  waitR1,
  waitRelease,
} from "./k64-runner.mjs";
import { DEFAULT_ADDON, ROOT, bundleObserver } from "./launcher.mjs";
import {
  hashObservationPaths,
  materialRevisionResolver,
} from "./material-revision.mjs";
import {
  DEV_DRAFT_PROCEDURE_VERSION,
  loadProcedureFile,
} from "./procedure-file.mjs";
import {
  assertDeclarationCurrent,
  assessMeasurementWindow,
  validateCp4Receipt,
  writeSha256Sums,
} from "./receipt.mjs";
import { buildHarnessRenderer, startStaticServer } from "./renderer-build.mjs";
import { measurementSeamEnv, runSchedule, sampleRow } from "./run-sample.mjs";
import { assertSeedPinsBeforeK64 } from "./seed-pin.mjs";
import {
  assertCompleteSetupReceipt,
  loadSetupReceipt,
} from "./setup-receipt.mjs";
import { HARNESS_PAGE, sha256, startSession } from "./session.mjs";
import {
  hostSnapshot,
  readAncestorPids,
  startWindowSampler,
} from "./window.mjs";
import {
  readDeclarationInvariants,
  readIndexMetadata,
  readQuerySceneSeedPins,
} from "./workspace-db.mjs";

export const FROZEN_RUN_REPORT_SCHEMA = "nir1-cp4-frozen-k64-run/1";
const BODY_SEAM_RECEIPT_ROOT = ".grimodex-body-declaration-ci-receipts";
/** Hang guards of the harness (not K6/4 values; as k64-runner.mjs). */
const PARENT_LIMIT_MS = 30_000;
const MIX_WINDOW_GUARD_MS = 2_000;
const ADDON_CALL_TIMEOUT_MS = 10_000;
const STATUS_WAIT_MS = 20_000;
const OWNER_READY_WAIT_MS = 90_000;
const INDEX_BUILD_LIMIT_MS = 60_000;

const stripSha = (value) =>
  typeof value === "string" ? value.replace(/^sha256:/u, "") : value;

function bounded(promise, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(
              `[precheck] ${label} timed out after ${ADDON_CALL_TIMEOUT_MS} ms`,
            ),
          ),
        ADDON_CALL_TIMEOUT_MS,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}
const call = async (addon, name, ...args) =>
  JSON.parse(await bounded(addon(name, ...args), name));

export function parseArgs(argv) {
  const options = {
    "eval-build": path.join(ROOT, ".artifacts/cp4/eval-build"),
    "run-kind": "gold",
  };
  for (let at = 0; at < argv.length; at += 2) {
    if (!argv[at].startsWith("--") || argv[at + 1] === undefined)
      throw new Error("use --name value arguments");
    options[argv[at].slice(2)] = argv[at + 1];
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(options.run ?? ""))
    throw new Error("--run <name> is required");
  const dev = Boolean(options["dev-fixture"]);
  const required = dev
    ? ["setups", "ja-model", "en-model", "k62-commit"]
    : [
        "setups",
        "ja-model",
        "en-model",
        "candidate",
        "prep-commit",
        "k62-commit",
        "k64-commit",
        "product-receipt",
      ];
  for (const name of required)
    if (!options[name]) throw new Error(`--${name} is required`);
  // d10.parity (P1-2): `parity` is the unrestricted R+IR run; `gold` the
  // restricted run of both arms (G-01 follows d10.g01).
  if (!["gold", "parity"].includes(options["run-kind"]))
    throw new Error("--run-kind is gold or parity");
  if (options["d2a-mode"] !== undefined)
    throw new Error(
      "--d2a-mode is gone: the mode follows --run-kind (parity is unrestricted) and d10.g01",
    );
  if (!dev && options["dev-g01-fallback"] !== undefined)
    throw new Error(
      "[precheck] --dev-g01-fallback is a dev shape-check option; a formal G-01 follows d10.g01",
    );
  // Review P2-6 (a): a formal run measures every variant of its kind.
  if (!dev && options.variant !== undefined)
    throw new Error(
      "[precheck] a formal run measures all its variants; --variant is a dev shape-check option",
    );
  // Dev only: fewer one-shot processes for the shape check (never formal).
  if (options["one-shot-processes"] !== undefined) {
    if (!dev)
      throw new Error(
        "[precheck] --one-shot-processes is a dev shape-check option; a formal one-shot variant runs warm-up 5 and measured 30 processes per arm",
      );
    const count = Number(options["one-shot-processes"]);
    if (!Number.isInteger(count) || count < 1 || count > 30)
      throw new Error("--one-shot-processes is 1..30");
  }
  return options;
}

/** The setup receipts by variant key (`--setups` JSON). */
export async function readSetups({ file, plans, dev, candidate = null }) {
  const map = JSON.parse(await readFile(path.resolve(file), "utf8"));
  const rows = new Map();
  for (const plan of plans) {
    const receiptPath = map[plan.variantKey];
    if (typeof receiptPath !== "string") continue;
    const absolute = path.resolve(ROOT, receiptPath);
    const bytes = await readFile(absolute);
    const value = JSON.parse(bytes);
    if (
      value.fixture?.path !== plan.fixturePath ||
      value.fixture?.sha256 !== plan.fixtureSha256 ||
      value.fixture?.variantId !== plan.variantId
    )
      throw new Error(
        `[precheck] ${plan.variantKey}: the setup receipt is of another fixture or variant`,
      );
    // Review P2-5: ⑤ sets up on the S5 candidate (a new workspace).
    if (
      candidate !== null &&
      (value.candidate?.commit !== candidate.commit ||
        value.candidate?.tree !== candidate.tree)
    )
      throw new Error(
        `[precheck] ${plan.variantKey}: the setup ran on ${String(value.candidate?.commit)} (tree ${String(value.candidate?.tree)}), not the run's candidate ${candidate.commit}`,
      );
    if (value.status === "blocked") {
      rows.set(plan.variantKey, {
        path: absolute,
        sha256: sha256(bytes),
        value,
        blocked: true,
      });
      continue;
    }
    // A frozen receipt is sealed by loadSetupReceipt (④⑤ need complete
    // ones); a dev graph-case receipt is read as is (preview only).
    const sealed = dev
      ? null
      : assertCompleteSetupReceipt(
          loadSetupReceipt({ root: ROOT, file: absolute }),
        );
    if (value.status !== "setup-complete")
      throw new Error(
        `[precheck] ${plan.variantKey}: the setup receipt is ${value.status}, not setup-complete`,
      );
    rows.set(plan.variantKey, {
      path: absolute,
      sha256: sha256(bytes),
      value,
      sealed,
      blocked: false,
    });
  }
  return rows;
}

async function launchMeasurement({ label, dir, shared, d2aMode, bodySeam }) {
  const nonce = randomUUID();
  const session = await startSession({
    runDir: dir,
    label,
    server: shared.server,
    observer: shared.observer,
    nativePath: shared.nativePath,
    d2aMode,
    models: shared.models,
    tmpRoot: shared.tmpRoot,
    admission: shared.admission,
    // Review P3 (e): the body declaration seam (and CI=true) only in a
    // process that declares.
    extraEnv: bodySeam
      ? measurementSeamEnv({ bodyNonce: nonce, maintenance: "product" })
      : {},
  });
  try {
    if (session.evidence.problems.length > 0)
      throw new Error(session.evidence.problems.join("; "));
    // V-10 (registration, worker path, gate, the profile's mode); no query.
    const started = Date.now();
    let status = await call(session.addon, "nir1GraphEvalStatus");
    while (
      Date.now() - started < STATUS_WAIT_MS &&
      !(
        status.registrations === 1 &&
        status.worker?.state === "configured" &&
        status.gateOpened === true
      )
    ) {
      await delay(100);
      status = await call(session.addon, "nir1GraphEvalStatus");
    }
    if (
      status.registrations !== 1 ||
      status.worker?.state !== "configured" ||
      status.gateOpened !== true ||
      status.owner?.profile?.restricted !== (d2aMode === "restricted") ||
      status.owner?.profile?.inFlightStopped !== true
    )
      throw new Error(
        `[precheck] V-10: the evaluation owner is not ready: ${JSON.stringify(status)}`,
      );
    return { session, nonce, status };
  } catch (error) {
    error.launchedSession = session;
    await session.stop().catch(() => {});
    throw error;
  }
}

async function stopSession(session, dir, label) {
  const evidence = await session.stop();
  await writeFile(path.join(dir, `${label}-main-stderr.log`), session.stderr());
  return evidence;
}

async function evaluateOk(page, label, fn, arg) {
  const result = await page.evaluate(fn, arg);
  if (!result?.ok)
    throw new Error(
      `${label} failed: ${result?.error ?? JSON.stringify(result)}`,
    );
  return result.value;
}

const invokeOk = (page, cmd, args = {}) =>
  evaluateOk(
    page,
    cmd,
    ([name, input]) => window.cp4Harness.call(name, input),
    [cmd, args],
  );

async function readSeamReceipt(userData, nonce) {
  const file = path.join(
    userData,
    BODY_SEAM_RECEIPT_ROOT,
    sha256(Buffer.from(nonce)),
    "receipt.json",
  );
  if (!existsSync(file)) return null;
  const bytes = await readFile(file);
  return { sha256: sha256(bytes), value: JSON.parse(bytes) };
}

const indexPair = (metadata) => ({
  b: {
    generation: metadata?.b?.generation ?? -1,
    dirty: metadata?.b?.dirty ?? true,
  },
  chronicle: {
    generation: metadata?.chronicle?.generation ?? -1,
    dirty: metadata?.chronicle?.dirty ?? true,
  },
});

/**
 * K2/4 declaration step (D1 (ii)): in the measurement workspace before any
 * seeded query. Records the Index metadata, the workspace ID, the canonical
 * locator digest, the token and the binding digest, and the values the
 * declaration writer never writes (`readDeclarationInvariants`) before and
 * after. A difference stops before the measurement (`[precheck]`, never
 * blocked).
 */
async function declarationStep({
  page,
  session,
  nonce,
  dbPath,
  ids,
  sceneId,
  workspacePath,
}) {
  const scene = {
    workspacePath,
    projectId: ids.projectId,
    sceneId: ids.scenes[sceneId],
  };
  if (!scene.sceneId)
    throw new Error(
      `[precheck] K2/4: the declaration Scene ${sceneId} is not mapped`,
    );
  const capture = await invokeOk(
    page,
    "narrative_extraction_capture_workspace_binding",
    { expectedWorkspacePath: workspacePath },
  );
  const invariantsBefore = readDeclarationInvariants(dbPath, ids.projectId);
  const indexBefore = indexPair(readIndexMetadata(dbPath, ids.projectId));
  const declare = await page.evaluate(
    (input) => window.cp4Harness.declaration.declare(input),
    scene,
  );
  const indexAfter = indexPair(readIndexMetadata(dbPath, ids.projectId));
  const invariantsAfter = readDeclarationInvariants(dbPath, ids.projectId);
  const stateAfter = await page.evaluate(
    (input) => window.cp4Harness.declaration.state(input),
    scene,
  );
  const seam = await readSeamReceipt(session.userData, nonce);
  const lastDigest = stripSha(
    seam?.value?.approvedBindingDigests?.at(-1) ?? null,
  );
  const declaration = {
    sceneId: scene.sceneId,
    logicalSceneId: sceneId,
    result: declare,
    workspaceId: capture.authorityId,
    canonicalLocatorDigest: sha256(Buffer.from(realpathSync(workspacePath))),
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
    invariants: { before: invariantsBefore, after: invariantsAfter },
    stateAfter,
    verified: false,
  };
  if (JSON.stringify(indexBefore) !== JSON.stringify(indexAfter))
    throw Object.assign(
      new Error(
        `[precheck] K2/4: the Index metadata changed across the declaration step: ${JSON.stringify({ indexBefore, indexAfter })}`,
      ),
      { declaration },
    );
  declarationInvariantCheck({
    before: invariantsBefore,
    after: invariantsAfter,
  });
  const stateNow = await page.evaluate(
    (input) => window.cp4Harness.declaration.state(input),
    scene,
  );
  const captureNow = await invokeOk(
    page,
    "narrative_extraction_capture_workspace_binding",
    { expectedWorkspacePath: workspacePath },
  );
  const effective =
    stateNow.ok &&
    stateNow.snapshot.state.kind === "declared" &&
    stateNow.snapshot.state.effective === true &&
    stateNow.snapshot.declarationToken === declaration.token;
  const measurementWorkspace = {
    path: path.relative(ROOT, workspacePath),
    workspaceId: captureNow.authorityId,
    canonicalLocatorDigest: sha256(Buffer.from(realpathSync(workspacePath))),
    bindingDigest: effective ? lastDigest : null,
    state: stateNow,
  };
  assertDeclarationCurrent({ declaration, measurementWorkspace });
  declaration.verified = true;
  return { declaration, measurementWorkspace };
}

/** A fresh byte copy of the sealed cold DB at a new path (d2, §15.5). */
async function freshCopy({ setup, dir }) {
  const cold = path.resolve(ROOT, setup.value.coldDatabase.path);
  const want = setup.value.coldDatabase.sha256;
  if (sha256(await readFile(cold)) !== want)
    throw new Error("[precheck] the sealed setup DB changed");
  const workspacePath = path.join(dir, "workspace");
  await mkdir(workspacePath, { recursive: true });
  const dbPath = path.join(workspacePath, "grimodex.db");
  await copyFile(cold, dbPath);
  if (sha256(await readFile(dbPath)) !== want)
    throw new Error(
      "[precheck] the measurement copy is not the cold DB's bytes",
    );
  return { workspacePath, dbPath };
}

/** The R1／R4 clock (performance.now; the tests hand `ctx.clock`). */
const nowOf = (ctx) => (ctx.clock?.now ?? (() => performance.now()))();

/** Removes a one-shot process's copy after its stop, keeping its digest. */
async function removeCopy(proc) {
  let sha256After;
  try {
    sha256After = sha256(await readFile(proc.dbPath));
  } catch {
    sha256After = null;
  }
  await rm(proc.workspacePath, { recursive: true, force: true });
  return {
    path: path.relative(ROOT, proc.dbPath),
    sha256After,
    removed: !existsSync(proc.workspacePath),
  };
}

/** One Graph-arm sample through the hook consumer (R1〜R4, R7). */
async function graphSample({ ctx, slot }) {
  const { addon, page, procedure, ids, dbPath, revisionIds } = ctx;
  await call(addon, "nir1GraphEvalClearSamples");
  await call(addon, "nir1GraphEvalClearNextQueryCache");
  const r1 = await waitR1({
    ...ctx.clock,
    addon,
    waitMs: procedure.values.r1r4WaitMs,
    lastSeededEndedAt: ctx.lastSeededEndedAt,
    previousReleaseWithinLimit: ctx.previousReleaseWithinLimit,
  });
  const before = await call(addon, "nir1GraphEvalDiagnostics");
  const a3 =
    revisionIds.length > 0
      ? await call(
          addon,
          "nir1GraphEvalReadA3",
          dbPath,
          ids.projectId,
          ids.querySceneId,
          revisionIds,
        )
      : null;
  const raw = await evaluateOk(
    page,
    "k64 sample",
    (input) => window.cp4Harness.k64.sample(input),
    {
      projectId: ids.projectId,
      tShowMs: procedure.values.tShowMs,
      parentLimitMs: PARENT_LIMIT_MS,
      wfMs: K64_W_F_MS,
      mixGuardMs: MIX_WINDOW_GUARD_MS,
    },
  );
  // DR-CP4-N-4: the quotes become digests before anything is kept.
  const observed = hashObservationPaths(raw);
  ctx.lastSeededEndedAt = nowOf(ctx);
  if (observed.endReason === "harness-limit")
    throw new Error(
      "[artifact] the parent query never returned within the harness guard",
    );
  const atEndStatus = await call(addon, "nir1GraphEvalStatus");
  const occupied = atEndStatus.owner?.cacheOccupied ?? null;
  const cleared = occupied
    ? (await call(addon, "nir1GraphEvalClearNextQueryCache")).cleared === true
    : false;
  const r2 = r2Record({ cacheOccupiedAtEnd: occupied, cleared });
  const atEnd = await call(addon, "nir1GraphEvalDiagnostics");
  const release = await waitRelease({
    ...ctx.clock,
    addon,
    waitMs: procedure.values.r1r4WaitMs,
  });
  ctx.previousReleaseWithinLimit = release.withinLimit;
  const afterRelease = await call(addon, "nir1GraphEvalDiagnostics");
  const records = (await call(addon, "nir1GraphEvalSamples")).records;
  const row = k64GraphSampleRow({
    variantKey: ctx.variant.key,
    phase: slot.phase,
    repeat: slot.repeat,
    d2aMode: ctx.d2aMode,
    observation: observed,
    nativeRecords: records,
    a3,
    r1,
    r2,
    counters: { before, atEnd, afterRelease },
    expectedContribution: ctx.expectedContribution,
    ...(ctx.materialContribution
      ? { materialContribution: ctx.materialContribution }
      : {}),
  });
  // Review P3 (f): the dev preview judges F6 on Scenes (DR-CP4-F-6) and
  // records the Revision match beside it.
  if (ctx.materialPreview && row.followUp?.child)
    row.followUp.child.materialRevisionPreview = ctx.materialPreview(
      observed.fetches?.[1]?.paths ?? null,
    );
  const parent = observed.fetches?.[0]?.result ?? null;
  return {
    row,
    release,
    indexUsable: parent?.initialSnapshot?.indexUsable ?? null,
  };
}

async function hybridSample({ ctx, slot }) {
  await call(ctx.addon, "nir1GraphEvalClearSamples");
  const measure = await ctx.page.evaluate(
    (input) => window.cp4Harness.measure(input),
    { sceneId: ctx.ids.querySceneId, seed: null },
  );
  return {
    row: sampleRow({
      variantKey: ctx.variant.key,
      ...slot,
      d2aMode: ctx.d2aMode,
      measure,
    }),
    indexUsable: measure?.initialSnapshot?.indexUsable ?? null,
  };
}

/**
 * The opening of one measurement process up to the first measured query:
 * the copy, the Main, the workspace, the declaration step (declaration runs
 * only, before any seeded query), the Raw vectors, the Chronicle Index
 * (steady state only), SP-P1 on the copy and the before-measurement probe.
 */
async function openProcess({ ctx, dir, label }) {
  const { spec, setup, shared } = ctx;
  const copy = await freshCopy({ setup, dir });
  const declares = Boolean(
    spec.declaration &&
    ctx.d2aMode === "restricted" &&
    ctx.arms.includes("graph"),
  );
  const launched = await (shared.launchMeasurement ?? launchMeasurement)({
    label,
    dir,
    shared,
    d2aMode: ctx.d2aMode,
    bodySeam: declares,
  });
  const { session } = launched;
  const proc = { session, ...copy, checks: { status: launched.status } };
  try {
    const page = session.page;
    await evaluateOk(
      page,
      "open workspace",
      (input) => window.cp4Harness.openWorkspace(input),
      {
        workspacePath: copy.workspacePath,
        projectId: ctx.ids.projectId,
        activeSceneId: ctx.ids.querySceneId,
      },
    );
    proc.checks.metadataAtOpen = readIndexMetadata(
      copy.dbPath,
      ctx.ids.projectId,
    );
    if (declares) {
      const declared = await declarationStep({
        page,
        session,
        nonce: launched.nonce,
        dbPath: copy.dbPath,
        ids: ctx.ids,
        sceneId: spec.declaration.sceneId,
        workspacePath: copy.workspacePath,
      });
      proc.declaration = declared.declaration;
      proc.measurementWorkspace = declared.measurementWorkspace;
    }
    proc.checks.raw = await evaluateOk(
      page,
      "build Raw",
      (input) => window.cp4Harness.buildRaw(input),
      {
        projectId: ctx.ids.projectId,
        label: `cp4-${shared.run}`,
        sceneIds: Object.values(ctx.ids.scenes),
        queryBody: ctx.queryBody,
      },
    );
    if (!proc.checks.raw.ok)
      throw new Error(
        `[artifact] the Raw index did not publish every Scene: ${JSON.stringify(proc.checks.raw).slice(0, 2000)}`,
      );
    let indexUsable = null;
    if (spec.buildChronicleIndex) {
      const index = await page.evaluate(
        (input) => window.cp4Harness.buildIndex(input),
        { sceneId: ctx.ids.querySceneId, limitMs: INDEX_BUILD_LIMIT_MS },
      );
      indexUsable =
        index?.probes?.at(-1)?.initialSnapshot?.indexUsable ??
        (index?.ok === true ? true : false);
      proc.checks.chronicleIndex = {
        ok: index?.ok ?? false,
        durationMs: index?.durationMs ?? null,
        probes: index?.probes?.length ?? null,
        lastIndexUsable: indexUsable,
      };
    }
    // SP-P1 again on this copy (⑤), against the gate's row.
    proc.checks.seedPin = measurementCopySeedCheck({
      gateRow: ctx.gateRow,
      read: readQuerySceneSeedPins(
        copy.dbPath,
        ctx.ids.projectId,
        ctx.ids.querySceneId,
      ),
    });
    proc.before = d2ProbeCheck({
      spec,
      setupProbe: ctx.setupProbe,
      metadata: readIndexMetadata(copy.dbPath, ctx.ids.projectId),
      indexUsable,
      at: "before-measurement",
    });
    return proc;
  } catch (error) {
    // The caller never receives this process: stop its Main here (by its own
    // handle), so a [precheck] before the first query leaks no Electron.
    error.process = proc;
    proc.evidence = await stopSession(session, dir, label).catch(
      (stopError) => ({
        problems: [`stop: ${stopError?.stack ?? stopError}`],
      }),
    );
    throw error;
  }
}

/** V-10 READY through the hook consumer (steady state only; seeded). */
async function readyProbe(ctx) {
  const ready = [];
  const started = performance.now();
  let diagnostics = await call(ctx.addon, "nir1GraphEvalDiagnostics");
  while (
    (diagnostics.preparesReady ?? 0) < 1 &&
    performance.now() - started < OWNER_READY_WAIT_MS
  ) {
    const probe = await ctx.page.evaluate(
      (input) => window.cp4Harness.k64.sample(input),
      {
        projectId: ctx.ids.projectId,
        tShowMs: ctx.procedure.values.tShowMs,
        parentLimitMs: PARENT_LIMIT_MS,
        wfMs: K64_W_F_MS,
        mixGuardMs: MIX_WINDOW_GUARD_MS,
      },
    );
    ctx.lastSeededEndedAt = nowOf(ctx);
    const release = await waitRelease({
      ...ctx.clock,
      addon: ctx.addon,
      waitMs: ctx.procedure.values.r1r4WaitMs,
    });
    ctx.previousReleaseWithinLimit = release.withinLimit;
    diagnostics = await call(ctx.addon, "nir1GraphEvalDiagnostics");
    ready.push({
      ok: probe.ok,
      endReason: probe.value?.endReason ?? null,
      release,
      preparesReady: diagnostics.preparesReady ?? null,
    });
    if ((diagnostics.preparesReady ?? 0) < 1) await delay(1_000);
  }
  if ((diagnostics.preparesReady ?? 0) < 1)
    throw new Error("[precheck] V-10: the worker never reached READY");
  return { probes: ready, diagnostics };
}

/**
 * d2 at a query. Review P2-4: S2 checks the index state at the query only
 * for the three read-as variants (`holding`); for the others the probe is
 * an observation (a C that turns unusable is a product failure the
 * classifiers see), never a stop. Review P3 (i): a read-as variant's B
 * metadata is read at the query too.
 */
function atQueryProbe({ ctx, taken }) {
  const metadata = ctx.spec.holding
    ? readIndexMetadata(ctx.dbPath, ctx.ids.projectId)
    : null;
  const at = d2ProbeCheck({
    spec: ctx.spec,
    setupProbe: ctx.setupProbe,
    metadata,
    indexUsable: taken.indexUsable,
    at: "at-query",
  });
  return {
    ...at,
    stops: !at.ok && ctx.spec.holding,
    probe: {
      ...at.probe,
      ...(at.ok ? {} : { mismatch: true, observedOnly: !ctx.spec.holding }),
    },
  };
}

function blockedResult({ ctx, check, samples, extra = {} }) {
  return {
    status: "blocked",
    blocked: blockedJudgement({ plan: ctx.plan, blocked: check.blocked }),
    probe: check.probe,
    samples,
    ...extra,
  };
}

/** One steady-state (or graph-held-unusable) variant in one process. */
async function measureSteady(ctx) {
  const dir = path.join(ctx.variantDir, "measure");
  const samples = [];
  const probes = [];
  let proc = null;
  try {
    proc = await openProcess({ ctx, dir, label: "session" });
    probes.push(proc.before.probe);
    if (!proc.before.ok)
      return blockedResult({
        ctx,
        check: proc.before,
        samples,
        extra: { proc },
      });
    Object.assign(ctx, {
      page: proc.session.page,
      addon: proc.session.addon,
      dbPath: proc.dbPath,
      lastSeededEndedAt: null,
      previousReleaseWithinLimit: true,
    });
    const arms = ctx.arms;
    if (arms.includes("graph")) {
      await evaluateOk(
        ctx.page,
        "hook prepare",
        (input) => window.cp4Harness.hook.prepare(input),
        { workspacePath: proc.workspacePath },
      );
      const instrumented = await ctx.page.evaluate(() =>
        window.cp4Harness.k64.instrumented(),
      );
      if (instrumented?.fetchTiming !== true)
        throw new Error("[precheck] the fetch timing shim is not in the page");
      proc.checks.ownerReady = await readyProbe(ctx);
    }
    const launcherChain = readAncestorPids();
    const measuring = proc.session;
    ctx.windowSampler = (ctx.shared.startWindowSampler ?? startWindowSampler)({
      root: ROOT,
      ownPids: () => [...launcherChain, ...measuring.pids()],
    });
    ctx.run = { startedAtMs: Date.now() };
    const releases = [];
    for (const slot of runSchedule()) {
      if (!arms.includes(slot.arm)) continue;
      const taken =
        slot.arm === "hybrid"
          ? await hybridSample({ ctx, slot })
          : await graphSample({ ctx, slot });
      samples.push(taken.row);
      if (taken.release) releases.push({ ...slot, ...taken.release });
      const at = atQueryProbe({ ctx, taken });
      probes.push({
        ...at.probe,
        phase: slot.phase,
        repeat: slot.repeat,
        arm: slot.arm,
      });
      if (at.stops)
        return blockedResult({
          ctx,
          check: at,
          samples,
          extra: { proc, probes },
        });
    }
    ctx.run.finishedAtMs = Date.now();
    proc.checks.releases = releases;
    return { status: "measured", samples, probes, proc };
  } finally {
    ctx.windowSamples = ctx.windowSampler?.stop() ?? [];
    ctx.windowSampler = null;
    if (proc?.session)
      proc.evidence = await stopSession(proc.session, dir, "session").catch(
        (error) => ({ problems: [`stop: ${error?.stack ?? error}`] }),
      );
  }
}

/**
 * One one-shot variant (S2 P-4 (b), C1〜C5): every process is a fresh byte
 * copy of the cold DB, issues no query before its measured one (no
 * Chronicle Index build, no READY probe, no declaration), takes one query
 * of its arm and stops.
 */
async function measureOneShot(ctx) {
  const schedule = oneShotProcessSchedule(ctx.oneShot);
  const samples = [];
  const probes = [];
  const processes = [];
  const evidences = [];
  const launcherChain = readAncestorPids();
  let current = null;
  ctx.windowSampler = (ctx.shared.startWindowSampler ?? startWindowSampler)({
    root: ROOT,
    ownPids: () => [...launcherChain, ...(current?.pids() ?? [])],
  });
  // The run spans the first measured query to the last one, inside the
  // processes' lives (their socket samplers run from launch to stop).
  ctx.run = { startedAtMs: null };
  try {
    for (const slot of schedule) {
      if (!ctx.arms.includes(slot.arm)) continue;
      const dir = path.join(
        ctx.variantDir,
        `process-${String(slot.process).padStart(2, "0")}`,
      );
      let proc = null;
      try {
        proc = await openProcess({ ctx, dir, label: "session" });
        current = proc.session;
        probes.push({ ...proc.before.probe, process: slot.process });
        if (!proc.before.ok)
          return blockedResult({
            ctx,
            check: proc.before,
            samples,
            extra: { probes, processes, evidences },
          });
        Object.assign(ctx, {
          page: proc.session.page,
          addon: proc.session.addon,
          dbPath: proc.dbPath,
          lastSeededEndedAt: null,
          previousReleaseWithinLimit: true,
        });
        if (slot.arm === "graph")
          await evaluateOk(
            ctx.page,
            "hook prepare",
            (input) => window.cp4Harness.hook.prepare(input),
            { workspacePath: proc.workspacePath },
          );
        ctx.run.startedAtMs ??= Date.now();
        const taken =
          slot.arm === "hybrid"
            ? await hybridSample({ ctx, slot })
            : await graphSample({ ctx, slot });
        samples.push({
          ...taken.row,
          measurement: ctx.oneShot.receiptLabel,
          process: slot.process,
        });
        ctx.run.finishedAtMs = Date.now();
        const at = atQueryProbe({ ctx, taken });
        probes.push({ ...at.probe, process: slot.process, arm: slot.arm });
        processes.push({
          process: slot.process,
          phase: slot.phase,
          repeat: slot.repeat,
          arm: slot.arm,
          seedPin: proc.checks.seedPin.status,
          raw: proc.checks.raw.ok,
        });
        if (at.stops)
          return blockedResult({
            ctx,
            check: at,
            samples,
            extra: { probes, processes, evidences },
          });
      } finally {
        if (proc?.session)
          evidences.push(
            await stopSession(proc.session, dir, "session").catch((error) => ({
              problems: [`stop: ${error?.stack ?? error}`],
            })),
          );
        current = null;
        // Review P3 (h): the process's copy is removed after its stop; its
        // bytes' digest stays in the record.
        if (proc?.dbPath) {
          const copy = await removeCopy(proc);
          const row = processes.find((entry) => entry.process === slot.process);
          if (row) row.copy = copy;
          else processes.push({ process: slot.process, copy });
        }
      }
    }
    return { status: "measured", samples, probes, processes, evidences };
  } finally {
    ctx.windowSamples = ctx.windowSampler?.stop() ?? [];
    ctx.windowSampler = null;
  }
}

/**
 * The receipt's environment from the measurement processes' stop evidence
 * (the k64-runner.mjs shape). A one-shot variant has one evidence per
 * process: the X11 listing spans the first and the last, the socket
 * samples are concatenated, and every other record is the last process's
 * with all of them kept under `processes` (DR-CP4-N-9).
 */
function environmentOf({ ctx, evidences }) {
  const first = evidences[0] ?? {};
  const last = evidences.at(-1) ?? {};
  const ownPids = [
    ...readAncestorPids(),
    ...evidences.flatMap((row) =>
      (row.recordedPids ?? []).map((pid) => pid.pid),
    ),
  ];
  return {
    hostSnapshot: hostSnapshot(),
    windowSamples: ctx.windowSamples,
    windowAssessment: ctx.run?.finishedAtMs
      ? assessMeasurementWindow({
          samples: ctx.windowSamples,
          run: ctx.run,
          ownPids,
        })
      : null,
    ownPids,
    xvfbDisplay: process.env.DISPLAY,
    removedEnv: last.launch?.removedEnv ?? null,
    launchEnvChecked: last.launch?.checkedAbsent ?? null,
    netns: last.launch?.netns ?? null,
    netLog: last.netLog ?? null,
    socketSamples: evidences.flatMap((row) => row.socketSamples ?? []),
    x11: { before: first.x11Before ?? null, after: last.x11After ?? null },
    profileEgress: {
      dictionaries: last.dictionaries ?? null,
      networkPersistentServers: last.networkPersistentServers ?? null,
    },
    observer: last.observerCheck ?? null,
    stop: last.stop ?? null,
    mainWorker: last.mainWorker ?? null,
    ...(evidences.length > 1
      ? {
          processes: evidences.map((row) => ({
            problems: row.problems ?? [],
            stop: row.stop ?? null,
            observer: row.observerCheck ?? null,
            mainWorker: row.mainWorker ?? null,
            dictionaries: row.dictionaries ?? null,
            networkPersistentServers: row.networkPersistentServers ?? null,
          })),
        }
      : {}),
  };
}

/**
 * One variant's measurement: a steady-state (or graph-held-unusable) process,
 * or the one-shot processes. `ctx.shared.launchMeasurement`,
 * `ctx.shared.startWindowSampler` and `ctx.clock` replace the Electron
 * launch, the window sampler and the R1／R4 clock in the tests only.
 */
export function measureVariant(ctx) {
  if (ctx.spec.kind === "one-shot") return measureOneShot(ctx);
  if (ctx.g01Fallback) return measureG01Fallback(ctx);
  return measureSteady(ctx);
}

/**
 * DR-CP4-N-10: G-01's fallback (d10.g01, `rAndRirMode` unrestricted). The
 * D2a mode is a launch's profile state, so two processes on fresh copies of
 * the same cold DB run in series: the unrestricted one takes the R+IR slots
 * (no declaration, no READY probe, no Graph arm), the restricted one the
 * R+IR+Graph slots (declaration, Index, READY probe). The samples are put
 * in the AB/BA schedule's order, each naming its process; the comparison's
 * baseline is this run's unrestricted R+IR.
 */
async function measureG01Fallback(ctx) {
  const parts = [];
  for (const [label, arm, d2aMode] of [
    ["hybrid-unrestricted", "hybrid", "unrestricted"],
    ["graph-restricted", "graph", "restricted"],
  ]) {
    const part = {
      ...ctx,
      arms: [arm],
      d2aMode,
      g01Fallback: false,
      variantDir: path.join(ctx.variantDir, label),
    };
    await mkdir(part.variantDir, { recursive: true });
    const result = await measureSteady(part);
    parts.push({ label, part, result });
    if (result.status !== "measured") {
      Object.assign(ctx, {
        run: part.run,
        windowSamples: part.windowSamples,
      });
      return {
        ...result,
        samples: parts.flatMap((row) =>
          row.result.samples.map((sample) => ({
            ...sample,
            armProcess: row.label,
          })),
        ),
        armProcesses: parts.map((row) => row.label),
      };
    }
  }
  const [hybrid, graph] = parts;
  ctx.run = {
    startedAtMs: hybrid.part.run.startedAtMs,
    finishedAtMs: graph.part.run.finishedAtMs,
  };
  ctx.windowSamples = [
    ...(hybrid.part.windowSamples ?? []),
    ...(graph.part.windowSamples ?? []),
  ];
  return {
    status: "measured",
    samples: scheduleOrder(
      parts.flatMap((row) =>
        row.result.samples.map((sample) => ({
          ...sample,
          armProcess: row.label,
        })),
      ),
    ),
    probes: parts.flatMap((row) =>
      row.result.probes.map((probe) => ({ ...probe, armProcess: row.label })),
    ),
    proc: graph.result.proc,
    evidences: [
      hybrid.result.proc?.evidence,
      graph.result.proc?.evidence,
    ].filter(Boolean),
    armProcesses: parts.map((row) => ({
      label: row.label,
      d2aMode: row.part.d2aMode,
      arm: row.part.arms[0],
      run: row.part.run,
      seedPin: row.result.proc?.checks?.seedPin?.status ?? null,
    })),
  };
}

/** The N-5 disclosure the receipt carries (review P3 (g)). */
export const K64_DISCLOSURE = Object.freeze({
  x2: "X2 の TTL の切れと edge の epoch の進みは owner の counter に無く観測できない。起きた子は Cached で受けない（F5）か F2 の counter の差分が合わず X4 として失敗に数える（成功にも分母の外にもしない）。quarantine だけは counter で X2（DR-CP4-N-5）",
  q4: "q4 の決着から通知までは通知に Native の時刻が無く測らない（R6、2 つの時計を混ぜない）。renderer の時計の親の公開から最初の通知までを開示する（DR-CP4-F-7、N-5）",
});
export const BLOCKED_RECORD_SCHEMA = "nir1-cp4-blocked-variant/1";

const digestOf = (value) => sha256(Buffer.from(JSON.stringify(value)));

/**
 * One variant's record (review P1-1／P1-2): a blocked variant (at setup or
 * during the measurement) gets a blocked record — the blocked fields as the
 * table judged them, the probes, the samples taken so far with their
 * digest — and never goes through the aggregates; a measured variant gets
 * the run receipt of its kind (`g-case-gold`, or `g-case-parity-unrestricted`
 * whose schedule is the R+IR slots only), validated. A receipt the
 * aggregates refuse keeps its samples with their digest. Returns the run
 * report's row.
 */
export async function writeVariantRecord({
  ctx,
  result,
  runId,
  runKind,
  dev,
  admitted,
  candidate,
  priorAttempts,
  problems,
}) {
  const { spec, plan, setup, variantDir } = ctx;
  await mkdir(variantDir, { recursive: true });
  const base = {
    runId,
    variantKey: spec.variantKey,
    runKind,
    preview: dev,
    fixture: {
      path: plan.fixturePath,
      sha256: plan.fixtureSha256,
      kind: dev ? "dev" : "frozen",
    },
    head: admitted.head,
    candidate: {
      commit: candidate.commit,
      tree: candidate.tree,
      clean: candidate.clean,
    },
    setupReceipt: setup
      ? { path: path.relative(ROOT, setup.path), sha256: setup.sha256 ?? null }
      : null,
    priorAttempts,
  };
  if (result.status === "blocked" || result.status === "blocked-at-setup") {
    const samples = result.samples ?? [];
    const record = {
      schemaVersion: BLOCKED_RECORD_SCHEMA,
      ...base,
      status: result.status,
      blocked: result.blocked,
      probes: result.probes ?? (result.probe ? [result.probe] : []),
      samples,
      samplesSha256: digestOf(samples),
      ...(result.armProcesses ? { armProcesses: result.armProcesses } : {}),
    };
    await writeFile(
      path.join(variantDir, "blocked-record.json"),
      `${JSON.stringify(record, null, 2)}\n`,
    );
    await writeSha256Sums(variantDir, ["blocked-record.json"]);
    return {
      status: result.status,
      blocked: result.blocked,
      samples: samples.length,
      valid: true,
    };
  }
  const environment = environmentOf({
    ctx,
    evidences: result.evidences ?? [result.proc?.evidence].filter(Boolean),
  });
  let receipt;
  try {
    if (runKind === "parity")
      validateParitySchedule(result.samples, ctx.variant.key);
    receipt = assembleK64Receipt({
      runKind:
        runKind === "parity" ? "g-case-parity-unrestricted" : "g-case-gold",
      priorAttempts,
      runId,
      preview: dev,
      fixture: base.fixture,
      variant: ctx.variant,
      head: admitted.head,
      candidate,
      ratification5: admitted.ratification5,
      procedure: admitted.procedure,
      environment,
      run: ctx.run ?? null,
      settings: {
        maintenance: "product",
        d2aModes: ctx.g01Fallback
          ? { hybrid: "unrestricted", graph: "restricted" }
          : ctx.arms.includes("graph")
            ? { hybrid: ctx.d2aMode, graph: ctx.d2aMode }
            : { hybrid: ctx.d2aMode },
        reauthorization: {
          mode: ctx.g01Fallback ? "per-arm-process" : ctx.d2aMode,
          placedStateFile: true,
          note: "the D2a profile state placed before each launch; no activation UI",
        },
        ...(ctx.g01Fallback
          ? {
              g01Fallback: {
                decision: "DR-CP4-N-10",
                rAndRirMode: "unrestricted",
                da1AcceptanceRecord: ctx.spec.g01Mode?.record ?? "none",
                baseline: "the same run's unrestricted R+IR",
                armProcesses: result.armProcesses ?? null,
                abba: "AB/BA is the slots' order; each arm ran in its own process (no alternation in time)",
              },
            }
          : {}),
        setupReceipt: {
          path: base.setupReceipt.path,
          sha256: base.setupReceipt.sha256,
          logicalToRuntime: setup.value.logicalToRuntime,
        },
        measurement: {
          kind: spec.kind,
          ...(spec.kind === "one-shot"
            ? {
                label: ctx.oneShot.receiptLabel,
                processes: oneShotProcessSchedule(ctx.oneShot).filter((row) =>
                  ctx.arms.includes(row.arm),
                ).length,
              }
            : {}),
          measurementPoint: spec.measurementPoint,
          indexState: spec.indexState,
        },
        seed: {
          logical: plan.seedPin.seedEntityId,
          runtime: ctx.gateRow.expectedSeed,
          via: "product-hook-from-the-query-scene-pin",
        },
        f6: {
          basis: dev ? "scene-level-preview" : "material-revision",
          expected: ctx.resolverExpected ?? null,
        },
        k64Disclosure: K64_DISCLOSURE,
      },
      declaration: result.proc?.declaration ?? null,
      measurementWorkspace: result.proc?.measurementWorkspace ?? null,
      samples: result.samples,
      checks: {
        status: result.status,
        d2Probes: result.probes ?? [],
        process: result.proc?.checks ?? null,
        processes: result.processes ?? null,
        problems,
      },
    });
  } catch (error) {
    await writeFile(
      path.join(variantDir, "samples.json"),
      `${JSON.stringify(
        {
          ...base,
          status: result.status,
          refused: String(error?.message ?? error).split("\n")[0],
          samples: result.samples,
          samplesSha256: digestOf(result.samples),
          probes: result.probes ?? [],
        },
        null,
        2,
      )}\n`,
    );
    await writeSha256Sums(variantDir, ["samples.json"]);
    problems.push(`${spec.variantKey}: ${error?.stack ?? error}`);
    return {
      status: "receipt-refused",
      samples: result.samples.length,
      valid: false,
      error: String(error?.message ?? error).split("\n")[0],
    };
  }
  const errors = validateCp4Receipt(receipt, {
    ratification5: admitted.ratification5,
    procedure: admitted.procedure,
  });
  await writeFile(
    path.join(variantDir, "receipt.json"),
    `${JSON.stringify(receipt, null, 2)}\n`,
  );
  await writeFile(
    path.join(variantDir, "validation.json"),
    `${JSON.stringify({ valid: errors.length === 0, errors }, null, 2)}\n`,
  );
  await writeSha256Sums(variantDir, ["receipt.json", "validation.json"]);
  return {
    status: result.status,
    samples: result.samples.length,
    valid: errors.length === 0,
    errors: errors.slice(0, 20),
    verdict: receipt.verdict ?? null,
  };
}

function devVariantKeyOf(spec, fixturePath) {
  return `dev:${path.basename(fixturePath, ".json")}/${spec.variantId}`.toLowerCase();
}

/** The formal run (or the dev shape check) for `argv` (k64-runner.mjs hands `--setups` here). */
export async function runFrozenK64(argv) {
  const options = parseArgs(argv);
  const dev = Boolean(options["dev-fixture"]);
  const runKind = options["run-kind"];
  const d2aMode = runKind === "parity" ? "unrestricted" : "restricted";
  const runDir = path.join(ROOT, ".artifacts/cp4", options.run);
  await mkdir(runDir, { recursive: false });
  const report = {
    schema: FROZEN_RUN_REPORT_SCHEMA,
    run: options.run,
    mode: dev ? "dev-shape-preview" : "formal",
    runKind,
    d2aMode,
    problems: [],
    checks: {},
    variants: {},
  };
  let server = null;
  let attempt = null;
  try {
    // 1. admission (receipts are written only after it). Review P3 (b): the
    // cheap checks (a clean, fixed candidate; the K6/4 freeze head) come
    // before the keep test (minutes).
    const evalDir = path.resolve(options["eval-build"]);
    const nativePath = realpathSync(path.join(evalDir, "grimodex-node.node"));
    let admitted;
    if (!dev) {
      assertCandidateFixed({ root: ROOT, candidate: options.candidate });
      readK64FreezeHead({ root: ROOT, commit: options["k64-commit"] });
      const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
      const ratification5 = options["keep-test-worktree"]
        ? await collectRatification5EvidenceWithKeepTest({
            root: ROOT,
            candidateHead: options.candidate,
            keepTestWorktree: path.resolve(options["keep-test-worktree"]),
            keepTestLogDir: runDir,
          })
        : undefined;
      const formal = admitFormalK64Run({
        root: ROOT,
        candidate: options.candidate,
        prepCommit: options["prep-commit"],
        k62Commit: options["k62-commit"],
        k64Commit: options["k64-commit"],
        buildReceipt: readJson(path.join(evalDir, "eval-build.json")),
        productReceipt: readJson(path.resolve(options["product-receipt"])),
        defaultAddonSha256: sha256(
          readFileSync(path.join(ROOT, DEFAULT_ADDON)),
        ),
        ...(ratification5 ? { ratification5 } : {}),
      });
      admitted = {
        launchAdmission: formal.admission,
        procedure: formal.procedure,
        ratification5: formal.admission.ratification5,
        head: {
          ...formal.admission.head,
          runStartedAtUtc: new Date().toISOString(),
        },
        s2: formal.s2,
        candidate: formal.candidate,
      };
      report.checks.sourcePins = formal.pins;
      report.checks.s2 = Object.fromEntries(
        Object.entries(formal.s2.files).map(([name, row]) => [
          name,
          { path: row.path, sha256: row.sha256, commit: formal.s2.commit },
        ]),
      );
    } else {
      admitted = {
        launchAdmission: admitDevPreview({
          purpose: K64_DEV_PREVIEW_PURPOSE,
          fixture: null,
        }),
        procedure: loadProcedureFile({
          root: ROOT,
          version: options["procedure-version"] ?? DEV_DRAFT_PROCEDURE_VERSION,
          purpose: "dev-preview",
        }),
        ratification5: collectRatification5Evidence({
          root: ROOT,
          candidateHead: "HEAD",
        }),
        head: {
          k62: readK62FreezeHead({ root: ROOT, commit: options["k62-commit"] }),
          runStartedAtUtc: new Date().toISOString(),
        },
        candidate: null,
      };
    }
    // 2. plans, run specifications and the setups.
    const plans = dev
      ? loadDevGraphCasePlans({
          root: ROOT,
          fixturePath: options["dev-fixture"],
          stopsAt: "complete",
        })
      : loadFrozenSetupPlans({ root: ROOT, stopsAt: "complete" });
    const prep = admitted.s2?.files.observationPrep.value;
    const specs = dev
      ? plans.map((plan) => devRunSpec(plan))
      : formalRunPlan({
          plans,
          prep,
          addenda: [
            admitted.s2.files.g01Addendum.value,
            admitted.s2.files.declarationAddendum.value,
          ],
        });
    // d10: a parity run measures the 12 G-02〜G-08 variants; a Gold run all 13.
    const kindKeys =
      !dev && runKind === "parity" ? new Set(parityVariantKeys(prep)) : null;
    const selected = specs.filter(
      (spec) =>
        (!options.variant || spec.variantKey === options.variant) &&
        (kindKeys === null || kindKeys.has(spec.variantKey)),
    );
    if (selected.length === 0)
      throw new Error(`[precheck] no variant ${options.variant}`);
    for (const spec of selected)
      if (
        runKind === "gold" &&
        spec.caseId === "G-01" &&
        spec.g01Mode?.mode === null
      )
        throw new Error(
          `[precheck] DR-CP4-N-6 (ii): G-01's R and R+IR mode is unresolved (${spec.g01Mode.reason}); S4 fills d10.g01 first`,
        );
    const candidate = candidateBlock({
      options,
      nativePath,
      workerPath: path.join(evalDir, "nir1-c-query-worker"),
    });
    const setups = await readSetups({
      file: options.setups,
      plans,
      dev,
      candidate: dev ? null : admitted.candidate,
    });
    // Review P2-6 (b): the attempt ledger before anything is measured; the
    // earlier attempts of the same candidate, S4 commit and kind are
    // disclosed at every receipt's head. A Gold run needs a completed parity
    // run before it (P1-2, d10.parity).
    let priorAttempts;
    if (!dev) {
      const key = {
        root: ROOT,
        candidate: admitted.candidate.commit,
        s4Commit: admitted.s2.commit,
      };
      priorAttempts = listAttempts({ ...key, runKind }).map((row) => ({
        runName: row.runName ?? row.unreadable ?? null,
        status: row.status ?? "unreadable",
        startedAtUtc: row.startedAtUtc ?? null,
        finishedAtUtc: row.finishedAtUtc ?? null,
      }));
      if (runKind === "gold")
        report.checks.parityBefore = assertParityBefore({
          attempts: listAttempts({ ...key, runKind: "parity" }),
          startedAtUtc: admitted.head.runStartedAtUtc,
        });
      attempt = startAttempt({
        root: ROOT,
        runName: options.run,
        entry: {
          candidate: {
            commit: admitted.candidate.commit,
            tree: admitted.candidate.tree,
          },
          s4Commit: admitted.s2.commit,
          runKind,
          startedAtUtc: admitted.head.runStartedAtUtc,
          setups: Object.fromEntries(
            [...setups].map(([variantKey, row]) => [variantKey, row.sha256]),
          ),
        },
      });
      report.checks.priorAttempts = priorAttempts;
    }
    // DR-CP4-N-2／N-11: a blocked setup is judged by the table and its record
    // is kept; the seed pin gate needs 13 complete setups, so the K6/4
    // judgement does not start.
    const blocked = [];
    for (const plan of plans) {
      const setup = setups.get(plan.variantKey);
      if (!setup?.blocked) continue;
      const row = setup.value.blocked ?? {};
      const judged = blockedJudgement({
        plan,
        blocked: {
          harnessId: row.harnessId,
          condition: row.condition,
          unmet: row.unmetPreconditions ?? [],
        },
        recorded: row,
      });
      report.variants[plan.variantKey] = await writeVariantRecord({
        ctx: {
          spec: { variantKey: plan.variantKey },
          plan,
          setup,
          variantDir: path.join(
            runDir,
            plan.variantKey.replace(/[^A-Za-z0-9._-]+/gu, "_"),
          ),
        },
        result: { status: "blocked-at-setup", blocked: judged, probes: [] },
        runId: `${options.run}/${plan.variantKey}`,
        runKind,
        dev,
        admitted,
        candidate,
        priorAttempts,
        problems: report.problems,
      });
      blocked.push(plan.variantKey);
    }
    if (!dev && blocked.length > 0)
      throw new Error(
        `[precheck] DR-CP4-N-11: ${blocked.join(", ")} stopped blocked at setup; the seed pin gate needs the 13 complete setups, so the K6/4 judgement does not start`,
      );
    // 3. the seed pin gate before any process that can query (frozen: the
    // 13 cold DBs at stage evaluation; dev: the receipts' own maps).
    const gateRows = new Map();
    if (!dev) {
      const gate = assertSeedPinsBeforeK64({
        cases: plans.map((plan) => {
          const setup = setups.get(plan.variantKey);
          if (!setup)
            throw new Error(`[precheck] R5: no setup for ${plan.variantKey}`);
          return {
            caseId: plan.caseId,
            variantId: plan.variantId,
            setup: setup.sealed,
            read: readQuerySceneSeedPins(
              setup.sealed.coldDatabase.path,
              setup.sealed.projectId,
              setup.sealed.scenes[plan.seedPin.querySceneId],
            ),
          };
        }),
        plan: "frozen",
        seedPlan: plans.map((plan) => plan.seedPin),
        stage: "evaluation",
      });
      report.checks.seedPinGate = gate;
      for (const row of gate.rows)
        gateRows.set(`${row.caseId}/${row.variantId}`, row);
    } else
      for (const plan of plans) {
        const ids = setups.get(plan.variantKey)?.value?.logicalToRuntime;
        if (!ids) continue;
        gateRows.set(plan.variantKey, {
          caseId: plan.caseId,
          variantId: plan.variantId,
          querySceneId: ids.scenes[plan.seedPin.querySceneId],
          expectedSeed: ids.entities[plan.seedPin.seedEntityId],
        });
      }
    // 4. the launch material, once.
    report.checks.productBuild = checkRunnerBuildReceipts({
      root: ROOT,
      options,
      candidate,
      evalDir,
      required: !dev,
    });
    if (!dev && candidate.clean !== true)
      throw new Error("[precheck] the candidate worktree is not clean");
    const rendererBuild = await buildHarnessRenderer({
      root: ROOT,
      outDir: path.relative(ROOT, path.join(runDir, "renderer-dist")),
      input: {
        index: path.join(ROOT, "index.html"),
        harness: path.join(ROOT, HARNESS_PAGE.slice(1)),
      },
      timingShim: true,
      fetchTiming: true,
    });
    candidate.harnessFiles["renderer-bundle"] =
      rendererBuild.rendererBundleSha256;
    server = await startStaticServer({
      dir: path.join(runDir, "renderer-dist"),
    });
    const observer = await bundleObserver({
      outDir: path.join(runDir, "observer"),
    });
    candidate.harnessFiles["observer.cjs"] = observer.sha256;
    const shared = {
      run: options.run,
      server,
      observer,
      nativePath: path.join(evalDir, "grimodex-node.node"),
      models: { ja: options["ja-model"], en: options["en-model"] },
      tmpRoot: options.tmp ? path.join(options.tmp, options.run) : null,
      admission: admitted.launchAdmission,
    };
    // 5. the variants, in catalog order.
    for (const spec of selected) {
      const plan = plans.find((row) => row.variantKey === spec.variantKey);
      const setup = setups.get(spec.variantKey);
      if (!setup || setup.blocked) continue;
      // The frozen setup's map names the logical query Scene; the process
      // queries its runtime ID.
      const ids = {
        ...setup.value.logicalToRuntime,
        querySceneId:
          setup.value.logicalToRuntime.scenes?.[
            setup.value.logicalToRuntime.querySceneId
          ] ?? null,
      };
      if (ids.querySceneId === null)
        throw new Error(
          `[precheck] ${spec.variantKey}: the setup receipt maps no runtime query Scene`,
        );
      const fixture = JSON.parse(
        readFileSync(path.join(ROOT, plan.fixturePath), "utf8"),
      );
      const expectations =
        fixture.variants?.find((row) => row.id === plan.variantId)
          ?.expectations ??
        fixture.expectations ??
        null;
      const variant = dev
        ? devVariant({
            key: devVariantKeyOf(spec, plan.fixturePath),
            expectedGraph: expectations?.graph?.status ?? "available",
          })
        : variantByKey(spec.variantKey);
      const resolver = materialRevisionResolver({ plan, expectations, ids });
      const oneShot =
        spec.oneShot && options["one-shot-processes"]
          ? {
              ...spec.oneShot,
              warmupProcessesPerArm: Math.min(
                1,
                Number(options["one-shot-processes"]),
              ),
              measuredProcessesPerArm: Number(options["one-shot-processes"]),
            }
          : spec.oneShot;
      const ctx = {
        spec,
        plan,
        setup,
        shared,
        ids,
        variant,
        oneShot,
        gateRow: gateRows.get(spec.variantKey),
        setupProbe: setup.value.measurementPoint?.probe
          ? {
              bGeneration:
                setup.value.measurementPoint.probe.metadata?.b?.generation ??
                null,
              chronicleGeneration:
                setup.value.measurementPoint.probe.metadata?.chronicle
                  ?.generation ?? null,
            }
          : null,
        procedure: admitted.procedure,
        d2aMode,
        arms: runKind === "parity" ? ["hybrid"] : ["hybrid", "graph"],
        // DR-CP4-N-10: G-01's fallback when S4 set rAndRirMode unrestricted.
        // (dev: `--dev-g01-fallback true` exercises the same shape on a
        // dev variant; never formal.)
        g01Fallback:
          (runKind === "gold" &&
            spec.caseId === "G-01" &&
            spec.g01Mode?.mode === "unrestricted") ||
          (dev && options["dev-g01-fallback"] === "true"),
        resolverExpected: resolver.expected,
        queryBody: fixture.query?.body ?? fixture.query?.text ?? "",
        revisionIds: Object.values(ids.typedRevisions ?? {})
          .map((row) => row.revisionId)
          .filter(Boolean),
        expectedContribution: null,
        // DR-CP4-N-4: the formal run matches F6 on the Revisions; the dev
        // preview keeps the Scene unit and records the Revision match beside
        // it (DR-CP4-F-6, review P3 (f)).
        ...(dev
          ? { materialPreview: (paths) => resolver.contribution(paths) }
          : { materialContribution: (paths) => resolver.contribution(paths) }),
        variantDir: path.join(
          runDir,
          spec.variantKey.replace(/[^A-Za-z0-9._-]+/gu, "_"),
        ),
      };
      if (!ctx.gateRow)
        throw new Error(`[precheck] R5: no gate row for ${spec.variantKey}`);
      await mkdir(ctx.variantDir, { recursive: true });
      let result;
      try {
        result = await measureVariant(ctx);
      } catch (error) {
        report.problems.push(`${spec.variantKey}: ${error?.stack ?? error}`);
        report.variants[spec.variantKey] = {
          status: "stopped",
          error: String(error?.message ?? error).split("\n")[0],
          declaration:
            error?.declaration ?? error?.process?.declaration ?? null,
        };
        process.exitCode = 1;
        if (String(error?.message ?? "").startsWith("[precheck]")) break;
        continue;
      }
      const row = await writeVariantRecord({
        ctx,
        result,
        runId: `${options.run}/${spec.variantKey}`,
        runKind,
        dev,
        admitted,
        candidate,
        priorAttempts,
        problems: report.problems,
      });
      report.variants[spec.variantKey] = row;
      if (row.valid !== true) process.exitCode = 1;
    }
  } catch (error) {
    report.problems.push(error?.stack ?? String(error));
    process.exitCode = 1;
  } finally {
    await server?.close();
    if (attempt)
      finishAttempt({
        file: attempt.file,
        status:
          report.problems.length === 0 &&
          Object.values(report.variants).every((row) => row.valid === true)
            ? "completed"
            : "stopped",
        variants: Object.fromEntries(
          Object.entries(report.variants).map(([key, row]) => [
            key,
            row.status,
          ]),
        ),
      });
  }
  await writeFile(
    path.join(runDir, "run-report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  process.stdout.write(
    `${JSON.stringify({
      run: options.run,
      mode: report.mode,
      variants: Object.fromEntries(
        Object.entries(report.variants).map(([key, row]) => [
          key,
          {
            status: row.status,
            valid: row.valid ?? null,
            blocked: row.blocked?.contractBlockedId ?? null,
            error: row.error ?? null,
          },
        ]),
      ),
      problems: report.problems.map((row) => String(row).split("\n")[0]),
    })}\n`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename)
  await runFrozenK64(process.argv.slice(2));
