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
