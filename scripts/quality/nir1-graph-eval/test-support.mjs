// Synthetic records shared by the CP-4 harness tests. Nothing here is a
// fixture of a G-case: every value is made up for the pure checks.
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { claimTestEvidenceSealer } from "./admission-facts.mjs";
import { r1Record, r2Record } from "./k64-record.mjs";
import { readQuerySceneSeedPins } from "./workspace-db.mjs";
import {
  DEV_SETUP_RECEIPT_SCHEMA,
  FROZEN_SETUP_RECEIPT_SCHEMA,
  SETUP_STATUS_BY_STOP,
  loadSetupReceipt,
} from "./setup-receipt.mjs";
import { createHash } from "node:crypto";
import {
  DEV_DRAFT_PROCEDURE_VERSION,
  loadProcedureFile,
  procedureFilePath,
} from "./procedure-file.mjs";
import {
  graphCaseScheduleKeys,
  summarizeSteadyState,
} from "./availability.mjs";
import {
  G01_FIXTURE,
  GRAPH_CASE_FREEZE,
  GRAPH_EVAL_VARIANTS,
  K62_FREEZE,
  K64_CANDIDATE_REQUIREMENTS,
  K64_FREEZE,
  OBSERVATION_PREP_RECORD_PATH,
  OBSERVATION_PREP_RECORD_SCHEMA,
} from "./constants.mjs";
import { s2Record } from "./s5b-test-support.mjs";
import { REQUIRED_ARTIFACTS } from "../nir1-retrieval/standard-build-receipt.mjs";

export const H40 = (c) => c.repeat(40);
export const H64 = (c) => c.repeat(64);

/** A seeded, usable, in-window worker sample unless overridden. */
export function sample(overrides = {}) {
  const { graph = {}, ...rest } = overrides;
  return {
    variantKey: "G-02/base",
    arm: "graph",
    phase: "measured",
    repeat: 0,
    trigger: "user-operation",
    seeded: true,
    graphEnabled: true,
    d2aMode: "restricted",
    tFetch: 90,
    tRawReady: 100,
    tReturn: 120,
    snapshot: { usable: true, reason: null },
    irOutcome: "ir-ready",
    a3AtStart: { eligible: true, reasons: [] },
    startSlot: { readyFresh: true },
    freshnessStamp: { result: "fresh", matched: true, attemptedAtNs: 95_000 },
    recordRead: { startedAtNs: 80_000, finishedAtNs: 85_000 },
    expectedMaterials: ["rev-a"],
    finalSceneIds: ["dev-a", "dev-b", "dev-added"],
    ...rest,
    graph: {
      outcome: "graph-ready",
      reason: null,
      source: "worker",
      joined: true,
      arrivedAt: 105,
      revalidation: "passed",
      edgeCount: 2,
      busyCause: null,
      ...graph,
    },
  };
}

/** Overrides for a Graph result that was not joined. */
export const late = (reason, extra = {}) => ({
  finalSceneIds: ["dev-a", "dev-b"],
  graph: {
    outcome: reason === "graph-late" ? "graph-late" : "graph-unavailable",
    reason: reason === "graph-late" ? null : reason,
    joined: false,
    arrivedAt: null,
    revalidation: null,
    edgeCount: null,
    ...extra,
  },
});

/**
 * The full AB/BA schedule of each variant. `mutate(variant, repeat)` returns
 * overrides for the measured Graph sample.
 */
export function scheduleRows(variants, mutate = () => ({})) {
  const rows = [];
  for (const variant of variants)
    for (const key of graphCaseScheduleKeys(variant.key)) {
      const parts = key.split(":");
      const arm = parts.pop();
      const repeatText = parts.pop();
      const phase = parts.pop();
      const repeat = Number(repeatText);
      const unavailable = variant.expectedGraph === "unavailable";
      if (arm === "hybrid") {
        rows.push({
          variantKey: variant.key,
          arm,
          phase,
          repeat,
          trigger: "user-operation",
          finalSceneIds: ["dev-a", "dev-b"],
        });
        continue;
      }
      rows.push(
        sample({
          variantKey: variant.key,
          phase,
          repeat,
          ...(unavailable
            ? {
                snapshot: { usable: false, reason: "graph-index-unusable" },
                ...late("registration-unavailable"),
              }
            : {}),
          ...(phase === "measured" ? mutate(variant, repeat) : {}),
        }),
      );
    }
  return rows;
}

/**
 * The R7 record of one K6/4 query (K6/4 R3, R5, R7): a D′ parent that is
 * graph-late and declared `unused`, its ticket cached, one `graph-ready`
 * notice after the parent's publish, and one child that takes the entry as
 * `Cached`, joins its Graph within W_f and is published once. Times are the
 * renderer ms of `sample()` (t_raw_ready 100, t_pub_p = 100 + D): q1 = 17,
 * q2 = 14, q3 = 45. `parent` / `child` merge into the blocks; `child: null`
 * removes the child.
 */
export function followUpRecord({ parent = {}, child = {}, ...rest } = {}) {
  return {
    issuedVia: "product-hook",
    parent: {
      generation: 1,
      sceneId: "scene-q",
      seed: "entity-seed",
      tPub: 110.84,
      declaration: "unused",
      graphContinueAnswer: "cancelled",
      graphWindowMs: 10.840000000596048,
      refreshTrigger: null,
      publishCount: 1,
      lateGraphInDisplay: false,
      rSceneIds: ["dev-a", "dev-b"],
      irSceneIds: ["dev-c"],
      ticket: {
        settled: true,
        outcome: "available",
        reason: null,
        disposition: "unused",
        busyCause: null,
      },
      irRetryTimer: false,
      ...parent,
    },
    notices: [{ kind: "graph-ready", at: 117 }],
    counters: {
      before: { begins: 10, cacheHits: 3, lateCached: 3 },
      after: { begins: 12, cacheHits: 4, lateCached: 4 },
    },
    nativeBegins: ["pending", "cached"],
    r1: {
      slotEmpty: true,
      cacheEmpty: true,
      sinceLastSeededMs: 1_500,
      previousReleaseWithinLimit: true,
      reachedQuiet: true,
    },
    r2: { cacheEmptyAtEnd: true },
    cacheLoss: [],
    dPrimeCounters: {
      deferredReleased: 1,
      deferredExpired: 0,
      deferredDropped: 0,
      staleReadyRetired: 0,
      prepareFailures: 0,
      driftAtQuery: 0,
      stamp0Missing: 0,
    },
    loading: { switched: false, ms: null },
    child:
      child === null
        ? null
        : {
            origin: "graph-ready",
            generation: 2,
            refreshTrigger: "graph-ready",
            graphWindowMs: 100,
            sceneId: "scene-q",
            seed: "entity-seed",
            beginAt: 118.5,
            beginKind: "cached",
            tRawReady: 125,
            tGraph: 139,
            irOutcome: "ir-ready",
            irArrivedAt: 131,
            outcome: "graph-ready",
            reason: null,
            edgeCount: 2,
            expectedContribution: true,
            // A synthetic formal record: matched on the materials' Revisions
            // (DR-CP4-F-6 (b)); the producer's Scene-level match is preview only.
            contributionBasis: "material-revision",
            requalification: "passed",
            completion: "completed",
            publishCount: 1,
            currentAtDisplay: true,
            tFollow: 145,
            reactCommitAt: 146,
            lateGraphInDisplay: false,
            chronicleIndexUsable: true,
            rSceneIds: ["dev-a", "dev-b"],
            irSceneIds: ["dev-c"],
            finalSceneIds: ["dev-a", "dev-b", "dev-c", "dev-added"],
            ...child,
          },
    ...rest,
  };
}

/**
 * A K6/4 R+IR+Graph sample: the D′ parent (an empty slot at the start, the
 * Graph graph-late and not joined, the R+IR list shown) with the follow-up
 * record. `overrides` change the S1b sample; `followUp` goes to
 * followUpRecord.
 */
export function k64Sample(overrides = {}, followUp = {}) {
  const { graph = {}, ...rest } = overrides;
  return sample({
    startSlot: { kind: "empty", readyFresh: false },
    finalSceneIds: ["dev-a", "dev-b", "dev-c"],
    followUp: followUpRecord(followUp),
    ...rest,
    graph: {
      outcome: "graph-late",
      reason: null,
      source: null,
      joined: false,
      arrivedAt: null,
      revalidation: null,
      edgeCount: null,
      ...graph,
    },
  });
}

export const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");

/** git in a throwaway repository (no user config, fixed identity). */
export function testGit(cwd, ...args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "cp4",
      GIT_AUTHOR_EMAIL: "cp4@example.invalid",
      GIT_COMMITTER_NAME: "cp4",
      GIT_COMMITTER_EMAIL: "cp4@example.invalid",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  }).trim();
}

