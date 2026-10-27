/* global window */
// CP-4 TR: the (b) trace runner (K6/4 R8, 判断 8 (ii) / 変える点 15, DR-CP4-F-11
// (2); DR-CP4-TR-1〜4). The steady-state runner's (`k64-runner.mjs`) launch,
// prep, R5 check and candidate block, with the trace in place of the AB/BA
// schedule:
//
//   TMPDIR=<short scratch> node scripts/local-ci-xvfb.mjs node \
//     scripts/quality/nir1-graph-eval/trace-runner.mjs --run <name> \
//     --setup .artifacts/cp4/<setup-run>/setup/setup-receipt.json \
//     --trace-kind editing|browsing [--cycles 3] \
//     --ja-model <pinned> --en-model <pinned> --k62-commit <K6/2 freeze> \
//     [--product-receipt <standard-build.json>] [--attempt 1]
//   frozen: --setup <G-02 base complete setup receipt> --prep-commit <S4> \
//     --k64-commit <K6/4 freeze> --product-receipt <standard-build.json> \
//     --sp-p4-receipt <④'s sp-p4-receipt.json> \
//     [--attempt 2 --previous-attempts <attempt-1 receipt.json>]
//
// One measurement session per trace: the product editor and the product hook
// consumer stay mounted (renderer/cp4-trace-probe.tsx), the owner counters are
// read by a Main poller (TR-2), and the trace operations are replayed:
// editing = caret + keyboard edit through the product editor → the autosave
// commit (observed only) → the product's own query; browsing = the tree action
// between the query Scene and a Scene without a pin. R1, R2 and R4 do not
// apply (変える点 15; the cache is never emptied). Each counted query's A3 is
// read once right after its parent fetch was observed.
//
// A dev fixture runs as a dev preview (seen by the integrator only, never a
// CP-4 result). A frozen trace (S2's files, DR-CP4-O-1 (6)) takes the G-02
// base complete setup receipt (`--setup`), the pre-observation commit
// (`--prep-commit`), the K6/2 and K6/4 freeze commits, the product
// standard-build receipt and, for a retake, the earlier attempts' receipts
// (`--previous-attempts`): `trace-frozen.mjs` admits it, writes the receipt
// head before any launch, reads the trace file from its commit and maps its
// logical IDs; a G-02 base that never reached setup-complete is recorded as
// (b) unmeasured without a launch.

import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";
import { setTimeout as delay } from "node:timers/promises";
import {
  admitDevPreview,
  collectRatification5Evidence,
  readAdmittedFixture,
  readK62FreezeHead,
} from "./admission.mjs";
import { checkRunnerBuildReceipts } from "./build-receipt-check.mjs";
import { loadDevFixture } from "./dev-fixture.mjs";
import { buildIndex, launch, openWorkspace } from "./dprime-check.mjs";
import { candidateBlock, devExpectedContribution } from "./k64-runner.mjs";
import { DEFAULT_ADDON, ROOT, bundleObserver } from "./launcher.mjs";
import { finishAttempt } from "./frozen-k64-admission.mjs";
import {
  outsideQReceiptCountByReason,
  readRunHead,
  writeRunHead,
} from "./frozen-diagnostics.mjs";
import {
  DEV_DRAFT_PROCEDURE_VERSION,
  loadProcedureFile,
  procedureSettings,
} from "./procedure-file.mjs";
import {
  assertDeclarationCurrent,
  assessMeasurementWindow,
  writeSha256Sums,
} from "./receipt.mjs";
import { buildHarnessRenderer, startStaticServer } from "./renderer-build.mjs";
import { assertSeedPinsBeforeK64 } from "./seed-pin.mjs";
import {
  FROZEN_SETUP_RECEIPT_SCHEMA,
  loadSetupReceipt,
} from "./setup-receipt.mjs";
import { readStartSeal } from "./trace-seal.mjs";
import { HARNESS_PAGE, sha256, startSession } from "./session.mjs";
import {
  COUNTER_POLL_DRAIN_SOURCE,
  COUNTER_POLL_INTERVAL_MS,
  COUNTER_POLL_SOURCE,
  COUNTER_POLL_STOP_SOURCE,
  TRACE_COUNTER_KEYS,
  TRACE_RUN_SCHEMA,
  devTracePlan,
  mergeNativeRecords,
  TRACE_MAINTENANCE_SEAM,
  startSealCounts,
  summarizeTraceRun,
  traceEvents,
  traceMaintenanceEnv,
  traceRequeries,
  traceRows,
  validateTracePlan,
} from "./trace-record.mjs";
import {
  TRACE_PROJECT,
  measureCdpNow,
  prepareFrozenTrace,
  setupFailureReceipt,
  startSealReceipt,
  traceSeedPinCheck,
} from "./trace-frozen.mjs";
import {
  hostSnapshot,
  readAncestorPids,
  startWindowSampler,
} from "./window.mjs";
import { readIndexMetadata, readQuerySceneSeedPins } from "./workspace-db.mjs";

export const TRACE_DEV_PREVIEW_PURPOSE = "trace-runner-preview";
/** A hang guard for a parent that never returns (not a K6/4 value). */
const PARENT_LIMIT_MS = 30_000;
/** The editor's first load (harness readiness, not a trace operation). */
const EDITOR_READY_MS = 30_000;
/**
 * After the last cycle end, the time the last child's mixing window needs to
 * fall inside the observation (W_f 100 ms + the commit margin; a harness
 * value, not a K6/4 value).
 */
const FINAL_SETTLE_MS = 300;
/** A hang guard for one evaluation entry call (E-14's bound). */
const ADDON_CALL_TIMEOUT_MS = 10_000;
const D2A_MODE = "restricted";

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

/**
 * The admission of a trace run: a dev fixture gets the dev preview
 * admission; a frozen trace takes the admission `admitGraphCaseRun` gave
 * (`prepareFrozenTrace`) and only when it allowed the G-02 fixture (S2
 * `project`, read back with the admitted digest).
 */
