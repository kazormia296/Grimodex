/* global window */
// CP-4 S1f: 正式の runner の骨格 — K6/4 の測定の手順 R1〜R8 の実装
// （`docs/plans/nir1-final-request-eval-proposal-4-draft.md` の「測定の手順の読み替え」。
// DR-CP4-F-*）。
//
//   TMPDIR=<short scratch> node scripts/local-ci-xvfb.mjs node \
//     scripts/quality/nir1-graph-eval/k64-runner.mjs --run <name> \
//     --setup .artifacts/cp4/<setup-run>/setup/setup-receipt.json \
//     --ja-model <pinned> --en-model <pinned> --k62-commit <K6/2 freeze> \
//     [--procedure-version draft-1] [--keep-test-worktree <clean worktree>]
//
// 流れ: admission（凍結した fixture は `admitGraphCaseRun`。K6/4 の凍結の commit が
// 固定されるまで [precheck] で止まる＝fail closed。dev fixture は予告の admission）
// → 手順のファイルの検証（`loadProcedureFile`）→ 批准 5 の証拠（git と keep test。
// admission.mjs が封印）→ prep（dev の測定の写しの query の Scene に seed の pin、Raw と
// Chronicle の Index）→ seed の pin の照合（R5。DB から読み、一致しなければ判定を
// 始めない）→ 測定の session（V-10、Index、owner の準備）→ AB/BA の schedule（R4 の
// 直列。Graph の arm は R2 の cache の空、R1 の待ちと記録、hook の消費者の sample、
// R2 の終わりの確認、R4 の release の待ち、counter と Native の記録 → R7 の記録）→
// receipt（runner の種別 k64-hook-consumer、K6/2 の先頭〔正式なら K6/4 の凍結も〕、
// 批准 5 の記録、手順のファイルの版）と検証。
//
// R1〜R4 の待ちは手順のファイルの上限で打ち切り、待った時間は latency に含めない
// （R1。renderer の時刻は query の中だけ）。R8（2 つの表示と連続編集）は定常状態の
// run では行わない。dev の予告は CP-4 の判定に入らない（preview、集計しない）。

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";
import { setTimeout as delay } from "node:timers/promises";
import {
  admitDevPreview,
  admitGraphCaseRun,
  collectRatification5Evidence,
  collectRatification5EvidenceWithKeepTest,
  readK62FreezeHead,
  readK64FreezeHead,
} from "./admission.mjs";
import { summarizeSteadyState, samplesDigest } from "./availability.mjs";
import { K64_W_F_MS, OWNER_REBUILD_MIN_INTERVAL_MS } from "./constants.mjs";
import { devVariantOf, loadDevFixture } from "./dev-fixture.mjs";
import { buildIndex, launch, openWorkspace } from "./dprime-check.mjs";
import {
  K64_RUNNER_KIND,
  k64GraphSampleRow,
  r1Record,
  r2Record,
} from "./k64-record.mjs";
import { PRODUCT_MAIN, ROOT, bundleObserver } from "./launcher.mjs";
import { summarizeVariantQuality } from "./outcome.mjs";
import {
  DEV_DRAFT_PROCEDURE_VERSION,
  loadProcedureFile,
  procedureSettings,
} from "./procedure-file.mjs";
import {
  CP4_RECEIPT_SCHEMA,
  assessMeasurementWindow,
  computeRunAggregates,
  computeRunVerdict,
  validateCp4Receipt,
  writeSha256Sums,
} from "./receipt.mjs";
import { buildHarnessRenderer, startStaticServer } from "./renderer-build.mjs";
import { runSchedule, sampleRow } from "./run-sample.mjs";
import { assertSeedPinsBeforeK64 } from "./seed-pin.mjs";
import { loadSetupReceipt } from "./setup-receipt.mjs";
import { HARNESS_PAGE, sha256 } from "./session.mjs";
import {
  hostSnapshot,
  readAncestorPids,
  startWindowSampler,
} from "./window.mjs";
import { readQuerySceneSeedPins } from "./workspace-db.mjs";

