// Synthetic records shared by the CP-4 harness tests. Nothing here is a
// fixture of a G-case: every value is made up for the pure checks.
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { claimTestEvidenceSealer } from "./admission-facts.mjs";
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
  GRAPH_EVAL_VARIANTS,
  K64_CANDIDATE_REQUIREMENTS,
} from "./constants.mjs";
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