export function admitTraceRun(input) {
  const { fixture } = input;
  if (fixture?.kind === "frozen") {
    readAdmittedFixture(input.admission, {
      root: input.root,
      path: TRACE_PROJECT.fixturePath,
    });
    return input.admission;
  }
  if (fixture?.kind === "dev")
    return admitDevPreview({
      purpose: TRACE_DEV_PREVIEW_PURPOSE,
      fixture: fixture.loaded,
    });
  throw new Error("[precheck] a trace run names a frozen or a dev fixture");
}

/**
 * TR-10: the trace's measurement launch only (`launch`'s `start`): the S2
 * maintenance gate on top of the launch's own env. The steady-state runners
 * keep `startSession` as it is.
 */
export function traceMaintenanceStart(start, nonce) {
  return (args) =>
    start({
      ...args,
      extraEnv: traceMaintenanceEnv({ nonce, base: args.extraEnv ?? {} }),
    });
}

/**
 * レビュー P3 (d): S2 `stall` — attempts are numbered from 1 up to
 * `attemptLimit` (2) per trace file; a stall of the last allowed attempt goes
 * to [precheck] (the user decides), an earlier stall is retaken with the same
 * file, and every attempt is kept. The frozen path checks the history of the
 * earlier attempts' receipts (trace-frozen.mjs `traceAttemptHistory`).
 */
export function checkTraceAttempt({ attempt, attemptLimit }) {
  if (!Number.isInteger(attemptLimit) || attemptLimit < 1)
    throw new Error(
      "[precheck] the trace file's stall.attemptLimit is invalid",
    );
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > attemptLimit)
    throw new Error(
      `[precheck] --attempt must be an integer from 1 to ${attemptLimit} (S2 stall.attemptLimit)`,
    );
  return attempt;
}

/** What follows an attempt (S2 `stall.attemptRule`). */
export function traceAttemptOutcome({ attempt, attemptLimit, stalled }) {
  checkTraceAttempt({ attempt, attemptLimit });
  if (!stalled) return "completed";
  return attempt >= attemptLimit ? "precheck" : "retake";
}

/** TR-2: the Main poller of the owner counters (one session's Main). */
export function counterPoller({ app, nativePath }) {
  const run = async (source, arg) =>
    JSON.parse(await app.evaluate(source, arg));
  return {
    install: () =>
      run(COUNTER_POLL_SOURCE, [
        nativePath,
        COUNTER_POLL_INTERVAL_MS,
        [...TRACE_COUNTER_KEYS],
      ]),
    drain: () => run(COUNTER_POLL_DRAIN_SOURCE),
    stop: () => run(COUNTER_POLL_STOP_SOURCE),
  };
}

/**
 * Replays the plan's operations through `driver` (the page; `pageDriver`).
 * `runtime.scenes` maps the plan's logical Scene IDs to runtime IDs.
 * `readA3(parentSeq)` reads the A3 record of a counted query right after its
 * parent fetch was observed; `readNative()` reads the Native begin records at
 * each cycle end. Returns the operation log, the A3 reads, the start seal
 * reads and the stall (null when the trace ran to its end). Between an
 * autosave commit and its query the runner adds no operation and no wait
 * (K6/2 step 4 (2)→(3)): it reads the B seal once on its own read-only
 * connection (logged as `seal-read`; DR-CP4-TR-13) and waits only for the
 * page's observation of the product's query.
 */
export async function runTraceOperations({
  plan,
  runtime,
  driver,
  mountedAt,
  openSeal = null,
  readSeal = null,
  readA3,
  readNative,
  tShowMs,
  parentLimitMs,
}) {
  const bound = plan.stall.boundMs;
  const scene = (logical) => runtime.scenes?.[logical] ?? logical;
  const log = [];
  const a3Reads = {};
  // TR-9 / レビュー P2-1: the B seal of each counted query, by query index,
  // read twice: `before` (query 0's before the mount; the others after the
  // operation that starts the query — the autosave commit, the move — and
  // before the product's query) and `after` (right after the parent fetch was
  // observed, with the A3 record). The renderer time around each read lets
  // startSealOf place it against the parent fetch's call.
  const startSeals = {};
  const logSeal = (index, phase, record) => {
    startSeals[index] = { ...startSeals[index], [phase]: record };
    log.push({
      op: "seal-read",
      phase,
      index,
      at: record.startedAt,
      finishedAt: record.finishedAt,
      read: record.read,
    });
  };
  if (openSeal) logSeal(0, "before", openSeal);
  const sealFor = async (index, phase) => {
    if (!readSeal || !Number.isInteger(index)) return;
    const startedAt = await driver.now();
    const record = await readSeal();
    logSeal(index, phase, {
      ...record,
      startedAt,
      finishedAt: await driver.now(),
    });
  };
  const nextCounted = (operation) =>
    plan.operations.find(
      (row) => row.seq > operation.seq && row.query?.counted === true,
    )?.query.index;
  let lastSeq = 0;
  let sinceAt = mountedAt;
  let lastEditEnd = mountedAt;
  const stall = (operation, reason) => ({
    log,
    a3Reads,
    startSeals,
    stalled: { seq: operation.seq, op: operation.op, reason },
  });
  const counted = async (operation) => {
    const found = await driver.awaitCounted({
      sceneId: scene(operation.query.querySceneId),
      afterSeq: lastSeq,
      sinceAt,
      limitMs: bound,
    });
    if (!found.ok) return { stalled: found.stalled ?? "no-product-query" };
    lastSeq = Math.max(lastSeq, found.seq);
    // The A3 record at the query's start (its own read-only connection).
    a3Reads[found.seq] = await readA3(found.seq);
    await sealFor(operation.query.index, "after");
    const end = await driver.awaitCycleEnd({
      parentSeq: found.seq,
      tShowMs,
      limitMs: parentLimitMs,
    });
    const entry = {
      seq: operation.seq,
      // A counted query after a navigation is logged apart from the move.
      op: operation.op === "navigate" ? "navigate-query" : operation.op,
      index: operation.query.index,
      parentSeq: found.seq,
      calledAt: found.calledAt,
      seed: found.seed ?? null,
      cycleEnd: { reason: end.reason, at: end.at },
    };
    log.push(entry);
    lastSeq = Math.max(lastSeq, end.lastSeq ?? 0);
    await readNative();
    if (end.reason === "harness-limit")
      return { stalled: "parent-never-returned" };
    return { entry };
  };
  for (const operation of plan.operations) {
    if (operation.op === "open-scene" || operation.op === "product-query") {
      const result = await counted(operation);
      if (result.stalled) return stall(operation, result.stalled);
      continue;
    }
    if (operation.op === "edit") {
      const caret = await driver.caretToEnd();
      const typed =
        operation.action === "append-suffix"
          ? await driver.type(plan.editText.suffix)
          : await driver.backspace(plan.editText.suffix.length);
      lastEditEnd = typed.endedAt;
      log.push({
        seq: operation.seq,
        op: "edit",
        action: operation.action,
        caretAt: caret.at,
        startedAt: typed.startedAt,
        endedAt: typed.endedAt,
      });
      continue;
    }
    if (operation.op === "confirm-autosave-commit") {
      const commit = await driver.awaitBodyCommit({
        sceneId: scene(operation.sceneId),
        sinceAt: lastEditEnd,
        limitMs: bound,
      });
      if (!commit.ok)
        return stall(operation, commit.stalled ?? "no-autosave-commit");
      log.push({
        seq: operation.seq,
        op: operation.op,
        at: commit.at,
        contentVersion: commit.contentVersion,
      });
      sinceAt = commit.at;
      await sealFor(nextCounted(operation), "before");
      continue;
    }
    if (operation.op === "navigate") {
      const moved = await driver.navigate({
        sceneId: scene(operation.sceneId),
      });
      log.push({
        seq: operation.seq,
        op: "navigate",
        sceneId: scene(operation.sceneId),
        at: moved.at,
      });
      sinceAt = moved.at;
      if (operation.query?.counted) {
        await sealFor(operation.query.index, "before");
        const result = await counted(operation);
        if (result.stalled) return stall(operation, result.stalled);
        continue;
      }
      const shown = await driver.awaitPublished({
        sceneId: scene(operation.sceneId),
        sinceAt: moved.at,
        limitMs: bound,
      });
      if (!shown.ok)
        return stall(operation, shown.stalled ?? "no-query-published");
      log.at(-1).published = { seq: shown.seq, at: shown.at };
      lastSeq = Math.max(lastSeq, shown.seq);
      continue;
    }
    throw new Error(`[artifact] unknown trace operation ${operation.op}`);
  }
  return { log, a3Reads, startSeals, stalled: null };
}

