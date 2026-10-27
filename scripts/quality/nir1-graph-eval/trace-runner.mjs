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
// Only a dev fixture runs here (a dev preview: seen by the integrator only,
// never a CP-4 result). A frozen trace (S2's files) is S6's: it stops with
// [precheck] until the frozen setup and the trace file are wired after the
// K6/4 freeze (see cp4-decisions.md TR).

import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";
import { setTimeout as delay } from "node:timers/promises";
import {
  admitDevPreview,
  collectRatification5Evidence,
  readK62FreezeHead,
  readK64FreezeHead,
} from "./admission.mjs";
import { checkRunnerBuildReceipts } from "./build-receipt-check.mjs";
import { loadDevFixture } from "./dev-fixture.mjs";
import { buildIndex, launch, openWorkspace } from "./dprime-check.mjs";
import { candidateBlock, devExpectedContribution } from "./k64-runner.mjs";
import { ROOT, bundleObserver } from "./launcher.mjs";
import {
  DEV_DRAFT_PROCEDURE_VERSION,
  loadProcedureFile,
  procedureSettings,
} from "./procedure-file.mjs";
import { assessMeasurementWindow, writeSha256Sums } from "./receipt.mjs";
import { buildHarnessRenderer, startStaticServer } from "./renderer-build.mjs";
import { assertSeedPinsBeforeK64 } from "./seed-pin.mjs";
import { loadSetupReceipt } from "./setup-receipt.mjs";
import { HARNESS_PAGE, sha256 } from "./session.mjs";
import {
  COUNTER_POLL_DRAIN_SOURCE,
  COUNTER_POLL_INTERVAL_MS,
  COUNTER_POLL_SOURCE,
  COUNTER_POLL_STOP_SOURCE,
  TRACE_COUNTER_KEYS,
  TRACE_RUN_SCHEMA,
  devTracePlan,
  mergeNativeRecords,
  summarizeTraceRun,
  traceEvents,
  traceRequeries,
  traceRows,
  validateTracePlan,
} from "./trace-record.mjs";
import {
  hostSnapshot,
  readAncestorPids,
  startWindowSampler,
} from "./window.mjs";
import { readQuerySceneSeedPins } from "./workspace-db.mjs";

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
 * The admission of a trace run: a dev fixture gets the dev preview admission.
 * A frozen trace stops with [precheck] (S6 wires the frozen setup and the
 * trace file after the K6/4 freeze).
 */
