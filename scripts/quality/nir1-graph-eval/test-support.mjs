// Synthetic records shared by the CP-4 harness tests. Nothing here is a
// fixture of a G-case: every value is made up for the pure checks.
import { graphCaseScheduleKeys } from "./availability.mjs";
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

/** The 批准 5 evidence of a candidate that has D′, the RS-JOIN hook and W_f. */
export function ratification5(overrides = {}) {
  return {
    dPrime: {
      commit: "4d38d0d164e02a76a0e172214b259a11e0b2c5ff",
      ancestor: true,
    },
    rsJoinHook: {
      evidence: "candidate-test",
      testFile:
        "src/features/related-scenes/useNir1RelatedScenes.graphReadyKeep.test.tsx",
      passed: true,
    },
    wfWindow: {
      commit: "c4333bbd081fb297cf2dddc598155791b9678be8",
      ancestor: true,
    },
    ...overrides,
  };
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