/** The page side through Playwright (the keyboard goes to the product editor). */
export function pageDriver(page) {
  const trace = (name, input) =>
    page.evaluate(
      ([method, value]) => window.cp4Harness.trace[method](value),
      [name, input ?? null],
    );
  const now = () => trace("now");
  return {
    now,
    caretToEnd: async () => {
      const focused = await trace("focusEditor");
      if (!focused?.ok)
        throw new Error(`[artifact] the product editor: ${focused?.error}`);
      await page.keyboard.press("Control+End");
      return { at: focused.at };
    },
    type: async (text) => {
      const startedAt = await now();
      await page.keyboard.type(text);
      return { startedAt, endedAt: await now() };
    },
    backspace: async (count) => {
      const startedAt = await now();
      for (let at = 0; at < count; at++) await page.keyboard.press("Backspace");
      return { startedAt, endedAt: await now() };
    },
    awaitBodyCommit: (input) => trace("awaitBodyCommit", input),
    awaitCounted: (input) => trace("awaitCounted", input),
    awaitCycleEnd: (input) => trace("awaitCycleEnd", input),
    navigate: (input) => trace("navigate", input),
    awaitPublished: (input) => trace("awaitPublished", input),
  };
}

const TRACE_HARNESS_FILES = Object.freeze([
  "scripts/quality/nir1-graph-eval/trace-runner.mjs",
  "scripts/quality/nir1-graph-eval/trace-record.mjs",
  "scripts/quality/nir1-graph-eval/trace-seal.mjs",
  "scripts/quality/nir1-graph-eval/trace-frozen.mjs",
  "scripts/quality/nir1-graph-eval/frozen-diagnostics.mjs",
  "scripts/quality/nir1-graph-eval/workspace-db.mjs",
  "scripts/quality/nir1-graph-eval/build-receipt-check.mjs",
  "scripts/quality/nir1-graph-eval/renderer/cp4-trace-probe.tsx",
]);

const BODY_NONCE_ENV = "GRIMODEX_BODY_DECLARATION_CI_NONCE";
const BODY_SEAM_RECEIPT_ROOT = ".grimodex-body-declaration-ci-receipts";

/**
 * The launch's `start` with the K2/4 body declaration nonce of the launch
 * env kept in `sink` (the declaration step reads its seam receipt with it).
 */
export function captureBodyNonce(start, sink) {
  return (args) => {
    sink.nonce = args?.extraEnv?.[BODY_NONCE_ENV] ?? null;
    return start(args);
  };
}

const stripSha = (value) =>
  typeof value === "string" ? value.replace(/^sha256:/u, "") : value;
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