export function admitTraceRun(input) {
  const { fixture } = input;
  if (fixture?.kind === "frozen")
    throw new Error(
      "[precheck] TR: a frozen trace (S2's trace files on the frozen G-case setup) is run by S6 after the K6/4 freeze; this runner measures the dev preview only",
    );
  if (fixture?.kind === "dev")
    return admitDevPreview({
      purpose: TRACE_DEV_PREVIEW_PURPOSE,
      fixture: fixture.loaded,
    });
  throw new Error("[precheck] a trace run names a frozen or a dev fixture");
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
 * each cycle end. Returns the operation log, the A3 reads and the stall (null
 * when the trace ran to its end). Between an autosave commit and its query
 * the runner only waits for the page's observation (K6/2 step 4 (2)→(3)).
 */
export async function runTraceOperations({
  plan,
  runtime,
  driver,
  mountedAt,
  readA3,
  readNative,
  tShowMs,
  parentLimitMs,
}) {
  const bound = plan.stall.boundMs;
  const scene = (logical) => runtime.scenes?.[logical] ?? logical;
  const log = [];
  const a3Reads = {};
  let lastSeq = 0;
  let sinceAt = mountedAt;
  let lastEditEnd = mountedAt;
  const stall = (operation, reason) => ({
    log,
    a3Reads,
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
  return { log, a3Reads, stalled: null };
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
  "scripts/quality/nir1-graph-eval/build-receipt-check.mjs",
  "scripts/quality/nir1-graph-eval/renderer/cp4-trace-probe.tsx",
]);

function parseArgs(argv) {
  const options = {
    "eval-build": path.join(ROOT, ".artifacts/cp4/eval-build"),
    "procedure-version": DEV_DRAFT_PROCEDURE_VERSION,
    "procedure-commit": "HEAD",
    cycles: "3",
    attempt: "1",
  };
  for (let at = 0; at < argv.length; at += 2) {
    if (!argv[at].startsWith("--") || argv[at + 1] === undefined)
      throw new Error("use --name value arguments");
    options[argv[at].slice(2)] = argv[at + 1];
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(options.run ?? ""))
    throw new Error("--run <name> is required");
  for (const name of ["ja-model", "en-model", "k62-commit"])
    if (!options[name]) throw new Error(`--${name} is required`);
  if (!options.setup && !options.fixture)
    throw new Error("--setup (dev) or --fixture (frozen) is required");
  return options;
}

function git(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
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
  try {
    if (options.fixture || options.trace) {
      readK64FreezeHead({ root: ROOT, commit: options["k64-commit"] });
      admitTraceRun({ root: ROOT, fixture: { kind: "frozen" } });
    }
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
    const planErrors = validateTracePlan(plan, { preview: true });
    if (planErrors.length > 0)
      throw new Error(
        `[precheck] the dev trace plan: ${planErrors.join("; ")}`,
      );
    const procedure = loadProcedureFile({
      root: ROOT,
      version: options["procedure-version"],
      commit: options["procedure-commit"],
      purpose: "dev-preview",
    });
    const ratification5 = collectRatification5Evidence({
      root: ROOT,
      candidateHead: "HEAD",
    });
    const head = {
      k62: readK62FreezeHead({ root: ROOT, commit: options["k62-commit"] }),
      runStartedAtUtc: new Date().toISOString(),
    };
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
    // DR-CP4-TR-5: the receipts name this candidate (before any launch).
    report.checks.productBuild = checkRunnerBuildReceipts({
      root: ROOT,
      options,
      candidate,
      evalDir,
    });
    const coldDb = path.join(ROOT, setup.coldDatabase.path);
    if (sha256(await readFile(coldDb)) !== setup.coldDatabase.sha256)
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
    const seed = ids.entities[fixture.graphSeedEntityId];

    // prep (as k64-runner): the seed pin on the measurement copy's query
    // Scene (DR-CP4-S1C2-26), the Raw vectors and the Chronicle Index.
    session = await launch({
      label: "prep",
      runDir,
      server,
      observer,
      options: launchOptions,
      admission,
    });
    await openWorkspace(session.page, workspacePath, ids);
    report.checks.devSeedPin = await session.page.evaluate(
      (value) => window.cp4Harness.api.upsertScenePin(value),
      { sceneId: ids.querySceneId, entryId: seed },
    );
    const raw = await session.page.evaluate(
      (input) => window.cp4Harness.buildRaw(input),
      {
        projectId: ids.projectId,
        label: `cp4-${options.run}`,
        sceneIds: Object.keys(ids.scenes),
        queryBody: fixture.query.body,
      },
    );
    if (!raw.ok || !raw.value.ok)
      throw new Error("[artifact] the Raw index build failed");
    report.checks.prepIndex = await buildIndex(session.page, ids);
    await stopSession("prep", session);
    session = null;

    // R5: the query Scene's first pin is the expected seed.
    report.checks.seedPins = assertSeedPinsBeforeK64({
      cases: [
        {
          caseId: `dev:${loaded.path}`,
          setup: loadSetupReceipt({ root: ROOT, file: setupPath }),
          read: readQuerySceneSeedPins(dbPath, ids.projectId, ids.querySceneId),
          querySceneLogical: fixture.query.sceneId,
          expectedSeedLogical: fixture.graphSeedEntityId,
        },
      ],
      plan: "dev",
    });

    // The measurement session: one trace.
    session = await launch({
      label: "measure",
      runDir,
      server,
      observer,
      options: launchOptions,
      admission,
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
    poller = counterPoller({ app: session.app, nativePath });
    report.checks.counterPoll = { install: await poller.install() };
    report.checks.clearSamples = await call(addon, "nir1GraphEvalClearSamples");
    const nativeReads = [];
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
    const materials = plan.expectedMaterials.map(
      (row) => ids.typedRevisions[row.revisionId].revisionId,
    );
    const runStartedAtMs = Date.now();
    const started = performance.now();
    const result = await runTraceOperations({
      plan,
      runtime: { scenes: ids.scenes },
      driver: pageDriver(page),
      mountedAt,
      readA3: () =>
        call(
          addon,
          "nir1GraphEvalReadA3",
          dbPath,
          ids.projectId,
          ids.querySceneId,
          materials,
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
      `${JSON.stringify({ observation, nativeReads, counters, log: result.log, a3Reads: result.a3Reads }, null, 1)}\n`,
    );
    const native = mergeNativeRecords(nativeReads);
    const revisions = Object.fromEntries(
      Object.entries(ids.typedRevisions).map(([logical, row]) => [
        logical,
        row.revisionId,
      ]),
    );
    const rows = traceRows({
      plan,
      observation,
      log: result.log,
      native,
      runs: counters.runs ?? [],
      a3Reads: result.a3Reads,
      d2aMode: D2A_MODE,
      ids: { revisions },
      expectedContribution: devExpectedContribution(loaded, "base", ids),
    });
    const parentSeqs = result.log
      .filter((row) => Number.isInteger(row.parentSeq))
      .map((row) => row.parentSeq);
    const events = traceEvents({
      plan,
      observation,
      log: result.log,
      parentSeqs,
    });
    const k64 = summarizeTraceRun({
      plan,
      rows,
      events,
      fixedGraphMode: D2A_MODE,
      candidate: ratification5,
      candidateHead: candidate.commit,
    });
    const k62 = summarizeTraceRun({
      plan,
      rows,
      events,
      fixedGraphMode: D2A_MODE,
    });
    const ownPids = [
      ...readAncestorPids(),
      ...(evidence.recordedPids ?? []).map((row) => row.pid),
    ];
    const receipt = {
      schemaVersion: TRACE_RUN_SCHEMA,
      runKind: "trace-preview",
      preview: true,
      previewNote:
        "TR dev trace preview: seen by the integrator only; never a CP-4 result, never aggregated, never used to choose a threshold, a bound or a trace",
      runId: options.run,
      attempt: Number(options.attempt),
      fixture: { path: loaded.path, sha256: loaded.sha256, kind: "dev" },
      trace: {
        traceId: plan.traceId,
        kind,
        plannedQ: plan.plannedQ,
        planSha256: sha256(Buffer.from(JSON.stringify(plan))),
        source: "devTracePlan (S2 shape; not a fixed trace)",
      },
      head,
      candidate: {
        ...candidate,
        commit: git(["rev-parse", "HEAD"]),
        ratification5: JSON.parse(JSON.stringify(ratification5)),
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
        requeries: "counted apart (K6/2 step 7); never rows",
      },
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
      counterPoll: {
        polls: counters.polls ?? null,
        errors: counters.errors ?? null,
        lastError: counters.lastError ?? null,
        runs: counters.runs?.length ?? null,
      },
      native: { dropped: native.dropped, records: native.records.length },
      requeries: traceRequeries({ observation, parentSeqs }).counts,
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
    await writeSha256Sums(runDir, ["receipt.json", "observation.json"]);
    receiptWritten = true;
    if (result.stalled || report.problems.length > 0) process.exitCode = 1;
    process.stdout.write(
      `${JSON.stringify(
        {
          run: options.run,
          stalled: result.stalled,
          counted: rows.length,
          defects: k64.defects,
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