export const K64_DEV_PREVIEW_PURPOSE = "k64-runner-preview";
/** A hang guard for a parent that never returns (not a K6/4 value). */
const PARENT_LIMIT_MS = 30_000;
/**
 * P2-3: the guard of the probe's observation window after the sample's end
 * (the mixing checks; not a K6/4 value). A window it cuts is X10.
 */
const MIX_WINDOW_GUARD_MS = 2_000;
/** A hang guard for one evaluation entry call (E-14's bound). */
const ADDON_CALL_TIMEOUT_MS = 10_000;
/** The owner's first prepare (V-10 READY); harness readiness, never a sample. */
const OWNER_READY_WAIT_MS = 90_000;
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
 * R1 (K6/4:192): waits, at most `waitMs` (the procedure file's bound), for
 * (1) an `empty` slot, (2) an empty next-query cache (emptied through the
 * test entry whenever the slot is empty and an entry appeared) and (3) the
 * owner's `rebuild_min_interval` since the previous seeded sample ended.
 * (4), the previous R4 release, is a fact of the previous sample and is not
 * waited for. Returns the R1 record; `reachedQuiet: false` still takes the
 * sample (never removed from the denominator).
 */
export async function waitR1({
  addon,
  waitMs,
  lastSeededEndedAt,
  previousReleaseWithinLimit,
  now = () => performance.now(),
  sleep = (ms) => delay(ms),
}) {
  const started = now();
  let cacheCleared = 0;
  for (;;) {
    let status = await call(addon, "nir1GraphEvalStatus");
    if (status.owner?.slot === "empty" && status.owner?.cacheOccupied) {
      const cleared = await call(addon, "nir1GraphEvalClearNextQueryCache");
      if (cleared.cleared) cacheCleared += 1;
      status = await call(addon, "nir1GraphEvalStatus");
    }
    const record = r1Record({
      slot: status.owner?.slot ?? null,
      cacheOccupied: status.owner?.cacheOccupied ?? null,
      cacheCleared,
      sinceLastSeededMs:
        lastSeededEndedAt === null ? null : now() - lastSeededEndedAt,
      previousReleaseWithinLimit,
      waitedMs: now() - started,
    });
    const waitable =
      record.slotEmpty &&
      record.cacheEmpty &&
      (record.sinceLastSeededMs === null ||
        record.sinceLastSeededMs >= OWNER_REBUILD_MIN_INTERVAL_MS);
    if (waitable || now() - started >= waitMs) return record;
    await sleep(5);
  }
}

/**
 * R4 (K6/4:195): after the sample, the session's release and the owner's
 * quiet (an `empty` slot), at most `waitMs`. Beyond it the next seeded sample
 * records R1 (4) unmet.
 */
export async function waitRelease({
  addon,
  waitMs,
  now = () => performance.now(),
  sleep = (ms) => delay(ms),
}) {
  const started = now();
  for (;;) {
    const status = await call(addon, "nir1GraphEvalStatus");
    const slot = status.owner?.slot ?? null;
    if (slot === "empty")
      return { withinLimit: true, waitedMs: now() - started, slot };
    if (now() - started >= waitMs)
      return { withinLimit: false, waitedMs: now() - started, slot };
    await sleep(5);
  }
}

/**
 * The admission of a K6/4 run. A frozen fixture goes through
 * `admitGraphCaseRun` (N-1, the default addon, 批准 5, the K6/2 and K6/4
 * freeze heads); until the integrator pins K64_FREEZE.freezeCommit it stops
 * with `[precheck]`. A dev fixture gets the dev preview admission.
 */
export function admitK64Run(input) {
  const { root, fixture } = input;
  if (fixture?.kind === "frozen")
    return admitGraphCaseRun({
      root,
      candidateHead: input.candidateHead ?? "HEAD",
      prepCommit: input.prepCommit,
      buildReceipt: input.buildReceipt,
      productReceipt: input.productReceipt,
      fixtures: [{ path: fixture.path, sha256: fixture.sha256 }],
      defaultAddonSha256: input.defaultAddonSha256,
      k62Commit: input.k62Commit,
      k64Commit: input.k64Commit,
      // P2-4: the keep test ran before (async) and its evidence is sealed.
      ...(input.ratification5 !== undefined
        ? { ratification5: input.ratification5 }
        : {}),
    });
  if (fixture?.kind === "dev")
    return admitDevPreview({
      purpose: K64_DEV_PREVIEW_PURPOSE,
      fixture: fixture.loaded,
    });
  throw new Error("[precheck] a K6/4 run names a frozen or a dev fixture");
}

/**
 * The run receipt of the K6/4 runner. The aggregates and the verdict are
 * the validator's own functions; the bound evidence (批准 5 sealed by
 * admission.mjs, the procedure loadProcedureFile read) is what the
 * summaries use. A dev preview also carries the steady-state summary of its
 * dev plan and the quality measured on the same samples (E-3).
 */
export function assembleK64Receipt({
  runId,
  preview,
  fixture,
  variant,
  head,
  candidate,
  ratification5,
  procedure,
  environment,
  run,
  settings,
  declaration = null,
  measurementWorkspace = null,
  samples,
  checks,
}) {
  const receipt = {
    schemaVersion: CP4_RECEIPT_SCHEMA,
    runKind: "g-case-gold",
    runnerKind: K64_RUNNER_KIND,
    runId,
    preview,
    ...(preview
      ? {
          previewNote:
            "K6/4 runner dev preview (S1f): seen by the integrator only; never a CP-4 result, never aggregated, never used to choose a threshold or a wait bound",
        }
      : {}),
    fixture,
    head,
    candidate: {
      ...candidate,
      ratification5: JSON.parse(JSON.stringify(ratification5)),
    },
    environment,
    run,
    settings: {
      ...settings,
      variantKey: variant.key,
      ...(variant.kind === "dev"
        ? {
            devVariant: {
              key: variant.key,
              expectedGraph: variant.expectedGraph,
            },
          }
        : {}),
      k64: procedureSettings(procedure),
    },
    declaration,
    measurementWorkspace,
    samples,
    requeries: [],
    checks,
  };
  const bound = { ratification5, procedure };
  receipt.aggregates = computeRunAggregates(receipt, variant, bound);
  receipt.verdict = computeRunVerdict(receipt, variant, receipt.aggregates);
  if (variant.kind === "dev") {
    const steadyState = summarizeSteadyState({
      samples,
      fixedGraphMode: settings.d2aModes.graph,
      plan: {
        kind: "dev",
        variants: [{ key: variant.key, expectedGraph: variant.expectedGraph }],
      },
      candidate: ratification5,
      candidateHead: candidate.commit,
    });
    receipt.k64Preview = {
      steadyState: JSON.parse(JSON.stringify(steadyState)),
      quality: summarizeVariantQuality({ variant, samples, steadyState }),
      qualitySamplesDigest: samplesDigest(samples),
    };
  }
  return receipt;
}

function parseArgs(argv) {
  const options = {
    variant: "base",
    "eval-build": path.join(ROOT, ".artifacts/cp4/eval-build"),
    "procedure-version": DEV_DRAFT_PROCEDURE_VERSION,
    "procedure-commit": "HEAD",
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

const HARNESS_FILES = Object.freeze([
  "scripts/quality/nir1-graph-eval/k64-runner.mjs",
  "scripts/quality/nir1-graph-eval/k64-record.mjs",
  "scripts/quality/nir1-graph-eval/q4.mjs",
  "scripts/quality/nir1-graph-eval/procedure-file.mjs",
  "scripts/quality/nir1-graph-eval/seed-pin.mjs",
  "scripts/quality/nir1-graph-eval/keep-test.mjs",
  "scripts/quality/nir1-graph-eval/followup.mjs",
  "scripts/quality/nir1-graph-eval/availability.mjs",
  "scripts/quality/nir1-graph-eval/outcome.mjs",
  "scripts/quality/nir1-graph-eval/receipt.mjs",
  "scripts/quality/nir1-graph-eval/admission.mjs",
  "scripts/quality/nir1-graph-eval/run-sample.mjs",
  "scripts/quality/nir1-graph-eval/native-sample.mjs",
  "scripts/quality/nir1-graph-eval/session.mjs",
  "scripts/quality/nir1-graph-eval/launcher.mjs",
  "scripts/quality/nir1-graph-eval/egress.mjs",
  "scripts/quality/nir1-graph-eval/window.mjs",
  "scripts/quality/nir1-graph-eval/workspace-db.mjs",
  "scripts/quality/nir1-graph-eval/dev-fixture.mjs",
  "scripts/quality/nir1-graph-eval/dprime-check.mjs",
  "scripts/quality/nir1-graph-eval/renderer/cp4-harness.ts",
  "scripts/quality/nir1-graph-eval/renderer/cp4-k64-probe.tsx",
  "scripts/quality/nir1-graph-eval/renderer/fetchRelatedScenes.timing.ts",
  "scripts/quality/nir1-graph-eval/renderer/nir1RelatedScenesApi.timing.ts",
  PRODUCT_MAIN,
]);

/** Candidate block (§7.2): commit, tree, clean, receipts, models, harness. */
function candidateBlock({ options, nativePath, workerPath }) {
  const evalDir = path.dirname(nativePath);
  const read = (file) => (existsSync(file) ? readFileSync(file) : null);
  const evalReceipt = read(path.join(evalDir, "eval-build.json"));
  const productReceipt = options["product-receipt"]
    ? read(path.resolve(options["product-receipt"]))
    : null;
  const manifest = JSON.parse(
    readFileSync(path.join(ROOT, "evals/nir1-retrieval/manifest.json"), "utf8"),
  );
  return {
    commit: git(["rev-parse", "HEAD"]),
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
    harnessFiles: Object.fromEntries(
      HARNESS_FILES.map((file) => [
        file,
        sha256(readFileSync(path.join(ROOT, file))),
      ]),
    ),
  };
}

/** The dev variant's expected Graph contribution, as runtime Scene ids. */
function devExpectedContribution(loaded, variantId, ids) {
  const variant = loaded.fixture.variants.find((row) => row.id === variantId);
  const graph = variant?.expectations?.arms?.rPlusIrPlusGraph;
  if (!graph) return null;
  const runtime = (logical) => ids.scenes?.[logical] ?? null;
  return {
    appendedSceneIds: [runtime(graph.appendedSceneId)].filter(Boolean),
    pathAttachmentSceneIds: (graph.pathAttachmentSceneIds ?? [])
      .map(runtime)
      .filter(Boolean),
  };
}

async function evaluateOk(page, label, fn, arg) {
  const result = await page.evaluate(fn, arg);
  if (!result?.ok)
    throw new Error(
      `${label} failed: ${result?.error ?? JSON.stringify(result)}`,
    );
  return result.value;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const runDir = path.join(ROOT, ".artifacts/cp4", options.run);
  await mkdir(runDir, { recursive: false });
  const report = {
    schema: "nir1-cp4-k64-run-report/1",
    run: options.run,
    problems: [],
    sessions: {},
    checks: {},
  };
  let server = null;
  let session = null;
  let windowSampler = null;
  const samples = [];
  let run;
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
  try {
    // 1. admission. A frozen fixture is a formal run: admitGraphCaseRun stops
    // it until the K6/4 freeze is pinned (fail closed).
    if (options.fixture) {
      // The K6/4 freeze head first (cheap), so an unpinned freeze stops the
      // run before the keep test (minutes) runs.
      readK64FreezeHead({ root: ROOT, commit: options["k64-commit"] });
      admitK64Run({
        root: ROOT,
        fixture: { kind: "frozen", path: options.fixture },
        prepCommit: options["prep-commit"],
        k62Commit: options["k62-commit"],
        k64Commit: options["k64-commit"],
        ...(options["keep-test-worktree"]
          ? {
              ratification5: await collectRatification5EvidenceWithKeepTest({
                root: ROOT,
                candidateHead: "HEAD",
                keepTestWorktree: path.resolve(options["keep-test-worktree"]),
                keepTestLogDir: runDir,
              }),
            }
          : {}),
      });
      throw new Error(
        "[precheck] S1f: the frozen-fixture steps (the frozen setup, the K2/4 declaration step, the seed pins read from the frozen setup) are wired after the K6/4 freeze (S2/S5); this skeleton measures the dev preview only",
      );
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
    const admission = admitK64Run({
      root: ROOT,
      fixture: { kind: "dev", loaded },
    });
    const variant = devVariantOf(loaded, options.variant);
    const ids = setup.logicalToRuntime;
    const seed = ids.entities[loaded.fixture.graphSeedEntityId];
    // 2. the procedure file (a draft is allowed for a dev preview only).
    const procedure = loadProcedureFile({
      root: ROOT,
      version: options["procedure-version"],
      commit: options["procedure-commit"],
      purpose: "dev-preview",
    });
    // 3. 批准 5 from git and the keep test (admission.mjs seals it).
    // P2-4: the keep test runs in its own process group (async); the
    // signal handler is installed before it and its logs go to the run dir.
    const ratification5 = options["keep-test-worktree"]
      ? await collectRatification5EvidenceWithKeepTest({
          root: ROOT,
          candidateHead: "HEAD",
          keepTestWorktree: path.resolve(options["keep-test-worktree"]),
          keepTestLogDir: runDir,
        })
      : collectRatification5Evidence({ root: ROOT, candidateHead: "HEAD" });
    report.ratification5 = JSON.parse(JSON.stringify(ratification5));
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
    report.checks.rendererBuild = {
      alias: rendererBuild.alias,
      timingShim: rendererBuild.timingShim,
      fetchTiming: rendererBuild.fetchTiming,
    };
    server = await startStaticServer({
      dir: path.join(runDir, "renderer-dist"),
    });
    const observer = await bundleObserver({
      outDir: path.join(runDir, "observer"),
    });
    candidate.harnessFiles["observer.cjs"] = observer.sha256;
    const launchOptions = { ...options };

    // 4. prep: the dev measurement copy gets the seed pin on the query
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
        queryBody: loaded.fixture.query.body,
      },
    );
    if (!raw.ok || !raw.value.ok)
      throw new Error("[artifact] the Raw index build failed");
    report.checks.prepIndex = await buildIndex(session.page, ids);
    await stopSession("prep", session);
    session = null;

    // 5. R5: the query Scene's first pin is the expected seed, read from the
    // measurement copy; otherwise the K6/4 judgement does not start.
    const pins = readQuerySceneSeedPins(
      dbPath,
      ids.projectId,
      ids.querySceneId,
    );
    // P2-1: the runtime IDs come from the sealed setup receipt, and the read
    // is bound to the measurement copy's DB, project and query Scene.
    report.checks.seedPins = assertSeedPinsBeforeK64({
      cases: [
        {
          caseId: variant.key,
          setup: loadSetupReceipt({ root: ROOT, file: setupPath }),
          read: pins,
          querySceneLogical: loaded.fixture.query.sceneId,
          expectedSeedLogical: loaded.fixture.graphSeedEntityId,
        },
      ],
      plan: "dev",
    });

    // 6. the measurement session.
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
    await evaluateOk(
      page,
      "hook prepare",
      (input) => window.cp4Harness.hook.prepare(input),
      { workspacePath },
    );
    const instrumented = await page.evaluate(() =>
      window.cp4Harness.k64.instrumented(),
    );
    if (instrumented?.fetchTiming !== true)
      throw new Error("[precheck] the fetch timing shim is not in the page");
    report.checks.measureIndex = await buildIndex(page, ids);
    // The owner's first prepare (V-10 READY), through the hook consumer;
    // recorded, never a sample.
    const ready = [];
    // The probes are seeded queries too: R1 (3) and (4) of the first sample
    // count from the last of them.
    let lastSeededEndedAt = null;
    let previousReleaseWithinLimit = true;
    const readyStarted = performance.now();
    let diagnostics = await call(addon, "nir1GraphEvalDiagnostics");
    while (
      (diagnostics.preparesReady ?? 0) < 1 &&
      performance.now() - readyStarted < OWNER_READY_WAIT_MS
    ) {
      const probe = await page.evaluate(
        (input) => window.cp4Harness.k64.sample(input),
        {
          projectId: ids.projectId,
          tShowMs: procedure.values.tShowMs,
          parentLimitMs: PARENT_LIMIT_MS,
          wfMs: K64_W_F_MS,
          mixGuardMs: MIX_WINDOW_GUARD_MS,
        },
      );
      lastSeededEndedAt = performance.now();
      const release = await waitRelease({
        addon,
        waitMs: procedure.values.r1r4WaitMs,
      });
      previousReleaseWithinLimit = release.withinLimit;
      diagnostics = await call(addon, "nir1GraphEvalDiagnostics");
      ready.push({
        ok: probe.ok,
        endReason: probe.value?.endReason ?? null,
        release,
        preparesReady: diagnostics.preparesReady ?? null,
      });
      if ((diagnostics.preparesReady ?? 0) < 1) await delay(1_000);
    }
    report.checks.ownerReady = { probes: ready, diagnostics };
    if ((diagnostics.preparesReady ?? 0) < 1)
      throw new Error("[precheck] V-10: the worker never reached READY");

    // 7. the AB/BA schedule (K6/2 step 2; R4: serial, no edit, no scene
    // switch, no other query, no D-final between samples).
    const expectedContribution = devExpectedContribution(
      loaded,
      options.variant,
      ids,
    );
    const revisionIds = Object.values(ids.typedRevisions ?? {}).map(
      (row) => row.revisionId,
    );
    const releases = [];
    run = { startedAtMs: Date.now() };
    for (const slot of runSchedule()) {
      if (slot.arm === "hybrid") {
        await call(addon, "nir1GraphEvalClearSamples");
        const measure = await page.evaluate(
          (input) => window.cp4Harness.measure(input),
          { sceneId: ids.querySceneId, seed: null },
        );
        samples.push(
          sampleRow({
            variantKey: variant.key,
            ...slot,
            d2aMode: D2A_MODE,
            measure,
          }),
        );
        continue;
      }
      await call(addon, "nir1GraphEvalClearSamples");
      // R2: the next-query cache is emptied before each sample.
      await call(addon, "nir1GraphEvalClearNextQueryCache");
      const r1 = await waitR1({
        addon,
        waitMs: procedure.values.r1r4WaitMs,
        lastSeededEndedAt,
        previousReleaseWithinLimit,
      });
      const before = await call(addon, "nir1GraphEvalDiagnostics");
      const a3 = await call(
        addon,
        "nir1GraphEvalReadA3",
        dbPath,
        ids.projectId,
        ids.querySceneId,
        revisionIds,
      );
      const observed = await evaluateOk(
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
      lastSeededEndedAt = performance.now();
      if (observed.endReason === "harness-limit")
        throw new Error(
          "[artifact] the parent query never returned within the harness guard",
        );
      // R2: the cache at the sample's end; an entry left is recorded, emptied
      // and the sample is X4.
      const atEndStatus = await call(addon, "nir1GraphEvalStatus");
      const occupied = atEndStatus.owner?.cacheOccupied ?? null;
      const cleared = occupied
        ? (await call(addon, "nir1GraphEvalClearNextQueryCache")).cleared ===
          true
        : false;
      const r2 = r2Record({ cacheOccupiedAtEnd: occupied, cleared });
      const atEnd = await call(addon, "nir1GraphEvalDiagnostics");
      // R4: the release and the owner's quiet, within the procedure bound.
      const release = await waitRelease({
        addon,
        waitMs: procedure.values.r1r4WaitMs,
      });
      previousReleaseWithinLimit = release.withinLimit;
      releases.push({ ...slot, ...release });
      const afterRelease = await call(addon, "nir1GraphEvalDiagnostics");
      const records = (await call(addon, "nir1GraphEvalSamples")).records;
      samples.push(
        k64GraphSampleRow({
          variantKey: variant.key,
          phase: slot.phase,
          repeat: slot.repeat,
          d2aMode: D2A_MODE,
          observation: observed,
          nativeRecords: records,
          a3,
          r1,
          r2,
          counters: { before, atEnd, afterRelease },
          expectedContribution,
        }),
      );
      process.stderr.write(
        `[k64-runner] ${slot.phase}#${slot.repeat}: ${observed.endReason} (${records.map((row) => row.begin).join(">")})\n`,
      );
    }
    run.finishedAtMs = Date.now();
    report.checks.releases = releases;
    const windowSamples = windowSampler.stop();
    windowSampler = null;
    const evidence = await stopSession("measure", session);
    session = null;
    await server.close();
    server = null;
    const ownPids = [
      ...readAncestorPids(),
      ...(evidence.recordedPids ?? []).map((row) => row.pid),
    ];
    const environment = {
      hostSnapshot: hostSnapshot(),
      windowSamples,
      windowAssessment: assessMeasurementWindow({
        samples: windowSamples,
        run,
        ownPids,
      }),
      ownPids,
      xvfbDisplay: process.env.DISPLAY,
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
    const receipt = assembleK64Receipt({
      runId: options.run,
      preview: true,
      fixture: { path: loaded.path, sha256: loaded.sha256, kind: "dev" },
      variant,
      head,
      candidate,
      ratification5,
      procedure,
      environment,
      run,
      settings: {
        maintenance: "product",
        d2aModes: { hybrid: D2A_MODE, graph: D2A_MODE },
        reauthorization: {
          mode: D2A_MODE,
          placedStateFile: true,
          note: "restricted profile state placed before launch (placeD2aProfileState); no activation UI",
        },
        setupReceipt: {
          path: path.relative(ROOT, setupPath),
          sha256: sha256(setupBytes),
          logicalToRuntime: ids,
        },
        seed: {
          logical: loaded.fixture.graphSeedEntityId,
          runtime: seed,
          via: "product-hook-from-the-query-scene-pin",
          devPin: "added-to-the-measurement-copy (DR-CP4-S1C2-26)",
        },
        expectedContribution,
      },
      samples,
      checks: { ...report.checks, problems: report.problems },
    });
    const errors = validateCp4Receipt(receipt, { ratification5, procedure });
    await writeFile(
      path.join(runDir, "receipt.json"),
      `${JSON.stringify(receipt, null, 2)}\n`,
    );
    await writeFile(
      path.join(runDir, "validation.json"),
      `${JSON.stringify({ valid: errors.length === 0, errors }, null, 2)}\n`,
    );
    await writeSha256Sums(runDir, ["receipt.json", "validation.json"]);
    receiptWritten = true;
    if (errors.length > 0 || report.problems.length > 0) process.exitCode = 1;
    process.stdout.write(
      `${JSON.stringify(
        {
          run: options.run,
          valid: errors.length === 0,
          errors,
          verdict: receipt.verdict,
          regime: receipt.k64Preview?.steadyState?.regime ?? null,
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
    if (session)
      await stopSession("session", session).catch((error) =>
        report.problems.push(`stop: ${error?.stack ?? error}`),
      );
    await server?.close();
  }
  if (report.problems.length > 0) process.exitCode = 1;
  await writeFile(
    path.join(runDir, "run-report.json"),
    `${JSON.stringify({ ...report, samples: receiptWritten ? samples.length : samples }, null, 2)}\n`,
  );
  if (!receiptWritten)
    process.stdout.write(
      `${JSON.stringify({ run: options.run, stopped: true, problems: report.problems.map((row) => row.split("\n").slice(0, 3).join(" | ")) })}\n`,
    );
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename)
  await main();