async function readSeamReceipt(userData, nonce) {
  if (!nonce) return null;
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

const captureBinding = (page, workspacePath) =>
  page.evaluate(
    ([name, input]) => window.cp4Harness.call(name, input),
    [
      "narrative_extraction_capture_workspace_binding",
      { expectedWorkspacePath: workspacePath },
    ],
  );

/**
 * K2/4 declaration step of the trace (S2 `project.setup`, declarationPlace
 * (ii)): on the measurement workspace, after the Index build and before the
 * mount (the trace's first seeded query). The Index metadata before and
 * after, the seam receipt and the token are recorded; a refused declaration
 * is `[precheck]` (never blocked).
 */
export async function runTraceDeclaration({
  page,
  workspacePath,
  projectId,
  sceneId,
  readIndex,
  readSeam,
  locatorDigest,
}) {
  const scene = { workspacePath, projectId, sceneId };
  const capture = await captureBinding(page, workspacePath);
  if (!capture?.ok)
    throw new Error(
      `[artifact] the workspace binding capture failed: ${capture?.error}`,
    );
  const indexBefore = indexPair(readIndex());
  const result = await page.evaluate(
    (input) => window.cp4Harness.declaration.declare(input),
    scene,
  );
  const indexAfter = indexPair(readIndex());
  const stateAfter = await page.evaluate(
    (input) => window.cp4Harness.declaration.state(input),
    scene,
  );
  const seam = await readSeam();
  const bindingDigest = stripSha(
    seam?.value?.approvedBindingDigests?.at(-1) ?? null,
  );
  const declaration = {
    sceneId,
    result,
    workspaceId: capture.value?.authorityId ?? null,
    canonicalLocatorDigest: locatorDigest,
    token: stateAfter?.ok ? stateAfter.snapshot.declarationToken : null,
    bindingDigest,
    seamReceipt: seam
      ? {
          version: String(seam.value.version),
          envNames: Object.values(seam.value.envNames ?? {}),
          nonceDigest: stripSha(seam.value.nonceDigest),
          approvedGrantCount: seam.value.approvedGrantCount,
          bindingDigest,
          receiptSha256: seam.sha256,
        }
      : null,
    indexBefore,
    indexAfter,
    stateAfter,
    verified: false,
  };
  if (!result?.ok) {
    const error = new Error(
      `[precheck] the K2/4 declaration of ${sceneId} was refused before the trace`,
    );
    error.declaration = declaration;
    throw error;
  }
  return declaration;
}

/**
 * Right before the mount: the declaration is still effective with the same
 * token on the same workspace authority and locator, and the Index metadata
 * did not change across the step (`assertDeclarationCurrent`, `[precheck]`).
 */
export async function confirmTraceDeclaration({
  page,
  declaration,
  workspacePath,
  projectId,
  locatorDigest,
}) {
  const scene = { workspacePath, projectId, sceneId: declaration.sceneId };
  const stateNow = await page.evaluate(
    (input) => window.cp4Harness.declaration.state(input),
    scene,
  );
  const captureNow = await captureBinding(page, workspacePath);
  const effective =
    stateNow?.ok === true &&
    stateNow.snapshot?.state?.kind === "declared" &&
    stateNow.snapshot.state.effective === true &&
    stateNow.snapshot.declarationToken === declaration.token;
  const measurementWorkspace = {
    workspaceId: captureNow?.value?.authorityId ?? null,
    canonicalLocatorDigest: locatorDigest,
    bindingDigest: effective ? declaration.bindingDigest : null,
    state: stateNow,
  };
  assertDeclarationCurrent({ declaration, measurementWorkspace });
  return { ...declaration, verified: true, measurementWorkspace };
}

/**
 * S2 `setupFailure`: when the G-02 base setup never reached setup-complete,
 * the trace's receipt says (b) unmeasured and HOLD, bound to the head written
 * before; nothing is launched. Returns the receipt, or null when the setup
 * is complete (the trace runs).
 */
export async function recordTraceSetupFailure({
  runDir,
  runId,
  prepared,
  candidate,
}) {
  if (!prepared.setupFailure) return null;
  const receipt = setupFailureReceipt({
    runId,
    kind: prepared.kind,
    prepared,
    candidate,
  });
  readRunHead({ runDir, sha256: prepared.headSha256 });
  await writeFile(
    path.join(runDir, "receipt.json"),
    `${JSON.stringify(receipt, null, 2)}\n`,
  );
  await writeSha256Sums(runDir, ["receipt.json", "head.json"]);
  return receipt;
}

/**
 * Review P3: the frozen trace's start — a setup failure records its receipt
 * and gives no context (nothing launches); otherwise the context. The context
 * builder refuses a setup failure too, so a skipped branch fails closed.
 */
export async function startFrozenTrace({
  runDir,
  runId,
  prepared,
  candidate,
  makeContext,
}) {
  const receipt = await recordTraceSetupFailure({
    runDir,
    runId,
    prepared,
    candidate,
  });
  if (receipt) return { receipt, context: null };
  return { receipt: null, context: makeContext() };
}

function parseArgs(argv) {
  const options = {
    "eval-build": path.join(ROOT, ".artifacts/cp4/eval-build"),
    "procedure-version": DEV_DRAFT_PROCEDURE_VERSION,
    "procedure-commit": "HEAD",
    cycles: "3",
    attempt: "1",
  };
  const given = new Set();
  for (let at = 0; at < argv.length; at += 2) {
    if (!argv[at].startsWith("--") || argv[at + 1] === undefined)
      throw new Error("use --name value arguments");
    options[argv[at].slice(2)] = argv[at + 1];
    given.add(argv[at].slice(2));
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(options.run ?? ""))
    throw new Error("--run <name> is required");
  for (const name of ["ja-model", "en-model", "k62-commit", "setup"])
    if (!options[name]) throw new Error(`--${name} is required`);
  options.given = given;
  return options;
}

function git(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
}

/** The frozen admission's inputs: the build receipts and the default addon. */
function frozenInputs(options, evalDir) {
  if (!options["product-receipt"])
    throw new Error(
      "[precheck] a frozen trace needs the product standard-build receipt (--product-receipt)",
    );
  const read = (file, label) => {
    try {
      return JSON.parse(readFileSync(file, "utf8"));
    } catch {
      throw new Error(`[precheck] the ${label} cannot be read (${file})`);
    }
  };
  return {
    buildReceipt: read(
      path.join(evalDir, "eval-build.json"),
      "eval build receipt",
    ),
    productReceipt: read(
      path.resolve(options["product-receipt"]),
      "product standard-build receipt",
    ),
    defaultAddonSha256: sha256(readFileSync(path.join(ROOT, DEFAULT_ADDON))),
  };
}

/**
 * The dev preview's context (as before S5-B): the dev setup, the dev plan,
 * the dev procedure, the head (K6/2 and the start time).
 */
function devContext({ options, setupPath, setup }) {
  if (setup.status !== "setup-complete")
    throw new Error("[precheck] the setup receipt is not setup-complete");
  for (const name of [
    "prep-commit",
    "k64-commit",
    "previous-attempts",
    "sp-p4-receipt",
  ])
    if (options.given.has(name))
      throw new Error(
        `[precheck] --${name} is a frozen trace's option; this setup receipt is a dev one`,
      );
  const loaded = loadDevFixture({
    root: ROOT,
    fixturePath: setup.fixture.path,
  });
  if (loaded.sha256 !== setup.fixture.sha256)
    throw new Error("[precheck] the dev fixture changed since its setup");
  const admission = admitTraceRun({
    root: ROOT,
    fixture: { kind: "dev", loaded },
  });
  const ids = setup.logicalToRuntime;
  const fixture = loaded.fixture;
  const pinned = new Set(fixture.pins.map((row) => row.sceneId));
  const otherScene = fixture.scenes.find(
    (row) => row.id !== fixture.query.sceneId && !pinned.has(row.id),
  )?.id;
  const kind = options["trace-kind"];
  const plan = devTracePlan({
    kind,
    cycles: Number(options.cycles),
    querySceneId: fixture.query.sceneId,
    otherSceneId: otherScene,
    seedEntityId: fixture.graphSeedEntityId,
    materials: fixture.typedRevisions.map((row) => row.id),
  });
  checkTraceAttempt({
    attempt: Number(options.attempt),
    attemptLimit: plan.stall.attemptLimit,
  });
  const planErrors = validateTracePlan(plan, { preview: true });
  if (planErrors.length > 0)
    throw new Error(`[precheck] the dev trace plan: ${planErrors.join("; ")}`);
  const procedure = loadProcedureFile({
    root: ROOT,
    version: options["procedure-version"],
    commit: options["procedure-commit"],
    purpose: "dev-preview",
  });
  const revisions = Object.fromEntries(
    Object.entries(ids.typedRevisions).map(([logical, row]) => [
      logical,
      row.revisionId,
    ]),
  );
  return {
    frozen: false,
    admission,
    loaded,
    kind,
    plan,
    procedure,
    ids,
    seed: ids.entities[fixture.graphSeedEntityId],
    revisions,
    materials: plan.expectedMaterials.map(
      (row) => ids.typedRevisions[row.revisionId].revisionId,
    ),
    expectedContribution: devExpectedContribution(loaded, "base", ids),
    ratification5: collectRatification5Evidence({
      root: ROOT,
      candidateHead: "HEAD",
    }),
    // The dev preview declares only when asked (`--declare 1`) and the dev
    // fixture declares a Scene (the real-machine check of the step).
    declarationSceneId:
      options.declare === "1"
        ? (fixture.declarations?.[0]?.sceneId ?? null)
        : null,
    attempts: [],
    identity: {
      traceId: plan.traceId,
      kind,
      plannedQ: plan.plannedQ,
      planSha256: sha256(Buffer.from(JSON.stringify(plan))),
      source: "devTracePlan (S2 shape; not a fixed trace)",
    },
    fixtureRecord: { path: loaded.path, sha256: loaded.sha256, kind: "dev" },
    r5: ({ dbPath }) =>
      assertSeedPinsBeforeK64({
        cases: [
          {
            caseId: `dev:${loaded.path}`,
            setup: loadSetupReceipt({ root: ROOT, file: setupPath }),
            read: readQuerySceneSeedPins(
              dbPath,
              ids.projectId,
              ids.querySceneId,
            ),
            querySceneLogical: fixture.query.sceneId,
            expectedSeedLogical: fixture.graphSeedEntityId,
          },
        ],
        plan: "dev",
      }),
    devSeedPin: true,
    rawLabelBody: fixture.query.body,
  };
}

/** The frozen trace's context from `prepareFrozenTrace` (DR-CP4-O-1 (6)). */
export function frozenContext({ prepared, setupRaw }) {
  if (prepared?.setupFailure)
    throw new Error(
      "[precheck] the G-02 base setup failed; the trace does not launch (S2 setupFailure)",
    );
  const admission = admitTraceRun({
    root: ROOT,
    fixture: { kind: "frozen" },
    admission: prepared.admission,
  });
  const fixture = JSON.parse(
    readAdmittedFixture(admission, {
      root: ROOT,
      path: TRACE_PROJECT.fixturePath,
    }).toString("utf8"),
  );
  const { ids } = prepared.runtime;
  return {
    frozen: true,
    admission,
    kind: prepared.kind,
    plan: prepared.plan,
    procedure: prepared.procedure,
    ids,
    seed: prepared.runtime.seed,
    revisions: prepared.runtime.revisions,
    materials: prepared.runtime.materials,
    expectedContribution: devExpectedContribution(
      { fixture },
      TRACE_PROJECT.variantId,
      ids,
    ),
    ratification5: prepared.admission.ratification5,
    declarationSceneId: prepared.declaration.sceneId,
    spP4: prepared.spP4,
    declarationAddendum: prepared.declaration.addendum,
    attempts: prepared.attempts,
    identity: prepared.identity,
    fixtureRecord: {
      path: setupRaw.fixture.path,
      sha256: setupRaw.fixture.sha256,
      kind: "frozen",
    },
    r5: ({ dbPath }) =>
      traceSeedPinCheck({
        plan: prepared.plan,
        setupRaw,
        read: readQuerySceneSeedPins(dbPath, ids.projectId, ids.querySceneId),
      }),
    devSeedPin: false,
    rawLabelBody: fixture.query.body,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const runDir = path.join(ROOT, ".artifacts/cp4", options.run);
  await mkdir(runDir, { recursive: false });
  const report = {
    schema: "nir1-cp4-trace-run-report/1",
    run: options.run,
    attempt: Number(options.attempt),
    problems: [],
    sessions: {},
    checks: {},
  };
  let server = null;
  let session = null;
  let windowSampler = null;
  let poller = null;
  let receiptWritten = false;
  const stopSession = async (label, value) => {
    if (!value) return null;
    const evidence = await value.stop();
    await writeFile(
      path.join(runDir, `${label}-main-stderr.log`),
      value.stderr(),
    );
    report.sessions[label] = {
      problems: evidence.problems,
      stop: evidence.stop ?? null,
    };
    report.problems.push(...evidence.problems.map((row) => `${label}: ${row}`));
    return evidence;
  };
  let partial = null;
  // DR-CP4-O-16: the frozen attempt's ledger row (A's ledger), closed below.
  let ledgerFile = null;
  // Review P2-α: a refusal before the launch closes the row "not-started"
  // (it does not use the attempt); after the launch "stopped".
  let ledgerStatus = "not-started";
  try {
    const setupPath = path.resolve(options.setup);
    let setupRaw;
    try {
      setupRaw = JSON.parse(await readFile(setupPath));
    } catch {
      throw new Error(
        `[precheck] the setup receipt ${setupPath} cannot be read`,
      );
    }
    const frozen = setupRaw.schemaVersion === FROZEN_SETUP_RECEIPT_SCHEMA;
    const evalDir = path.resolve(options["eval-build"]);
    const nativePath = realpathSync(path.join(evalDir, "grimodex-node.node"));
    const candidate = candidateBlock({
      options,
      nativePath,
      workerPath: path.join(evalDir, "nir1-c-query-worker"),
    });
    for (const file of TRACE_HARNESS_FILES)
      candidate.harnessFiles[file] = sha256(
        readFileSync(path.join(ROOT, file)),
      );
    let context;
    let head;
    let headSha256;
    if (frozen) {
      // K6/4 head → setup → admission → head.json → plan (trace-frozen.mjs).
      const prepared = await prepareFrozenTrace({
        root: ROOT,
        runDir,
        options,
        inputs: frozenInputs(options, evalDir),
      });
      head = prepared.head;
      headSha256 = prepared.headSha256;
      ledgerFile = prepared.ledger?.file ?? null;
      // S2 setupFailure: (b) unmeasured, HOLD, no launch (review P3).
      const started = await startFrozenTrace({
        runDir,
        runId: options.run,
        prepared,
        candidate: { ...candidate, commit: git(["rev-parse", "HEAD"]) },
        makeContext: () => frozenContext({ prepared, setupRaw }),
      });
      receiptWritten = started.receipt !== null;
      if (started.receipt) {
        ledgerStatus = "unmeasured";
        process.stdout.write(
          `${JSON.stringify({ run: options.run, status: started.receipt.status, cp4Availability: started.receipt.cp4Availability, setupFailure: started.receipt.setupFailure.blocked })}\n`,
        );
        return;
      }
      context = started.context;
    } else {
      context = devContext({ options, setupPath, setup: setupRaw });
      head = {
        kind: "trace-preview",
        k62: readK62FreezeHead({ root: ROOT, commit: options["k62-commit"] }),
        runStartedAtUtc: new Date().toISOString(),
      };
      headSha256 = (await writeRunHead({ runDir, head })).sha256;
    }
    const { admission, plan, procedure, ids, kind } = context;
    // DR-CP4-TR-5: the receipts name this candidate (before any launch).
    report.checks.productBuild = checkRunnerBuildReceipts({
      root: ROOT,
      options,
      candidate,
      evalDir,
      // レビュー P3 (c): a frozen run needs the standard-build receipt.
      required: frozen,
    });
    const coldDb = path.resolve(ROOT, setupRaw.coldDatabase.path);
    if (sha256(await readFile(coldDb)) !== setupRaw.coldDatabase.sha256)
      throw new Error("[precheck] the sealed setup DB changed");
    const workspacePath = path.join(runDir, "measure", "workspace");
    await mkdir(workspacePath, { recursive: true });
    const dbPath = path.join(workspacePath, "grimodex.db");
    await copyFile(coldDb, dbPath);
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
    // TR-4: the alias (from, to, importers, the stub's sha256) and the bundle.
    report.checks.rendererBuild = {
      alias: rendererBuild.alias,
      timingShim: rendererBuild.timingShim,
      fetchTiming: rendererBuild.fetchTiming,
      rendererBundleSha256: rendererBuild.rendererBundleSha256,
    };
    server = await startStaticServer({
      dir: path.join(runDir, "renderer-dist"),
    });
    const observer = await bundleObserver({
      outDir: path.join(runDir, "observer"),
    });
    candidate.harnessFiles["observer.cjs"] = observer.sha256;
    const launchOptions = { ...options };

    // prep (as k64-runner): the Raw vectors and the Chronicle Index on the
    // measurement copy; the dev preview also writes its seed pin here
    // (DR-CP4-S1C2-26). A frozen setup holds its seed pin already (SP/1).
    if (ledgerFile) ledgerStatus = "stopped";
    session = await launch({
      label: "prep",
      runDir,
      server,
      observer,
      options: launchOptions,
      admission,
    });
    await openWorkspace(session.page, workspacePath, ids);
    if (context.devSeedPin)
      report.checks.devSeedPin = await session.page.evaluate(
        (value) => window.cp4Harness.api.upsertScenePin(value),
        { sceneId: ids.querySceneId, entryId: context.seed },
      );
    const raw = await session.page.evaluate(
      (input) => window.cp4Harness.buildRaw(input),
      {
        projectId: ids.projectId,
        label: `cp4-${options.run}`,
        sceneIds: Object.values(ids.scenes),
        queryBody: context.rawLabelBody,
      },
    );
    if (!raw.ok || !raw.value.ok)
      throw new Error(
        `[artifact] the Raw index build failed: ${JSON.stringify(raw.ok ? { status: raw.value.status, unsearchable: raw.value.unsearchable } : raw.error).slice(0, 600)}`,
      );
    report.checks.prepIndex = await buildIndex(session.page, ids);
    await stopSession("prep", session);
    session = null;

    // R5 on this workspace: the query Scene's only pin is the expected seed.
    report.checks.seedPins = context.r5({ dbPath });

    // The measurement session: one trace.
    // TR-10: S2's maintenance gate, on the trace's measurement launch only.
    const maintenanceNonce = randomUUID();
    report.checks.maintenanceSeam = {
      envNames: [
        "CI",
        TRACE_MAINTENANCE_SEAM.ownerTokenEnv,
        TRACE_MAINTENANCE_SEAM.nonceEnv,
        TRACE_MAINTENANCE_SEAM.triggerEnv,
      ],
      trigger: TRACE_MAINTENANCE_SEAM.trigger,
      nonceSha256: sha256(Buffer.from(maintenanceNonce)),
    };
    const bodySeam = { nonce: null };
    session = await launch({
      label: "measure",
      runDir,
      server,
      observer,
      options: launchOptions,
      admission,
      start: traceMaintenanceStart(
        captureBodyNonce(startSession, bodySeam),
        maintenanceNonce,
      ),
    });
    const page = session.page;
    const addon = session.addon;
    const launcherChain = readAncestorPids();
    const measuring = session;
    windowSampler = startWindowSampler({
      root: ROOT,
      ownPids: () => [...launcherChain, ...measuring.pids()],
    });
    await openWorkspace(page, workspacePath, ids);
    const prepared = await page.evaluate(
      (input) => window.cp4Harness.hook.prepare(input),
      { workspacePath },
    );
    if (!prepared?.ok) throw new Error("[artifact] hook prepare failed");
    const instrumented = await page.evaluate(() =>
      window.cp4Harness.k64.instrumented(),
    );
    if (instrumented?.fetchTiming !== true)
      throw new Error("[precheck] the fetch timing shim is not in the page");
    report.checks.measureIndex = await buildIndex(page, ids);
    // K2/4 declaration step (S2 project.setup, D1 (ii)): after the Index
    // build, before the mount (the trace's first seeded query).
    let declaration = null;
    const locatorDigest = sha256(Buffer.from(realpathSync(workspacePath)));
    if (context.declarationSceneId) {
      const sceneId = ids.scenes[context.declarationSceneId];
      declaration = await runTraceDeclaration({
        page,
        workspacePath,
        projectId: ids.projectId,
        sceneId,
        readIndex: () => readIndexMetadata(dbPath, ids.projectId),
        readSeam: () => readSeamReceipt(session.userData, bodySeam.nonce),
        locatorDigest,
      });
      declaration.logicalSceneId = context.declarationSceneId;
    }
    poller = counterPoller({ app: session.app, nativePath });
    report.checks.counterPoll = { install: await poller.install() };
    report.checks.clearSamples = await call(addon, "nir1GraphEvalClearSamples");
    const nativeReads = [];
    // S2 startSeal.receipt: the CDP now() round trip, disclosed.
    const cdpNowMs = await measureCdpNow(() =>
      page.evaluate(() => window.cp4Harness.trace.now()),
    );
    // TR-9: query 0's start seal, read before the mount (the hook's first
    // query follows the mount).
    const readSeal = async () => readStartSeal(dbPath, ids.projectId);
    const openSealStartedAt = await page.evaluate(() =>
      window.cp4Harness.trace.now(),
    );
    const openSealRecord = await readSeal();
    const openSeal = {
      ...openSealRecord,
      startedAt: openSealStartedAt,
      finishedAt: await page.evaluate(() => window.cp4Harness.trace.now()),
    };
    if (declaration)
      declaration = await confirmTraceDeclaration({
        page,
        declaration,
        workspacePath,
        projectId: ids.projectId,
        locatorDigest,
      });
    const mountedAt = (
      await page.evaluate((input) => window.cp4Harness.trace.mount(input), {
        projectId: ids.projectId,
        sceneId: ids.querySceneId,
        workspacePath,
      })
    ).mountedAt;
    const editor = await page.evaluate(
      (input) => window.cp4Harness.trace.awaitEditor(input),
      { limitMs: EDITOR_READY_MS },
    );
    report.checks.editor = editor;
    if (!editor.ok)
      throw new Error("[artifact] the product editor never became editable");
    const runStartedAtMs = Date.now();
    const started = performance.now();
    const result = await runTraceOperations({
      plan,
      runtime: { scenes: ids.scenes },
      driver: pageDriver(page),
      mountedAt,
      openSeal,
      readSeal,
      readA3: () =>
        call(
          addon,
          "nir1GraphEvalReadA3",
          dbPath,
          ids.projectId,
          ids.querySceneId,
          context.materials,
        ),
      readNative: async () =>
        nativeReads.push(await call(addon, "nir1GraphEvalSamples")),
      tShowMs: procedure.values.tShowMs,
      parentLimitMs: PARENT_LIMIT_MS,
    });
    partial = result;
    report.trace = { stalled: result.stalled, operations: result.log.length };
    if (kind === "editing")
      report.checks.editorText = await page.evaluate(() =>
        window.cp4Harness.trace.editorText(),
      );
    await delay(FINAL_SETTLE_MS);
    const observation = await page.evaluate(() =>
      window.cp4Harness.trace.exportObservation(),
    );
    nativeReads.push(await call(addon, "nir1GraphEvalSamples"));
    report.checks.counterPoll.stop = await poller.stop();
    const counters = await poller.drain();
    poller = null;
    await page.evaluate(() => window.cp4Harness.trace.unmount());
    const run = {
      startedAtMs: runStartedAtMs,
      finishedAtMs: Date.now(),
      traceMs: performance.now() - started,
    };
    const windowSamples = windowSampler.stop();
    windowSampler = null;
    const evidence = await stopSession("measure", session);
    session = null;
    await server.close();
    server = null;
    await writeFile(
      path.join(runDir, "observation.json"),
      `${JSON.stringify({ observation, nativeReads, counters, log: result.log, a3Reads: result.a3Reads, startSeals: result.startSeals }, null, 1)}\n`,
    );
    const native = mergeNativeRecords(nativeReads);
    const rows = traceRows({
      plan,
      observation,
      log: result.log,
      native,
      runs: counters.runs ?? [],
      a3Reads: result.a3Reads,
      startSeals: result.startSeals,
      d2aMode: D2A_MODE,
      ids: { revisions: context.revisions },
      expectedContribution: context.expectedContribution,
    });
    const parentSeqs = result.log
      .filter((row) => Number.isInteger(row.parentSeq))
      .map((row) => row.parentSeq);
    const events = traceEvents({
      plan,
      observation,
      log: result.log,
      parentSeqs,
      querySceneId: ids.querySceneId,
    });
    const k64 = summarizeTraceRun({
      plan,
      rows,
      events,
      fixedGraphMode: D2A_MODE,
      stalled: result.stalled,
      candidate: context.ratification5,
      candidateHead: candidate.commit,
    });
    const k62 = summarizeTraceRun({
      plan,
      rows,
      events,
      fixedGraphMode: D2A_MODE,
      stalled: result.stalled,
    });
    const ownPids = [
      ...readAncestorPids(),
      ...(evidence.recordedPids ?? []).map((row) => row.pid),
    ];
    // K6/2 事前登録の凍結 2: the head written before the launch is unchanged.
    readRunHead({ runDir, sha256: headSha256 });
    const receipt = {
      schemaVersion: TRACE_RUN_SCHEMA,
      runKind: frozen ? "trace" : "trace-preview",
      preview: !frozen,
      ...(frozen
        ? {}
        : {
            previewNote:
              "TR dev trace preview: seen by the integrator only; never a CP-4 result, never aggregated, never used to choose a threshold, a bound or a trace",
          }),
      runId: options.run,
      attempt: Number(options.attempt),
      // S2 stall.attemptRule: every earlier attempt of this file, disclosed.
      attempts: context.attempts,
      // S2 r5Gate.beforeFirstGatedRun: ④'s SP-P4, read back (frozen only).
      spP4: context.spP4
        ? {
            status: context.spP4.summary.status,
            receiptSha256: context.spP4.receiptSha256,
          }
        : null,
      fixture: context.fixtureRecord,
      trace: context.identity,
      head,
      headSha256,
      candidate: {
        ...candidate,
        commit: git(["rev-parse", "HEAD"]),
        ratification5: JSON.parse(JSON.stringify(context.ratification5)),
      },
      settings: {
        d2aMode: D2A_MODE,
        maintenance: "product",
        counterPollIntervalMs: COUNTER_POLL_INTERVAL_MS,
        stallBoundMs: plan.stall.boundMs,
        parentLimitMs: PARENT_LIMIT_MS,
        finalSettleMs: FINAL_SETTLE_MS,
        k64: procedureSettings(procedure),
        a3: "read once right after the counted query's parent fetch was observed",
        startSeal:
          "B seal read read-only (busy timeout 0) twice: before the parent's begin (after the autosave commit / the move; query 0 before the mount) and right after the parent was observed; current only when both agree (DR-CP4-TR-9, TR-13)",
        requeries: "counted apart (K6/2 step 7); never rows",
      },
      declaration: declaration
        ? {
            ...declaration,
            addendum: context.declarationAddendum ?? null,
          }
        : null,
      environment: {
        hostSnapshot: hostSnapshot(),
        windowAssessment: assessMeasurementWindow({
          samples: windowSamples,
          run,
          ownPids,
        }),
        removedEnv: evidence.launch?.removedEnv ?? null,
        netns: evidence.launch?.netns ?? null,
        netLog: evidence.netLog ?? null,
        observer: evidence.observerCheck ?? null,
        stop: evidence.stop ?? null,
      },
      run,
      stalled: result.stalled,
      // レビュー P2-2: explicit; a stall or a defect is never valid.
      status: k64.status,
      statusReasons: k64.statusReasons,
      attemptOutcome: traceAttemptOutcome({
        attempt: Number(options.attempt),
        attemptLimit: plan.stall.attemptLimit,
        stalled: result.stalled,
      }),
      counterPoll: {
        polls: counters.polls ?? null,
        errors: counters.errors ?? null,
        lastError: counters.lastError ?? null,
        runs: counters.runs?.length ?? null,
      },
      native: { dropped: native.dropped, records: native.records.length },
      requeries: traceRequeries({
        observation,
        parentSeqs,
        querySceneId: ids.querySceneId,
      }).counts,
      // S2 navigate.outsideQ.receiptCountByReason (P-S2-4).
      outsideQ: outsideQReceiptCountByReason({
        observation,
        parentSeqs,
        querySceneId: ids.querySceneId,
      }),
      // TR-9: unknown is counted apart (the classifier keeps it out of U and
      // in rule 3 (i), the strict side). S2 startSeal.receipt: the reads.
      startSeal: {
        ...startSealCounts(rows),
        receipt: startSealReceipt({ log: result.log, cdpNowMs }),
      },
      events: k64.events,
      defects: k64.defects,
      queries: rows,
      summary: { k64: k64.summary, k62: k62.summary },
      checks: { ...report.checks, problems: report.problems },
    };
    await writeFile(
      path.join(runDir, "receipt.json"),
      `${JSON.stringify(receipt, null, 2)}\n`,
    );
    await writeSha256Sums(runDir, [
      "receipt.json",
      "observation.json",
      "head.json",
    ]);
    receiptWritten = true;
    ledgerStatus = result.stalled ? "stalled" : "completed";
    if (result.stalled || report.problems.length > 0) process.exitCode = 1;
    process.stdout.write(
      `${JSON.stringify(
        {
          run: options.run,
          frozen,
          stalled: result.stalled,
          counted: rows.length,
          defects: k64.defects,
          declaration: declaration
            ? { verified: declaration.verified, sceneId: declaration.sceneId }
            : null,
          outsideQ: receipt.outsideQ,
          startSealReads: receipt.startSeal.receipt.total,
          k64: {
            status: k64.summary.status,
            invalid: k64.summary.invalid?.slice(0, 5) ?? [],
          },
          k62: {
            status: k62.summary.status,
            invalid: k62.summary.invalid?.slice(0, 5) ?? [],
          },
          problems: report.problems.map((row) => row.split("\n")[0]),
        },
        null,
        1,
      )}\n`,
    );
  } catch (error) {
    report.problems.push(error?.stack ?? String(error));
    if (error?.declaration) report.declaration = error.declaration;
    process.exitCode = 1;
    if (error?.launchedSession)
      await stopSession(error.launchLabel, error.launchedSession).catch(
        (stopError) =>
          report.problems.push(`stop: ${stopError?.stack ?? stopError}`),
      );
  } finally {
    windowSampler?.stop();
    if (poller)
      await poller.stop().catch(() => report.problems.push("poller stop"));
    if (session)
      await stopSession("session", session).catch((error) =>
        report.problems.push(`stop: ${error?.stack ?? error}`),
      );
    await server?.close();
    if (ledgerFile) finishAttempt({ file: ledgerFile, status: ledgerStatus });
  }
  if (report.problems.length > 0) process.exitCode = 1;
  await writeFile(
    path.join(runDir, "run-report.json"),
    `${JSON.stringify({ ...report, partialLog: receiptWritten ? null : (partial?.log ?? null) }, null, 2)}\n`,
  );
  if (!receiptWritten)
    process.stdout.write(
      `${JSON.stringify({ run: options.run, stopped: true, problems: report.problems.map((row) => row.split("\n").slice(0, 3).join(" | ")) })}\n`,
    );
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename)
  await main();