const FAKE_VITEST = `
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
const here = path.dirname(new URL(import.meta.url).pathname);
const mode = JSON.parse(readFileSync(path.join(here, "mode.json"), "utf8"));
const out = process.argv.find((arg) => arg.startsWith("--outputFile=")).slice(13);
const file = process.argv.at(-1);
// P2-4 (b): the env names the runner saw.
writeFileSync(path.join(here, "env.json"), JSON.stringify(Object.keys(process.env).sort()));
// P2-4 (d): a grandchild in the runner's process group (vitest's forks pool).
if (mode.child) {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  writeFileSync(path.join(here, "child.pid"), String(child.pid));
  child.unref();
}
if (mode.kind === "hang") setTimeout(() => {}, 60_000);
else if (mode.kind === "crash") {
  process.stderr.write("boom-stderr: the runner failed\\n");
  process.exit(2);
} else {
  if (mode.touch) writeFileSync(path.join(process.cwd(), mode.touch), "x");
  const name = mode.name ?? path.join(process.cwd(), file);
  const assertions = mode.assertions.map(([title, status]) => ({
    fullName: "keep " + title, status, title, ancestorTitles: ["keep"],
  }));
  const count = (status) => assertions.filter((row) => row.status === status).length;
  writeFileSync(out, JSON.stringify({
    numTotalTests: assertions.length,
    numPassedTests: count("passed"),
    numFailedTests: count("failed"),
    numPendingTests: count("skipped"),
    numTodoTests: count("todo"),
    startTime: Date.now(),
    success: count("failed") === 0,
    testResults: [{ name, status: count("failed") ? "failed" : "passed", assertionResults: assertions }],
  }));
  process.exit(mode.exit ?? (count("failed") ? 1 : 0));
}
`;

/** P2-4: the candidate's lock (the root importer locks vitest 4.1.12). */
export const KEEP_TEST_LOCK = `lockfileVersion: '9.0'

importers:

  .:
    devDependencies:
      vitest:
        specifier: ^4.1.12
        version: 4.1.12(happy-dom@21.0.4)

packages:

  vitest@4.1.12:
    resolution: {integrity: sha512-synthetic}
`;

/**
 * S1f: a throwaway candidate repository holding the RS-JOIN keep test file
 * and, in the ignored `node_modules/vitest/vitest.mjs`, a fake runner that
 * writes the JSON report `mode.json` asks for. Nothing runs vitest.
 */
export async function keepTestCandidate() {
  const repo = await mkdtemp(path.join(tmpdir(), "cp4-keep-"));
  testGit(repo, "init", "-q", "-b", "main");
  await writeFile(path.join(repo, ".gitignore"), "node_modules/\n");
  await mkdir(
    path.dirname(path.join(repo, K64_CANDIDATE_REQUIREMENTS.rsJoinKeepTest)),
    { recursive: true },
  );
  await writeFile(
    path.join(repo, K64_CANDIDATE_REQUIREMENTS.rsJoinKeepTest),
    "// keep test\n",
  );
  await writeFile(path.join(repo, "vitest.config.ts"), "export default {};\n");
  await writeFile(path.join(repo, "pnpm-lock.yaml"), KEEP_TEST_LOCK);
  testGit(repo, "add", "-A");
  testGit(repo, "commit", "-q", "--no-gpg-sign", "-m", "candidate");
  const head = testGit(repo, "rev-parse", "HEAD");
  // P2-4 (a): the install the candidate's lock describes.
  await mkdir(path.join(repo, "node_modules/.pnpm"), { recursive: true });
  await writeFile(
    path.join(repo, "node_modules/.pnpm/lock.yaml"),
    KEEP_TEST_LOCK,
  );
  const runner = path.join(repo, "node_modules/vitest");
  await mkdir(runner, { recursive: true });
  await writeFile(path.join(runner, "vitest.mjs"), FAKE_VITEST);
  await writeFile(
    path.join(runner, "package.json"),
    JSON.stringify({ name: "vitest", version: "4.1.12" }),
  );
  const mode = (value) =>
    writeFile(path.join(runner, "mode.json"), JSON.stringify(value));
  await mode({
    kind: "report",
    assertions: [
      ["a", "passed"],
      ["b", "passed"],
    ],
  });
  return { repo, head, mode };
}

let formalProcedureLoaded = null;

/**
 * A reviewed (non-draft) procedure file `v1`, committed to a throwaway git
 * repository and read with the production loader (no test-only sealer). The
 * repository is removed when the process exits.
 */
export function formalProcedure() {
  if (formalProcedureLoaded) return formalProcedureLoaded;
  const repo = mkdtempSync(path.join(tmpdir(), "cp4-procedure-support-"));
  process.once("exit", () => rmSync(repo, { recursive: true, force: true }));
  const run = (...args) =>
    execFileSync("git", args, {
      cwd: repo,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "cp4",
        GIT_AUTHOR_EMAIL: "cp4@example.invalid",
        GIT_COMMITTER_NAME: "cp4",
        GIT_COMMITTER_EMAIL: "cp4@example.invalid",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
  run("init", "-q", "-b", "main");
  const file = procedureFilePath("v1");
  mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  const draft = JSON.parse(
    readFileSync(
      path.join(REPO_ROOT, procedureFilePath(DEV_DRAFT_PROCEDURE_VERSION)),
      "utf8",
    ),
  );
  writeFileSync(
    path.join(repo, file),
    `${JSON.stringify(
      {
        ...draft,
        version: "v1",
        draft: false,
        values: { ...draft.values, r1r4WaitMs: 3_000 },
        review: {
          reviewer: "synthetic-reviewer",
          reviewedAt: "2026-10-27",
          record: "synthetic",
        },
      },
      null,
      2,
    )}\n`,
  );
  run("add", "--", file);
  run("commit", "-q", "--no-gpg-sign", "-m", "procedure v1");
  formalProcedureLoaded = loadProcedureFile({
    root: repo,
    version: "v1",
    commit: "HEAD",
    purpose: "formal",
  });
  return formalProcedureLoaded;
}

/** The candidate commit the test-sealed evidence names. */
export const TEST_CANDIDATE_HEAD = "e".repeat(40);

/** E-1: test suites only; production 批准 5 comes from admission.mjs. */
const sealTestEvidence = claimTestEvidenceSealer();
let sealedForTests = null;

/**
 * TEST ONLY. The 批准 5 evidence of a candidate that has D′, the RS-JOIN keep
 * test passed and W_f, sealed by the test sealer (`testOnly: true`) so the
 * K6/4 summaries can be exercised. Nothing runs the keep test here; the
 * production collector never accepts this path (E-1) and validateCp4Receipt
 * refuses test-only evidence. With `overrides` the result is a plain object,
 * never sealed, so the summaries read it as K6/2 (a self-reported record).
 */
export function ratification5(overrides = null) {
  sealedForTests ??= sealTestEvidence({
    kind: "ratification5",
    candidateHead: TEST_CANDIDATE_HEAD,
    dPrime: { commit: K64_CANDIDATE_REQUIREMENTS.dPrimeCommit, ancestor: true },
    rsJoinHook: {
      evidence: "candidate-test",
      testFile: K64_CANDIDATE_REQUIREMENTS.rsJoinKeepTest,
      passed: true,
    },
    wfWindow: {
      commit: K64_CANDIDATE_REQUIREMENTS.wfWindowCommit,
      ancestor: true,
    },
  });
  if (overrides === null) return sealedForTests;
  return { ...JSON.parse(JSON.stringify(sealedForTests)), ...overrides };
}

export function candidate(head = H40("b"), tree = H40("c")) {
  return {
    worktreeClean: true,
    resolvedBaseSha: H40("a"),
    resolvedHeadSha: head,
    resolvedHeadTreeSha: tree,
    currentHeadSha: head,
  };
}

const COMMAND = {
  status: "passed",
  closeObserved: true,
  termination: "close-and-group-exit-observed",
  cleanup: { complete: true },
  exitCode: 0,
};

export function productReceipt(overrides = {}) {
  return {
    schemaVersion: "nir1-standard-build/1",
    status: "passed",
    standardBuild: true,
    sourceUnchanged: true,
    root: "/synthetic/candidate",
    candidate: candidate(),
    sourceManifest: "/synthetic/candidate/.artifacts/source-manifest.json",
    sourceManifestSha256: H64("9"),
    commands: [
      { argv: ["pnpm", "napi:build"], ...COMMAND },
      { argv: ["pnpm", "electron:build"], ...COMMAND },
    ],
    artifacts: Object.fromEntries(
      REQUIRED_ARTIFACTS.map((file, at) => [file, H64(String(at + 1))]),
    ),
    ...overrides,
  };
}

export function evalReceipt(overrides = {}) {
  return {
    schemaVersion: "nir1-graph-eval-build/1",
    status: "passed",
    standardBuild: false,
    evaluationBuild: true,
    sourceUnchanged: true,
    candidate: candidate(),
    features: ["nir1-graph-eval"],
    capabilities: { nir1GraphEval: true },
    artifacts: {
      ".artifacts/cp4/eval-build/grimodex-node.node": H64("e"),
      ".artifacts/cp4/eval-build/nir1-c-query-worker": H64("f"),
    },
    worker: {
      path: ".artifacts/cp4/eval-build/nir1-c-query-worker",
      sha256: H64("f"),
    },
    ...overrides,
  };
}

/** An unavailable variant's row still comes from the product hook (R5). */
export const unavailableRecord = () =>
  followUpRecord({ parent: { ticket: null }, notices: [], child: null });

/**
 * The full K6/4 frozen schedule; `mutate(variant, repeat)` returns [sample
 * overrides, followUp overrides] for a measured row of a variant expected
 * available.
 */
export function k64Run(mutate = () => [{}, {}]) {
  return scheduleRows(GRAPH_EVAL_VARIANTS).map((row) => {
    if (row.arm !== "graph") return row;
    const variant = GRAPH_EVAL_VARIANTS.find((v) => v.key === row.variantKey);
    if (variant.expectedGraph === "unavailable")
      return { ...row, followUp: unavailableRecord() };
    const [overrides = {}, followUp = {}] =
      row.phase === "measured" ? mutate(variant, row.repeat) : [{}, {}];
    return k64Sample(
      {
        variantKey: row.variantKey,
        phase: row.phase,
        repeat: row.repeat,
        ...overrides,
      },
      followUp,
    );
  });
}

export function summarizeK64(
  samples,
  candidate = ratification5(),
  candidateHead = TEST_CANDIDATE_HEAD,
) {
  return summarizeSteadyState({
    samples,
    fixedGraphMode: "restricted",
    plan: { kind: "frozen" },
    candidate,
    candidateHead,
  });
}

const steadySummaries = {};

/** A sealed steady-state summary of the given regime (quality reads it, D-1). */
export function steadySummary(regime) {
  steadySummaries[regime] ??=
    regime === "k64"
      ? summarizeK64(k64Run())
      : summarizeSteadyState({
          samples: k64Run(),
          fixedGraphMode: "restricted",
          plan: { kind: "frozen" },
        });
  if (steadySummaries[regime].regime !== regime)
    throw new Error(
      `the ${regime} summary fixture is ${steadySummaries[regime].regime}`,
    );
  return steadySummaries[regime];
}

const SEED = "entity-seed";
const SCENE = "scene-q";

/** S1f: one returned fetch of the hook consumer (k64-record.mjs reads it). */
export function k64FetchResult(overrides = {}) {
  const { timing = {}, ...rest } = overrides;
  return {
    status: "completed",
    rawStatus: "completed",
    resultKind: "fused",
    irStatus: "available",
    irReason: null,
    completion: { outcome: "ir-ready", deadlineExceeded: false },
    graphOutcome: "graph-late",
    graph: null,
    initialSnapshot: { indexUsable: true, querySupported: true },
    rawSceneIds: ["dev-a", "dev-b"],
    irSceneIds: ["dev-c"],
    finalSceneIds: ["dev-a", "dev-b", "dev-c"],
    ...rest,
    timing: {
      tFetchMs: 50,
      tRawReadyMs: 100,
      tReturnMs: 110.9,
      refreshTrigger: null,
      graphWindowMs: 10.840000000596048,
      native: { rawReadyElapsedMs: 40, firstSnapshotElapsedMs: 5 },
      ...timing,
    },
  };
}

export const K64_CHILD_RESULT = {
  graphOutcome: "graph-ready",
  graph: {
    edgeCount: 2,
    graphOnlySceneId: "dev-added",
    pathAttachmentSceneIds: ["dev-b"],
  },
  finalSceneIds: ["dev-a", "dev-b", "dev-c", "dev-added"],
  timing: {
    tFetchMs: 118,
    tRawReadyMs: 125,
    tReturnMs: 145,
    refreshTrigger: "graph-ready",
    graphWindowMs: 100,
  },
};

export const k64Api = (cmd, calledAt, resolvedAt, extra = {}) => ({
  cmd,
  calledAt,
  resolvedAt,
  ok: true,
  settle: null,
  status: null,
  reason: null,
  ...extra,
});

/**
 * S1f: one D′ sample of the hook consumer: the parent graph-late, one
 * notice, a Cached child that joins its Graph within W_f.
 */
export function k64Observation({ parent = {}, child = {}, ...rest } = {}) {
  return {
    endReason: "child-published",
    mountedAt: 0,
    endedAt: 146.5,
    // P2-3: observed until the child's Graph continues returned and its
    // t_raw_ready + W_f passed.
    mixWindow:
      child === null
        ? { reason: "not-applied", until: 146.5 }
        : { reason: "settled", until: 241 },
    fetches: [
      {
        seq: 1,
        sceneId: SCENE,
        queryGeneration: 41,
        refreshTrigger: null,
        seed: SEED,
        rawOnly: false,
        calledAt: 50,
        resolvedAt: 111,
        result: k64FetchResult(),
        ...parent,
      },
      ...(child === null
        ? []
        : [
            {
              seq: 2,
              sceneId: SCENE,
              queryGeneration: 43,
              refreshTrigger: "graph-ready",
              seed: SEED,
              rawOnly: false,
              calledAt: 118,
              resolvedAt: 146,
              result: k64FetchResult(K64_CHILD_RESULT),
              ...child,
            },
          ]),
    ],
    commits: [
      { at: 111.5, fetchSeq: 1, loading: false, display: "parent" },
      { at: 117.5, fetchSeq: 1, loading: true, display: "parent" },
      ...(child === null
        ? []
        : [{ at: 146, fetchSeq: 2, loading: false, display: "child" }]),
    ],
    notices: child === null ? [] : [{ kind: "graph-ready", at: 117 }],
    api: [
      k64Api("related_scenes_begin", 60, 80),
      k64Api("related_scenes_continue", 100.5, 103),
      k64Api("related_scenes_graph_continue", 100.5, 130, {
        status: "unavailable",
        reason: "cancelled",
      }),
      k64Api("related_scenes_graph_continue", 110.85, 112, {
        settle: "unused",
      }),
      ...(child === null
        ? []
        : [
            k64Api("related_scenes_begin", 118.5, 120),
            k64Api("related_scenes_continue", 125.2, 131),
            k64Api("related_scenes_graph_continue", 125.2, 139, {
              status: "available",
            }),
            k64Api("related_scenes_graph_continue", 145, 146, {
              settle: "used",
            }),
          ]),
    ],
    ...rest,
  };
}

export function k64NativeRecord(overrides = {}) {
  return {
    seq: 1,
    tBeginNs: 1_000_000,
    tReturnedNs: 2_000_000,
    startSlot: {
      kind: "empty",
      readyFresh: false,
      preparesReady: 3,
      readyGeneration: 3,
    },
    cacheOccupiedAtBegin: false,
    begin: "pending",
    reason: null,
    busyCause: null,
    ticket: {
      tTicketNs: 1_500_000,
      settled: true,
      tSettledNs: 21_000_000,
      outcome: "available",
      reason: null,
      disposition: "unused",
      busyCause: null,
      freshnessStamp: {
        attemptedAtNs: 15_000_000,
        result: "fresh",
        matched: true,
      },
    },
    ...overrides,
  };
}

export const K64_CACHED_CHILD = k64NativeRecord({
  seq: 2,
  tBeginNs: 90_000_000,
  tReturnedNs: 90_500_000,
  startSlot: {
    kind: "preparing",
    readyFresh: false,
    preparesReady: 3,
    readyGeneration: 3,
  },
  begin: "cached",
  ticket: null,
});

export const k64Diagnostics = (begins, cacheHits, lateCached, extra = {}) => ({
  begins,
  cacheHits,
  lateCached,
  quarantines: 0,
  deferredReleased: 0,
  deferredExpired: 0,
  deferredDropped: 0,
  staleReadyRetired: 0,
  prepareFailures: 0,
  driftAtQuery: 0,
  stamp0Missing: 0,
  ...extra,
});

/** S1f: the k64GraphSampleRow input of one synthetic steady-state sample. */
export function k64HookInput(overrides = {}) {
  return {
    variantKey: "dev:dev-lantern.v1/base",
    phase: "measured",
    repeat: 0,
    d2aMode: "restricted",
    observation: k64Observation(),
    nativeRecords: [k64NativeRecord(), K64_CACHED_CHILD],
    a3: null,
    r1: r1Record({
      slot: "empty",
      cacheOccupied: false,
      cacheCleared: 1,
      sinceLastSeededMs: 1_500,
      previousReleaseWithinLimit: true,
      waitedMs: 3,
    }),
    r2: r2Record({ cacheOccupiedAtEnd: false, cleared: false }),
    counters: {
      before: k64Diagnostics(10, 3, 3),
      atEnd: k64Diagnostics(12, 4, 4),
      afterRelease: k64Diagnostics(12, 4, 4, { deferredReleased: 1 }),
    },
    expectedContribution: {
      appendedSceneIds: ["dev-added"],
      pathAttachmentSceneIds: ["dev-b"],
    },
    ...overrides,
  };
}

/**
 * S1g-A (SP/1) / P2-1: one throwaway variant workspace per spec — its own
 * DB (the query Scene and its pins) and its setup receipt (the logical →
 * runtime map and the cold DB's digest) — read back through the sealed
 * loaders (`loadSetupReceipt`, `readQuerySceneSeedPins`). A spec is
 * `{ caseId, variantId, fixtureKind, querySceneLogical, querySceneRuntime,
 * seedLogical, seedRuntime, live, pins: [{ entryId, createdAt, inProject }],
 * entities }`.
 */
/**
 * S1j-2 review P3 (e): the fields a complete frozen setup receipt carries
 * (its measurement point, its seal openings, the setup-only Main's sha).
 */
export const COMPLETE_SETUP_FIELDS = Object.freeze({
  measurementPoint: {
    declared: { graph: "usable", chronicle: "usable" },
    probe: {
      graph: "usable",
      chronicle: "usable",
      metadata: {
        b: { generation: 1, dirty: false },
        chronicle: { generation: 1, dirty: false },
      },
    },
  },
  sealAttempts: [{ session: "seal", attempt: 0, outcome: "sealed" }],
  maintenanceAttempts: [{ attempt: 0, outcome: "reached" }],
  setupMain: { sha256: "e".repeat(64) },
});

export function seedPinWorkspace(spec) {
  const dir = mkdtempSync(path.join(tmpdir(), "cp4-seed-pin-ws-"));
  process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "grimodex.db");
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE tree_nodes (id TEXT PRIMARY KEY, project_id TEXT, node_type TEXT, archived_at TEXT);
    CREATE TABLE codex_entries (id TEXT PRIMARY KEY, project_id TEXT);
    CREATE TABLE scene_codex_pins (scene_id TEXT, entry_id TEXT, created_at TEXT);
  `);
  const projectId = spec.projectId ?? "p";
  for (const sceneId of [spec.querySceneRuntime, ...(spec.otherScenes ?? [])])
    db.prepare("INSERT INTO tree_nodes VALUES (?, ?, 'scene', ?)").run(
      sceneId,
      projectId,
      sceneId === spec.querySceneRuntime && spec.live === false
        ? "2026-10-27T00:00:00Z"
        : null,
    );
  const entries = new Map();
  for (const pin of spec.pins) {
    entries.set(pin.entryId, pin.inProject === false ? "p-other" : projectId);
    db.prepare("INSERT INTO scene_codex_pins VALUES (?, ?, ?)").run(
      pin.sceneId ?? spec.querySceneRuntime,
      pin.entryId,
      pin.createdAt,
    );
  }
  for (const [id, project] of entries)
    db.prepare("INSERT INTO codex_entries VALUES (?, ?)").run(id, project);
  db.close();
  const setupPath = path.join(dir, "setup-receipt.json");
  writeFileSync(
    setupPath,
    `${JSON.stringify({
      // S1i: a frozen setup uses the frozen schema and names where it stopped.
      ...((spec.fixtureKind ?? "frozen") === "frozen"
        ? {
            schemaVersion: FROZEN_SETUP_RECEIPT_SCHEMA,
            stopsAt: spec.stopsAt ?? "seed-pin",
            status: SETUP_STATUS_BY_STOP[spec.stopsAt ?? "seed-pin"],
            // S1j P2-4: a ① setup names its R5 check run.
            ...((spec.stopsAt ?? "seed-pin") === "seed-pin"
              ? { r5CheckRun: { id: spec.r5CheckRunId ?? "r5-test-run" } }
              : COMPLETE_SETUP_FIELDS),
          }
        : {
            schemaVersion: DEV_SETUP_RECEIPT_SCHEMA,
            status: "setup-complete",
          }),
      fixture: {
        kind: spec.fixtureKind ?? "frozen",
        caseId: spec.caseId,
        variantId: spec.variantId ?? null,
      },
      logicalToRuntime: {
        projectId,
        querySceneId: spec.querySceneLogical,
        scenes: { [spec.querySceneLogical]: spec.querySceneRuntime },
        entities: { [spec.seedLogical]: spec.seedRuntime, ...spec.entities },
      },
      coldDatabase: {
        path: file,
        sha256: createHash("sha256").update(readFileSync(file)).digest("hex"),
      },
    })}\n`,
  );
  return {
    dir,
    file,
    setup: loadSetupReceipt({ file: setupPath }),
    read: readQuerySceneSeedPins(
      file,
      projectId,
      spec.readSceneId ?? spec.querySceneRuntime,
    ),
  };
}

/**
 * S1i: a fake harness page over a throwaway workspace SQLite that plays the
 * product writers the frozen setup driver calls (the renderer API and the
 * IPC commands of setupOrder up to the seed pin step), with the product's
 * Scope rules the setup relies on (an unknown marker keeps an unresolved
 * query identity, exact refs are registered, a character holder is a
 * character entry of the project). Every other IPC command and page entry
 * (maintenance, typed Revisions, the Index builds, queries, the declaration,
 * the probes) is recorded in `forbidden` and refused. `opts.mutate(name,
 * input)` may rewrite a writer's input (to test the read-back checks);
 * `opts.maintenanceEnabled` leaves the runtime policy's maintenance on.
 */
export function frozenSetupFakeProduct(opts = {}) {
  let db = null;
  let file = null;
  let clock = 0;
  const at = () =>
    new Date(Date.UTC(2026, 9, 27, 0, 0, 0, ++clock)).toISOString();
  const calls = [];
  const forbidden = [];
  const token = () => `sha256:${"c".repeat(64)}`;
  const UNRESOLVED = { kind: "unresolved", reason: "legacy-axis-unknown" };
  const mutate = opts.mutate ?? ((_name, input) => input);
  const refuse = (name) => {
    forbidden.push(name);
    return { ok: false, error: `${name} is not played by the fake product` };
  };
  const open = (workspacePath) => {
    if (db) return;
    mkdirSync(workspacePath, { recursive: true });
    file = path.join(workspacePath, "grimodex.db");
    // S1j-2: a later session reopens the same workspace (the schema stays).
    const reopened = existsSync(file);
    db = new DatabaseSync(file);
    if (reopened) {
      extension?.onOpen?.();
      return;
    }
    db.exec(`
      CREATE TABLE projects (id TEXT PRIMARY KEY, title TEXT, language TEXT, phase_resolution_mode TEXT, updated_at TEXT);
      CREATE TABLE tree_nodes (id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, node_type TEXT, title TEXT,
        sort_order TEXT, version INTEGER, updated_at TEXT, archived_at TEXT, content TEXT,
        story_time_order TEXT, pov_character_id TEXT);
      CREATE TABLE codex_entries (id TEXT PRIMARY KEY, project_id TEXT, type TEXT, name TEXT, summary TEXT);
      CREATE TABLE codex_relations (id TEXT PRIMARY KEY, project_id TEXT, from_codex_id TEXT, to_codex_id TEXT,
        relation_type TEXT, label TEXT, directionality TEXT, version INTEGER DEFAULT 1, updated_at TEXT);
      CREATE TABLE scene_codex_pins (scene_id TEXT, entry_id TEXT, created_at TEXT, PRIMARY KEY (scene_id, entry_id));
      CREATE TABLE foreshadows (id TEXT PRIMARY KEY, project_id TEXT, title TEXT, secret INTEGER, payoff_scene_id TEXT,
        payoff_confirmed INTEGER, abandoned INTEGER, version INTEGER);
      CREATE TABLE foreshadow_codex_links (foreshadow_id TEXT, codex_entry_id TEXT);
      CREATE TABLE narrative_scope_registries (project_id TEXT PRIMARY KEY, registry_version TEXT, timeline_refs_json TEXT,
        worldline_refs_json TEXT, narrative_layer_refs_json TEXT, version INTEGER, source_token TEXT, updated_at TEXT);
      CREATE TABLE narrative_scene_scope_bindings (project_id TEXT, scene_id TEXT, scene_incarnation_id TEXT,
        compatibility_marker TEXT, query_identity_json TEXT, material_constraint_json TEXT, knowledge_holder_json TEXT,
        audience_json TEXT, version INTEGER, source_token TEXT, updated_at TEXT, body_declaration_json TEXT,
        body_declaration_token TEXT);
    `);
    // `opts.maintenanceEnabled`: a workspace whose runtime policy has
    // maintenance on (a setting ① must never make, nor accept).
    if (opts.maintenanceEnabled)
      db.exec(`
        CREATE TABLE narrative_runtime_policy (singleton_id INTEGER PRIMARY KEY, maintenance_enabled INTEGER);
        INSERT INTO narrative_runtime_policy VALUES (1, 1);
      `);
    extension?.onOpen?.();
  };
  const one = (sql, ...params) => db.prepare(sql).get(...params);
  const registryOf = (projectId) => {
    const row = one(
      "SELECT * FROM narrative_scope_registries WHERE project_id = ?",
      projectId,
    );
    return {
      revision: row.version,
      registry: {
        registryVersion: row.registry_version,
        timelineRefs: JSON.parse(row.timeline_refs_json),
        worldlineRefs: JSON.parse(row.worldline_refs_json),
        narrativeLayerRefs: JSON.parse(row.narrative_layer_refs_json),
      },
    };
  };
  const ipc = {
    db_execute: (input) => {
      if (input.method !== "all" || !/^\s*SELECT\b/iu.test(input.sql))
        return refuse("db_execute:write");
      return { rows: db.prepare(input.sql).all(...(input.params ?? [])) };
    },
    project_patch: ({ payload }) => {
      db.prepare(
        "UPDATE projects SET phase_resolution_mode = ?, updated_at = ? WHERE id = ?",
      ).run(payload.patch.phaseResolutionMode, at(), payload.projectId);
      return true;
    },
    tree_node_create: ({ payload }) => {
      const now = at();
      db.prepare(
        "INSERT INTO tree_nodes VALUES (?, ?, ?, ?, ?, ?, 1, ?, NULL, ?, ?, ?)",
      ).run(
        payload.id,
        payload.projectId,
        payload.parentId,
        payload.nodeType,
        payload.title,
        payload.sortOrder,
        now,
        payload.content,
        payload.storyTimeOrder ?? null,
        payload.povCharacterId ?? null,
      );
      // A folder has no Scene Scope binding (the product binds Scenes).
      if (payload.nodeType !== "scene") return { id: payload.id };
      db.prepare(
        "INSERT INTO narrative_scene_scope_bindings VALUES (?, ?, ?, 'unknown', ?, ?, ?, ?, 1, ?, ?, NULL, NULL)",
      ).run(
        payload.projectId,
        payload.id,
        `inc-${payload.id}`,
        JSON.stringify({
          timeline: UNRESOLVED,
          worldline: UNRESOLVED,
          narrativeLayer: UNRESOLVED,
        }),
        JSON.stringify({
          timeline: { kind: "any" },
          worldline: { kind: "any" },
          narrativeLayer: { kind: "any" },
        }),
        JSON.stringify({ kind: "reader" }),
        JSON.stringify({ kind: "reader" }),
        token(),
        now,
      );
      return { id: payload.id };
    },
    narrative_scene_scope_read: ({ projectId, sceneId }) => {
      const { revision, registry } = registryOf(projectId);
      const row = one(
        "SELECT * FROM narrative_scene_scope_bindings WHERE project_id = ? AND scene_id = ?",
        projectId,
        sceneId,
      );
      return {
        registry,
        registryRevision: revision,
        binding: {
          compatibilityMarker: row.compatibility_marker,
          version: row.version,
        },
      };
    },
    narrative_scene_scope_registry_update: ({ payload }) => {
      const { revision } = registryOf(payload.projectId);
      if (payload.baseVersion !== revision) throw new Error("registry OCC");
      db.prepare(
        `UPDATE narrative_scope_registries SET timeline_refs_json = ?, worldline_refs_json = ?,
           narrative_layer_refs_json = ?, version = version + 1, updated_at = ? WHERE project_id = ?`,
      ).run(
        JSON.stringify(payload.registry.timelineRefs),
        JSON.stringify(payload.registry.worldlineRefs),
        JSON.stringify(payload.registry.narrativeLayerRefs),
        at(),
        payload.projectId,
      );
      return true;
    },
    narrative_scene_scope_update: ({ payload }) => {
      const { registry } = registryOf(payload.projectId);
      const row = one(
        "SELECT version FROM narrative_scene_scope_bindings WHERE project_id = ? AND scene_id = ?",
        payload.projectId,
        payload.sceneId,
      );
      if (payload.baseVersion !== row.version) throw new Error("scope OCC");
      const scope = payload.scope;
      const axes = [
        ["timeline", "timelineRefs"],
        ["worldline", "worldlineRefs"],
        ["narrativeLayer", "narrativeLayerRefs"],
      ];
      if (
        scope.compatibilityMarker === "unknown" &&
        !axes.every(([axis]) => scope.queryIdentity[axis].kind === "unresolved")
      )
        throw new Error(
          "unknown scope must leave extension query identity unresolved",
        );
      for (const part of ["queryIdentity", "materialConstraint"])
        for (const [axis, refs] of axes) {
          const value = scope[part][axis];
          if (value.kind === "exact" && !registry[refs].includes(value.ref))
            throw new Error(`${part}.${axis} references an unregistered value`);
        }
      for (const principal of [scope.knowledgeHolder, scope.audience])
        if (
          principal.kind === "character" &&
          !one(
            "SELECT 1 AS ok FROM codex_entries WHERE id = ? AND project_id = ? AND type = 'character'",
            principal.ref,
            payload.projectId,
          )
        )
          throw new Error("character is not in project");
      db.prepare(
        `UPDATE narrative_scene_scope_bindings SET compatibility_marker = ?, query_identity_json = ?,
           material_constraint_json = ?, knowledge_holder_json = ?, audience_json = ?, version = version + 1,
           updated_at = ? WHERE project_id = ? AND scene_id = ?`,
      ).run(
        scope.compatibilityMarker,
        JSON.stringify(scope.queryIdentity),
        JSON.stringify(scope.materialConstraint),
        JSON.stringify(scope.knowledgeHolder),
        JSON.stringify(scope.audience),
        at(),
        payload.projectId,
        payload.sceneId,
      );
      return true;
    },
  };
  const api = {
    createProject: (input) => {
      db.prepare("INSERT INTO projects VALUES (?, ?, ?, 'story', ?)").run(
        input.id,
        input.title,
        input.language,
        at(),
      );
      db.prepare(
        "INSERT INTO narrative_scope_registries VALUES (?, 'narrative-scene-scope-registry/1', '[]', '[]', '[]', 1, ?, ?)",
      ).run(input.id, token(), at());
      return input.id;
    },
    createCodexEntry: (input) => {
      db.prepare("INSERT INTO codex_entries VALUES (?, ?, ?, ?, ?)").run(
        input.id,
        input.projectId,
        input.type,
        input.name,
        input.summary,
      );
      return { id: input.id };
    },
    createCodexRelation: (input) => {
      if (!input.label) throw new Error("label is required");
      extension?.beforeRelationCreate?.(input);
      db.prepare(
        "INSERT INTO codex_relations VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)",
      ).run(
        input.id,
        input.projectId,
        input.fromCodexId,
        input.toCodexId,
        input.relationType,
        input.label,
        input.directionality,
        at(),
      );
      extension?.afterWrite?.();
      return { id: extension?.reportedRelationId?.(input.id) ?? input.id };
    },
    createForeshadow: (input) => {
      db.prepare("INSERT INTO foreshadows VALUES (?, ?, ?, ?, ?, ?, ?, 1)").run(
        input.id,
        input.projectId,
        input.title,
        input.secret ? 1 : 0,
        input.payoffSceneId,
        input.payoffConfirmed ? 1 : 0,
        input.abandoned ? 1 : 0,
      );
      return { id: input.id, version: 1 };
    },
    addForeshadowCodexLink: (input) => {
      const row = one(
        "SELECT version FROM foreshadows WHERE id = ?",
        input.foreshadowId,
      );
      if (row.version !== input.baseVersion) throw new Error("foreshadow OCC");
      db.prepare("INSERT INTO foreshadow_codex_links VALUES (?, ?)").run(
        input.foreshadowId,
        input.codexId,
      );
      db.prepare(
        "UPDATE foreshadows SET version = version + 1 WHERE id = ?",
      ).run(input.foreshadowId);
      return { version: row.version + 1 };
    },
    upsertScenePin: (input) => {
      db.prepare("INSERT OR IGNORE INTO scene_codex_pins VALUES (?, ?, ?)").run(
        input.sceneId,
        input.entryId,
        at(),
      );
      return true;
    },
    sceneText: (sceneId) => {
      const content = JSON.parse(
        one("SELECT content FROM tree_nodes WHERE id = ?", sceneId).content,
      );
      return `${content.content.map((block) => block.content[0].text).join("\n")}\n`;
    },
  };
  // S1j-2: `opts.extend` plays the complete setup's writers on the same DB.
  const extension = opts.extend
    ? opts.extend({ db: () => db, file: () => file, at, refuse })
    : null;
  Object.assign(ipc, extension?.ipc ?? {});
  Object.assign(api, extension?.api ?? {});
  const wrap = (name, run) => async (input) => {
    calls.push(name);
    try {
      return { ok: true, value: await run(mutate(name, input)) };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  };
  const forbiddenEntry = (name) => async () => refuse(name);
  const window = {
    cp4Harness: {
      ready: true,
      call: async (name, input) => {
        if (!Object.hasOwn(ipc, name)) {
          calls.push(name);
          return refuse(name);
        }
        return wrap(name, ipc[name])(input);
      },
      openWorkspace: wrap("openWorkspace", (input) => {
        open(input.workspacePath);
        return { openRevision: 1 };
      }),
      selectProject: wrap("selectProject", () => ({ nodeCount: 0 })),
      api: {
        ...Object.fromEntries(
          Object.entries(api).map(([name, run]) => [
            name,
            wrap(`api.${name}`, run),
          ]),
        ),
        humanWriteContext: () => {
          calls.push("api.humanWriteContext");
          return { actor: "human" };
        },
        ...(extension?.api?.updateCodexEntrySummary
          ? {}
          : {
              updateCodexEntrySummary: forbiddenEntry(
                "api.updateCodexEntrySummary",
              ),
            }),
      },
      ...(extension?.chronicle
        ? {
            chronicle: Object.fromEntries(
              Object.entries(extension.chronicle).map(([name, run]) => [
                name,
                wrap(`chronicle.${name}`, run),
              ]),
            ),
          }
        : {}),
      measure: forbiddenEntry("measure"),
      buildRaw: forbiddenEntry("buildRaw"),
      buildIndex: extension?.buildIndex
        ? async (input) => {
            calls.push("buildIndex");
            return extension.buildIndex(input);
          }
        : forbiddenEntry("buildIndex"),
      declaration: {
        state: forbiddenEntry("declaration.state"),
        declare: forbiddenEntry("declaration.declare"),
      },
      k64: { sample: forbiddenEntry("k64.sample") },
      hook: { sample: forbiddenEntry("hook.sample") },
    },
  };
  return {
    calls,
    forbidden,
    extension,
    file: () => file,
    close: () => {
      db?.close();
      db = null;
    },
    page: {
      evaluate: async (fn, arg) => {
        globalThis.window = window;
        try {
          return await fn(arg);
        } finally {
          delete globalThis.window;
        }
      },
    },
  };
}

/**
 * S1j-2: the complete setup's writers on `frozenSetupFakeProduct`'s DB, for
 * `opts.extend`. Plays the runtime policy and the semantic epoch, the typed
 * Revision prepare／Decision／read (a Revision goes stale when a Relation or
 * Entity it bound changes), the AI settings, the Chronicle dialog route
 * (extract → nonsecret child → Decision; only in a session launched with
 * the setup-only Main, answering from `irSeeds` by the Scene body), the
 * review bundle, the summary edit, the Relation delete, and the Index
 * metadata: a seam session's workspace open publishes B, `buildIndex`
 * publishes C, every write after maintenance dirties both. `beginSession`
 * is called by the test's session factory with the session's label, seam
 * and setup-only Main. Options: `refuseRelationIdReuse`, `extraContext`
 * (a third context in the IR envelope), `bStaysDirty`, `bDirtiedByQuery`
 * (B goes dirty again after the seal, as the dev check saw), `sealMissesOpens`
 * (the first seam opens publish no B, as the dev check's P-0 saw).
 */
export function completeSetupExtension({
  irSeeds,
  refuseRelationIdReuse = false,
  extraContext = false,
  bStaysDirty = false,
  bDirtiedByQuery = false,
  bDirtiedByQueryTimes = Infinity,
  sealMissesOpens = 0,
  buildIndexFails = false,
  relationCreateError = null,
  revisionStaysAvailable = false,
  recreatedReportsOtherId = false,
  cutoverMissesOpens = 0,
  queryDirtiesC = false,
  buildIndexFailsIn = null,
  // DR-CP4-T-3: the product's Change Feed and Freshness. Each mutation the
  // fake plays appends a feed event; `freshnessTick()` (the tests' sleep)
  // acknowledges the feed and, in the same write, dirties B and C (as
  // `suspend_project_in_tx`) unless `settles` is false.
  freshness = null,
  // DR-CP4-T-5: a maintenance Verify that is `running` when a session in
  // `verify.sessions` begins; the tests' sleep completes it unless
  // `verify.settles` is false.
  verify = null,
}) {
  return ({ db, at }) => {
    let session = { label: "author", seam: false, setupMain: null };
    let seamOpens = 0;
    const indexInputs = [];
    // P-5: the cutover marker is written by the opening after the first
    // `cutoverMissesOpens` (the setting and each later open count).
    let cutoverAttempts = 0;
    const policySets = [];
    const maybeCutover = () => {
      if (cutoverAttempts++ < cutoverMissesOpens) return;
      run(
        "INSERT INTO schema_data_migrations VALUES ('narrative-c2-canonical-freshness-v1', '1')",
      );
    };
    let dirtiedByQuery = 0;
    let counter = 0;
    const id = (prefix) => `${prefix}-${String(++counter).padStart(4, "0")}`;
    const deleted = new Set();
    const revisions = new Map();
    const indexCalls = [];
    let ai = {
      provider: "openrouter",
      model: "",
      ollamaEndpoint: "http://localhost:11434",
    };
    const one = (sql, ...params) =>
      db()
        .prepare(sql)
        .get(...params);
    const run = (sql, ...params) =>
      db()
        .prepare(sql)
        .run(...params);
    const maintenanceOn = () =>
      Number(
        one("SELECT maintenance_enabled AS m FROM narrative_runtime_policy")
          ?.m ?? 0,
      ) === 1;
    const dirtyAll = () => {
      feedEvent();
      if (!maintenanceOn()) return;
      run("UPDATE narrative_semantic_index_metadata SET dirty_cache_flag = 1");
    };
    let feedHead = 0;
    function feedEvent() {
      if (!freshness) return;
      const projectId = projectOf();
      feedHead += 1;
      run(
        "INSERT INTO narrative_change_events VALUES (?, ?, ?, 0)",
        `feed-${feedHead}`,
        projectId,
        feedHead,
      );
    }
    let verifyRuns = 0;
    let verifyPending = false;
    const startVerify = () => {
      verifyRuns += 1;
      run(
        "INSERT INTO narrative_extraction_runs VALUES (?, ?, 'dependency-verify', 'running', ?)",
        `verify-${verifyRuns}`,
        projectOf(),
        at(),
      );
    };
    const freshnessTick = () => {
      if (verify?.settles)
        run(
          "UPDATE narrative_extraction_runs SET status = 'completed' WHERE surface_path_id = 'dependency-verify' AND status = 'running'",
        );
      if (!freshness?.settles || feedHead === 0) return;
      const projectId = projectOf();
      const cursor = one(
        "SELECT acknowledged_through_sequence AS ack FROM narrative_change_cursors WHERE project_id = ?",
        projectId,
      );
      if (cursor?.ack === feedHead) return;
      if (cursor)
        run(
          "UPDATE narrative_change_cursors SET acknowledged_through_sequence = ? WHERE project_id = ?",
          feedHead,
          projectId,
        );
      else
        run(
          "INSERT INTO narrative_change_cursors VALUES (?, 'narrative-incremental-freshness/v1', ?, NULL, NULL)",
          projectId,
          feedHead,
        );
      run(
        "UPDATE narrative_semantic_index_metadata SET dirty_cache_flag = 1 WHERE project_id = ?",
        projectId,
      );
    };
    const publish = (projectId, key) => {
      const row = one(
        "SELECT generation FROM narrative_semantic_index_metadata WHERE project_id = ? AND index_key = ?",
        projectId,
        key,
      );
      if (row)
        run(
          "UPDATE narrative_semantic_index_metadata SET generation = generation + 1, dirty_cache_flag = 0 WHERE project_id = ? AND index_key = ?",
          projectId,
          key,
        );
      else
        run(
          "INSERT INTO narrative_semantic_index_metadata VALUES (?, ?, 1, 0, 'sha256:s', 'sha256:d', 'p', 'v')",
          projectId,
          key,
        );
    };
    const token = (table, rowId) =>
      JSON.stringify(
        db().prepare(`SELECT * FROM ${table} WHERE id = ?`).get(rowId) ?? null,
      );
    const projectOf = () => one("SELECT id FROM projects")?.id ?? null;
    const proposalRows = (runId) =>
      db()
        .prepare(
          `SELECT p.id, p.current_revision_id FROM narrative_proposals p
             JOIN narrative_proposal_sets s ON s.id = p.proposal_set_id WHERE s.run_id = ?`,
        )
        .all(runId);
    const latestDecision = (proposalId) =>
      db()
        .prepare(
          "SELECT id AS decisionId, decision FROM narrative_proposal_decisions WHERE proposal_id = ? ORDER BY created_at DESC, id DESC LIMIT 1",
        )
        .get(proposalId) ?? null;
    const projection = { runId: null };
    const projected = () => ({
      projectionRunId: projection.runId,
      proposals: proposalRows(projection.runId).map((row) => {
        const revision = one(
          "SELECT payload_json FROM narrative_proposal_revisions WHERE id = ?",
          row.current_revision_id,
        );
        const status = one(
          "SELECT status FROM narrative_proposals WHERE id = ?",
          row.id,
        ).status;
        return {
          proposalId: row.id,
          revisionId: row.current_revision_id,
          status,
          applicability: "applicable",
          secret: JSON.parse(revision.payload_json).disclosure.secret,
          applied: false,
        };
      }),
    });
    const decide = (proposalId, revisionId, decision, createdBy) => {
      run(
        "INSERT INTO narrative_proposal_decisions VALUES (?, ?, ?, ?, ?, ?)",
        id("decision"),
        proposalId,
        revisionId,
        decision,
        createdBy,
        at(),
      );
      run(
        "UPDATE narrative_proposals SET status = ? WHERE id = ?",
        decision,
        proposalId,
      );
      dirtyAll();
    };
    const requireIrSession = () => {
      if (session.label !== "ir" || !session.setupMain)
        throw new Error(
          "the deterministic provider answers only in the setup-only Main",
        );
      if (ai.provider !== "ollama")
        throw new Error("no AI provider is configured");
    };
    return {
      indexCalls,
      policySets,
      freshnessTick,
      appendFeedEvent: () => feedEvent(),
      startVerify: () => startVerify(),
      beginSession(next) {
        session = { ...next };
        verifyPending = Boolean(verify?.sessions?.includes(next.label));
      },
      onOpen() {
        db().exec(`
          CREATE TABLE IF NOT EXISTS narrative_runtime_policy (singleton_id INTEGER PRIMARY KEY, maintenance_enabled INTEGER, version INTEGER);
          INSERT OR IGNORE INTO narrative_runtime_policy VALUES (1, 0, 1);
          CREATE TABLE IF NOT EXISTS narrative_revision_source_basis (revision_id TEXT, source_key TEXT, revision_token TEXT);
          CREATE TABLE IF NOT EXISTS narrative_semantic_epochs (id TEXT, project_id TEXT, epoch_number INTEGER, reason TEXT);
          CREATE TABLE IF NOT EXISTS schema_data_migrations (migration_id TEXT, contract_version TEXT);
          CREATE TABLE IF NOT EXISTS narrative_semantic_index_metadata (project_id TEXT, index_key TEXT, generation INTEGER,
            dirty_cache_flag INTEGER, source_digest TEXT, dependency_set_digest TEXT, producer_id TEXT, producer_version TEXT);
          CREATE TABLE IF NOT EXISTS narrative_extraction_runs (id TEXT PRIMARY KEY, project_id TEXT, surface_path_id TEXT,
            status TEXT, created_at TEXT);
          CREATE TABLE IF NOT EXISTS narrative_proposal_sets (id TEXT PRIMARY KEY, run_id TEXT);
          CREATE TABLE IF NOT EXISTS narrative_proposals (id TEXT PRIMARY KEY, proposal_set_id TEXT, status TEXT, current_revision_id TEXT);
          CREATE TABLE IF NOT EXISTS narrative_proposal_revisions (id TEXT PRIMARY KEY, proposal_id TEXT, revision_number INTEGER,
            payload_json TEXT, reconciliation_envelope_json TEXT);
          CREATE TABLE IF NOT EXISTS narrative_proposal_decisions (id TEXT PRIMARY KEY, proposal_id TEXT, revision_id TEXT,
            decision TEXT, created_by TEXT, created_at TEXT);
          CREATE TABLE IF NOT EXISTS narrative_change_events (id TEXT PRIMARY KEY, project_id TEXT, canonical_sequence INTEGER,
            event_ordinal INTEGER);
          CREATE TABLE IF NOT EXISTS narrative_change_cursors (project_id TEXT, consumer_id TEXT,
            acknowledged_through_sequence INTEGER, active_run_id TEXT, reserved_through_sequence INTEGER);
        `);
        // P-5: a reopening runs the cutover again while the marker is absent.
        if (
          maintenanceOn() &&
          !one(
            "SELECT 1 AS ok FROM schema_data_migrations WHERE migration_id = 'narrative-c2-canonical-freshness-v1'",
          )
        )
          maybeCutover();
        // A seam session's workspace-opened wake publishes B.
        const projectId = projectOf();
        // DR-CP4-T-5: a Verify the session's opening leaves running.
        if (verifyPending && projectId) {
          verifyPending = false;
          startVerify();
        }
        // `sealMissesOpens`: the first seam opens publish nothing (P-0).
        if (
          session.seam &&
          projectId &&
          maintenanceOn() &&
          seamOpens++ < sealMissesOpens
        ) {
          run(
            "INSERT INTO narrative_extraction_runs VALUES (?, ?, 'dependency-verify', 'completed', ?)",
            id("verify"),
            projectId,
            new Date().toISOString(),
          );
          return;
        }
        if (session.seam && projectId && maintenanceOn()) {
          const b = one(
            "SELECT dirty_cache_flag AS dirty FROM narrative_semantic_index_metadata WHERE project_id = ? AND index_key = ?",
            projectId,
            "nir1-reviewed-entity-relation:v1",
          );
          if (!b || Number(b.dirty) === 1)
            publish(projectId, "nir1-reviewed-entity-relation:v1");
          if (bStaysDirty) dirtyAll();
        }
      },
      afterWrite: dirtyAll,
      // The writer's answer names another ID for a recreated Relation.
      reportedRelationId: (relationId) =>
        recreatedReportsOtherId && deleted.has(relationId)
          ? `${relationId}-other`
          : null,
      beforeRelationCreate(input) {
        if (relationCreateError && deleted.has(input.id))
          throw new Error(relationCreateError);
        if (refuseRelationIdReuse && deleted.has(input.id))
          throw new Error("UNIQUE constraint failed: codex_relations.id");
      },
      ipc: {
        narrative_runtime_policy_get: () => ({
          version: 1,
          runtimeMode: "normal",
          maintenanceEnabled: maintenanceOn(),
          genericImportEnabled: false,
          backgroundAiEnabled: false,
        }),
        narrative_runtime_policy_set: ({ payload }) => {
          run(
            "UPDATE narrative_runtime_policy SET maintenance_enabled = ?, version = version + 1",
            payload.maintenanceEnabled ? 1 : 0,
          );
          const projectId = projectOf();
          run(
            "INSERT INTO narrative_semantic_epochs VALUES ('epoch-1', ?, 1, 'initial')",
            projectId,
          );
          maybeCutover();
          policySets.push(payload);
          return { maintenanceEnabled: payload.maintenanceEnabled };
        },
        narrative_extraction_capture_workspace_binding: () => ({
          binding: "ws",
        }),
        nir1_entity_relation_revision_prepare: ({ payload }) => {
          const runId = id("typed-run");
          revisions.set(runId, {
            decision: null,
            tokens: [
              ...payload.entityIds.map((row) => token("codex_entries", row)),
              ...payload.relationIds.map((row) =>
                token("codex_relations", row),
              ),
            ],
            entityIds: payload.entityIds,
            relationIds: payload.relationIds,
          });
          const revisionId = id("typed-revision");
          for (const relationId of payload.relationIds) {
            const row = one(
              "SELECT version, updated_at AS updatedAt FROM codex_relations WHERE id = ?",
              relationId,
            );
            run(
              "INSERT INTO narrative_revision_source_basis VALUES (?, ?, ?)",
              revisionId,
              `codex-relation:${relationId}`,
              `v${row.version}@${row.updatedAt}:relation:${relationId}`,
            );
          }
          return {
            runId,
            status: "draft",
            receipt: { proposalId: id("typed-proposal"), revisionId },
          };
        },
        narrative_extraction_append_human_decision: ({ payload }) => {
          revisions.get(payload.runId).decision = payload.decision;
          dirtyAll();
          return true;
        },
        nir1_entity_relation_revision_read_current: ({ runId }) => {
          const revision = revisions.get(runId);
          const now = [
            ...revision.entityIds.map((row) => token("codex_entries", row)),
            ...revision.relationIds.map((row) => token("codex_relations", row)),
          ];
          if (
            !revisionStaysAvailable &&
            JSON.stringify(now) !== JSON.stringify(revision.tokens)
          )
            return { status: "unavailable" };
          return {
            status:
              revision.decision === "approved"
                ? "available"
                : (revision.decision ?? "draft"),
          };
        },
        get_ai_settings: () => ({ ...ai, apiKeyPresent: false }),
        save_ai_settings: ({ settings }) => {
          ai = {
            provider: settings.provider,
            model: settings.model,
            ollamaEndpoint: settings.ollamaEndpoint,
          };
          return true;
        },
        narrative_extraction_get_run_review_bundle: ({ payload }) => ({
          proposals: proposalRows(payload.runId).map((row) => ({
            proposalId: row.id,
            currentRevisionId: row.current_revision_id,
            latestDecision: latestDecision(row.id),
          })),
        }),
      },
      api: {
        updateCodexEntrySummary: (input) => {
          run(
            "UPDATE codex_entries SET summary = ? WHERE id = ?",
            input.summary,
            input.id,
          );
          dirtyAll();
          return true;
        },
        deleteCodexRelation: (input) => {
          run("DELETE FROM codex_relations WHERE id = ?", input.id);
          deleted.add(input.id);
          dirtyAll();
          return true;
        },
      },
      chronicle: {
        extract: ({ projectId, folderId }) => {
          requireIrSession();
          const scenes = db()
            .prepare(
              "SELECT id, content FROM tree_nodes WHERE parent_id = ? AND node_type = 'scene' ORDER BY sort_order",
            )
            .all(folderId);
          const runId = id("chronicle-run");
          run(
            "INSERT INTO narrative_extraction_runs VALUES (?, ?, 'chronicle.extract', 'completed', ?)",
            runId,
            projectId,
            new Date().toISOString(),
          );
          const setId = id("set");
          run(
            "INSERT INTO narrative_proposal_sets VALUES (?, ?)",
            setId,
            runId,
          );
          for (const scene of scenes) {
            const body = JSON.parse(scene.content).content[0].content[0].text;
            const seed = irSeeds.get(body);
            if (!seed) throw new Error("the provider returned no observation");
            const proposalId = id("proposal");
            const revisionId = id("root");
            run(
              "INSERT INTO narrative_proposal_revisions VALUES (?, ?, 1, ?, ?)",
              revisionId,
              proposalId,
              JSON.stringify({ disclosure: { secret: true } }),
              JSON.stringify({
                revisionBasis: {
                  contextSet: [
                    { contextId: "event-cluster:c" },
                    { contextId: "event-observation:o" },
                    ...(extraContext ? [{ contextId: "codex-entry:x" }] : []),
                  ],
                },
                assertion: {
                  scope: { scene: { ref: `scene:${scene.id}` } },
                  payload: { ...seed },
                },
              }),
            );
            run(
              "INSERT INTO narrative_proposals VALUES (?, ?, 'unreviewed', ?)",
              proposalId,
              setId,
              revisionId,
            );
          }
          projection.runId = runId;
          return {
            runId,
            sceneIds: scenes.map((scene) => scene.id),
            ...projected(),
          };
        },
        revise: ({ proposalId, secret }) => {
          requireIrSession();
          const current = one(
            "SELECT current_revision_id AS id FROM narrative_proposals WHERE id = ?",
            proposalId,
          ).id;
          const parent = one(
            "SELECT revision_number AS n, reconciliation_envelope_json AS e FROM narrative_proposal_revisions WHERE id = ?",
            current,
          );
          const child = id("child");
          run(
            "INSERT INTO narrative_proposal_revisions VALUES (?, ?, ?, ?, ?)",
            child,
            proposalId,
            parent.n + 1,
            JSON.stringify({ disclosure: { secret } }),
            parent.e,
          );
          run(
            "UPDATE narrative_proposals SET current_revision_id = ? WHERE id = ?",
            child,
            proposalId,
          );
          return projected();
        },
        decide: ({ proposalId, status }) => {
          requireIrSession();
          const current = one(
            "SELECT current_revision_id AS id FROM narrative_proposals WHERE id = ?",
            proposalId,
          ).id;
          decide(proposalId, current, status, "chronicle-extract-dialog");
          return projected();
        },
        recordDecision: (input) => {
          decide(
            input.proposalId,
            input.revisionId,
            input.decision,
            "chronicle-extract-dialog",
          );
          return true;
        },
      },
      indexInputs,
      buildIndex: async (input) => {
        indexCalls.push(session.label);
        indexInputs.push(input);
        if (
          buildIndexFails ||
          (buildIndexFailsIn !== null && session.label === buildIndexFailsIn)
        )
          return { ok: false, durationMs: 1, probes: [] };
        const projectId = projectOf();
        publish(projectId, "nir1-reviewed-chronicle:v1");
        // The product's freshness evaluation can dirty B after its seal.
        if (bDirtiedByQuery && dirtiedByQuery++ < bDirtiedByQueryTimes)
          run(
            queryDirtiesC
              ? "UPDATE narrative_semantic_index_metadata SET dirty_cache_flag = 1 WHERE index_key IN (?, 'nir1-reviewed-chronicle:v1')"
              : "UPDATE narrative_semantic_index_metadata SET dirty_cache_flag = 1 WHERE index_key = ?",
            "nir1-reviewed-entity-relation:v1",
          );
        return {
          ok: true,
          durationMs: 1,
          probes: [
            {
              status: "completed",
              initialSnapshot: { indexUsable: true },
              completion: { outcome: "ir-ready", deadlineExceeded: false },
            },
          ],
        };
      },
    };
  };
}

// ---- S4 の予行（DR-CP4-S4-1）-------------------------------------------------

/** The S2 files of the rehearsal (the paths of `claude/cp4-s2-observation-prep`). */
export const S4_REHEARSAL_FILES = Object.freeze({
  prep: "evals/nir1-graph/observation-prep.v1.json",
  setupAddendum: "evals/nir1-g01/setup-addendum.v2.json",
  declarationAddendum: "evals/nir1-graph/declaration-addendum.v2.json",
  traceEditing: "evals/nir1-graph/trace-editing.v1.json",
  traceBrowsing: "evals/nir1-graph/trace-browsing.v1.json",
  authorDeclaration:
    "evals/nir1-graph/observation-prep-author-declaration.v1.json",
  seedPinAddendum: "evals/nir1-graph/seed-pin-addendum.v2.json",
});
/** The declared Scene of G-02 base in the rehearsal's declaration addendum. */
export const S4_REHEARSAL_G02_DECLARED = "g02-tamsin-first";
const S4_REHEARSAL_K64_TEXT = "K6/4 frozen text (rehearsal)\n";

function rehearsalProcedureText() {
  const base = JSON.parse(
    readFileSync(
      path.join(REPO_ROOT, procedureFilePath(DEV_DRAFT_PROCEDURE_VERSION)),
      "utf8",
    ),
  );
  return `${JSON.stringify(
    {
      ...base,
      version: "v1",
      draft: false,
      values: { ...base.values, r1r4WaitMs: 3_000 },
      review: {
        reviewer: "synthetic-reviewer",
        reviewedAt: "2026-10-30",
        record: "synthetic",
      },
    },
    null,
    2,
  )}\n`;
}

/**
 * S4 の予行（DR-CP4-S4-1）: a throwaway repository with the commits S4 makes
 * (S2 `s4StagesRule`), in order:
 *   ①   the frozen material (`freeze.v1.json`, the G-01 fixture, the K6/4
 *        bytes of an injected T14-type descriptor);
 *   S4a the frozen bytes (the addenda, the trace files, the author's
 *        declaration, the K6/4 procedure v1);
 *   S4b the S2 observation-prep (S2's shape, the minimal fields only: its
 *        placeholders filled with S4a and the SHA-256, `boundFiles` the
 *        array) and the contract's freeze record (`observation-prep-
 *        freeze.v1.json`, `boundFiles` the object path → SHA-256 binding the
 *        S2 file and the files S2 binds);
 *   the candidate (a descendant of S4b).
 * `refs/remotes/origin/master` is S4b. `s2(value, ctx)` and `freeze(value,
 * ctx)` rewrite the two records before they are committed; `s4b` adds files
 * to S4b; `candidate` adds files to the candidate commit (the mutations).
 */
export function s4RehearsalRepository({
  s2 = (value) => value,
  freeze = (value) => value,
  s4b = {},
  candidate = {},
} = {}) {
  const repo = mkdtempSync(path.join(tmpdir(), "cp4-s4-rehearsal-"));
  testGit(repo, "init", "-q", "-b", "main");
  const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const put = (file, bytes) => {
    mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    writeFileSync(path.join(repo, file), bytes);
    testGit(repo, "add", "--", file);
  };
  const commit = (message) => {
    testGit(repo, "commit", "-q", "--no-gpg-sign", "-m", message);
    return testGit(repo, "rev-parse", "HEAD");
  };
  for (const file of [GRAPH_CASE_FREEZE.path, G01_FIXTURE.path])
    put(file, readFileSync(path.join(REPO_ROOT, file)));
  put(K64_FREEZE.path, S4_REHEARSAL_K64_TEXT);
  const base = commit("① frozen material");
  const F = S4_REHEARSAL_FILES;
  const frozenBytes = {
    [F.setupAddendum]: `${JSON.stringify({ addendumId: "rehearsal-g01" })}\n`,
    [F.declarationAddendum]: `${JSON.stringify({
      declarations: [
        {
          caseId: "G-02",
          variantId: "base",
          sceneId: S4_REHEARSAL_G02_DECLARED,
        },
        { caseId: "G-07", variantId: "base", sceneId: "g07-pell-dock" },
      ],
    })}\n`,
    [F.traceEditing]: `${JSON.stringify({ rehearsal: "editing" })}\n`,
    [F.traceBrowsing]: `${JSON.stringify({ rehearsal: "browsing" })}\n`,
    [F.authorDeclaration]: `${JSON.stringify({ rehearsal: "author" })}\n`,
    [F.seedPinAddendum]: `${JSON.stringify({ rehearsal: "seed-pin" })}\n`,
  };
  for (const [file, bytes] of Object.entries(frozenBytes)) put(file, bytes);
  put(procedureFilePath("v1"), rehearsalProcedureText());
  const s4a = commit("S4a: the frozen bytes");
  const digests = Object.fromEntries(
    Object.entries(frozenBytes).map(([file, bytes]) => [file, sha(bytes)]),
  );
  const row = (file) => ({ path: file, commit: s4a, sha256: digests[file] });
  const ctx = { base, s4a, digests };
  const prepValue = s2(
    {
      schemaVersion: "nir1-cp4-observation-prep/1",
      status: "frozen-before-observation",
      samplePlan: { warmupPerArm: 5, measuredPerArm: 30 },
      traces: [
        { kind: "editing", ...row(F.traceEditing) },
        { kind: "browsing", ...row(F.traceBrowsing) },
      ],
      diagnosticRuns: s2Record().diagnosticRuns,
      boundFiles: [
        row(F.setupAddendum),
        row(F.declarationAddendum),
        row(F.traceEditing),
        row(F.traceBrowsing),
        row(F.authorDeclaration),
        row(F.seedPinAddendum),
      ],
      setupReadings: {
        source: {
          pins: [
            { role: "rehearsal", commit: base, check: "ancestor", files: [] },
          ],
        },
      },
      placeholders: [],
    },
    ctx,
  );
  // A string is S2's bytes as they are (a file that is not JSON).
  const prepBytes =
    typeof prepValue === "string"
      ? prepValue
      : `${JSON.stringify(prepValue, null, 2)}\n`;
  const freezeValue = freeze(
    {
      schemaVersion: OBSERVATION_PREP_RECORD_SCHEMA,
      graphRuntimeObservedBeforeFreeze: false,
      k62: { freezeCommit: K62_FREEZE.commit, sha256: K62_FREEZE.sha256 },
      graphCaseFreeze: { ...GRAPH_CASE_FREEZE },
      g01Fixture: { path: G01_FIXTURE.path, sha256: G01_FIXTURE.sha256 },
      boundFiles: { [F.prep]: sha(prepBytes), ...digests },
    },
    { ...ctx, prepSha256: sha(prepBytes) },
  );
  put(F.prep, prepBytes);
  put(OBSERVATION_PREP_RECORD_PATH, `${JSON.stringify(freezeValue)}\n`);
  for (const [file, bytes] of Object.entries(s4b)) put(file, bytes);
  const s4bCommit = commit("S4b: fill the placeholders and freeze");
  testGit(repo, "update-ref", "refs/remotes/origin/master", s4bCommit);
  put("candidate.txt", "candidate\n");
  for (const [file, bytes] of Object.entries(candidate)) put(file, bytes);
  const head = commit("the candidate");
  return {
    repo,
    base,
    s4a,
    s4b: s4bCommit,
    head,
    tree: testGit(repo, "rev-parse", "HEAD^{tree}"),
    digests,
    prepSha256: sha(prepBytes),
    prepValue,
    freezeValue,
    k64Freeze: {
      ...K64_FREEZE,
      sha256: sha(S4_REHEARSAL_K64_TEXT),
      freezeCommit: base,
    },
    cleanup: () => rmSync(repo, { recursive: true, force: true }),
  };
}
