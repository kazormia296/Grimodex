// CP-4 G-case outcome: preconditions from receipt evidence, the existing
// `resolveVariantOutcome` policy, steady-state quality (K6/2 step 8) and the
// existing 24 queries' R+IR+Graph = R+IR check.
//
// Pure module. Nothing here observes a runtime or edits fixtures; frozen
// expectations are passed in by the caller.

import {
  PRECONDITIONS,
  resolveVariantOutcome,
} from "../nir1-graph/contract.mjs";
import { steadyStateInWindow } from "./availability.mjs";
import { variantByKey } from "./constants.mjs";

const PRODUCT_B_ROUTE = "b-route-maintenance";
const MAINTENANCE_SETTING = "runtime-policy-setting";

function sameList(left, right) {
  return (
    Array.isArray(left) &&
    Array.isArray(right) &&
    left.length === right.length &&
    left.every((value, at) => value === right[at])
  );
}

function sameSet(left, right) {
  return (
    Array.isArray(left) &&
    Array.isArray(right) &&
    sameList([...left].sort(), [...right].sort())
  );
}

/**
 * Whether one declared precondition holds on the setup receipt evidence.
 * Missing evidence never holds (the variant is then blocked, not passed).
 */
export function preconditionHolds(row, variant, evidence, expectations) {
  switch (row.id) {
    case "b-sealed-binding": {
      const seal = evidence?.bSealedBinding;
      return (
        seal?.route === PRODUCT_B_ROUTE &&
        seal?.publisher === "product" &&
        Number.isInteger(seal?.sealedGeneration) &&
        seal.sealedGeneration > 0
      );
    }
    case "maintenance-enabled": {
      const maintenance = evidence?.maintenance;
      return (
        maintenance?.enabledVia === MAINTENANCE_SETTING &&
        maintenance?.sqlOverride === false &&
        Number.isInteger(maintenance?.probe?.sealedChronicleGeneration) &&
        Number.isInteger(maintenance?.probe?.sealedGraphGeneration)
      );
    }
    case "raw-membership":
      return sameList(
        evidence?.rawMembership?.observedSceneIds,
        expectations?.rawSceneIds,
      );
    case "ir-supplement-admission":
      return (
        evidence?.irSupplement?.sceneId === row.sceneId &&
        evidence?.irSupplement?.admitted === true
      );
    case "index-state-holding": {
      const holding = evidence?.indexStateHolding;
      return (
        holding?.held === true &&
        holding?.observed?.chronicle === variant.indexState?.chronicle &&
        holding?.observed?.graph === variant.indexState?.graph
      );
    }
    case "cb4-inputs":
      return (
        evidence?.cb4Inputs?.sceneId === row.sceneId &&
        evidence?.cb4Inputs?.present === true
      );
    default:
      throw new Error(`[artifact] unknown precondition ${row.id}`);
  }
}

/** The unmet declared preconditions, in catalog order. */
export function unmetPreconditions(variant, evidence, expectations) {
  const declared = variant.preconditions ?? [];
  const unmet = declared
    .filter((row) => !preconditionHolds(row, variant, evidence, expectations))
    .map((row) => row.id);
  return PRECONDITIONS.map((row) => row.id).filter((id) => unmet.includes(id));
}

/**
 * Steady-state quality of one variant (K6/2 step 8). In-window samples must
 * all return the same final list; out-of-window samples must equal the
 * paired R+IR sample. No in-window sample is HOLD for a variant expected
 * available. A variant expected unavailable is judged on its fallback only.
 */
export function summarizeVariantQuality({ variantKey, samples }) {
  const variant = variantByKey(variantKey);
  const measured = samples.filter(
    (row) =>
      row.variantKey === variantKey &&
      row.phase === "measured" &&
      row.trigger === "user-operation",
  );
  const hybrid = new Map(
    measured
      .filter((row) => row.arm === "hybrid")
      .map((row) => [row.repeat, row]),
  );
  const graph = measured.filter((row) => row.arm === "graph");
  const inWindow = [];
  const mixed = [];
  for (const row of graph) {
    if (steadyStateInWindow(row)) inWindow.push(row);
    else if (
      !sameList(row.finalSceneIds, hybrid.get(row.repeat)?.finalSceneIds)
    )
      mixed.push(row.repeat);
  }
  if (mixed.length > 0)
    return {
      variantKey,
      status: "fail",
      reason: "out-of-window-sample-differs-from-r-plus-ir",
      repeats: mixed,
    };
  if (variant.expectedGraph === "unavailable") {
    if (inWindow.length > 0)
      return {
        variantKey,
        status: "fail",
        reason: "graph-joined-for-a-variant-expected-unavailable",
      };
    return {
      variantKey,
      status: "fallback-measured",
      finalSceneIds: graph[0]?.finalSceneIds ?? null,
    };
  }
  if (inWindow.length === 0)
    return { variantKey, status: "hold", reason: "no-in-window-sample" };
  const first = inWindow[0].finalSceneIds;
  if (!inWindow.every((row) => sameList(row.finalSceneIds, first)))
    return {
      variantKey,
      status: "fail",
      reason: "in-window-samples-differ",
    };
  return {
    variantKey,
    status: "measurable",
    steadyState: true,
    inWindowCount: inWindow.length,
    finalSceneIds: first,
  };
}

/**
 * Hold / blocked / pass of one variant. G-02..G-08 apply the frozen
 * precondition policy through `resolveVariantOutcome`; G-01 declares none, so
 * an unreached B seal is a v1 expectation miss (Hold, TASK D2).
 */
export function resolveCp4VariantOutcome({
  variantKey,
  fixtureVariant,
  evidence,
  expectations,
  quality,
  comparisonPassed,
}) {
  const variant = variantByKey(variantKey);
  if (variant.caseId === "G-01") {
    const sealReached = preconditionHolds(
      { id: "b-sealed-binding" },
      {},
      evidence,
      expectations,
    );
    const passed =
      sealReached &&
      quality?.status === "measurable" &&
      comparisonPassed === true;
    return {
      variantKey,
      ...resolveVariantOutcome(
        { id: variantKey, preconditions: [] },
        { unmet: [], comparisonPassed: passed },
      ),
      holdReason: passed
        ? null
        : !sealReached
          ? "g01-v1-expectation-not-reached:b-seal"
          : (quality?.reason ?? "comparison-failed"),
    };
  }
  if (fixtureVariant?.id !== variant.variantId)
    throw new Error(`[artifact] fixture variant does not match ${variantKey}`);
  const unmet = unmetPreconditions(fixtureVariant, evidence, expectations);
  const blocking = unmet.some(
    (id) => PRECONDITIONS.find((row) => row.id === id)?.scope === "variant",
  );
  if (blocking)
    return {
      variantKey,
      ...resolveVariantOutcome(fixtureVariant, { unmet }),
      holdReason: null,
    };
  const qualityOk =
    quality?.status === "measurable" || quality?.status === "fallback-measured";
  const passed = qualityOk && comparisonPassed === true;
  return {
    variantKey,
    ...resolveVariantOutcome(fixtureVariant, {
      unmet,
      comparisonPassed: passed,
    }),
    holdReason: passed ? null : (quality?.reason ?? "comparison-failed"),
  };
}

/** Fields compared between R+IR and R+IR+Graph on the existing 24 queries. */
export const EXISTING_QUERY_COMPARED_FIELDS = Object.freeze([
  "membership",
  "order",
  "excerpt",
  "evidence",
]);

/**
 * The existing 24 queries carry no seed: R+IR+Graph must report Graph
 * `not-requested`, contribute nothing and equal R+IR in membership, order,
 * excerpt and Evidence. A seed is a forbidden contribution (N-15).
 */
export function compareExistingQueryGraphArm(hybrid, graph) {
  const violations = [];
  if (graph?.graph?.seed !== null && graph?.graph?.seed !== undefined)
    violations.push("forbidden-contribution:seed");
  if (graph?.graph?.status !== "not-requested")
    violations.push(`graph-status:${graph?.graph?.status ?? "missing"}`);
  if ((graph?.graph?.contributionCount ?? 0) !== 0)
    violations.push("forbidden-contribution:graph-rows");
  const left = hybrid?.result?.scenes ?? [];
  const right = graph?.result?.scenes ?? [];
  const ids = (rows) => rows.map((row) => row.sceneId);
  if (!sameSet(ids(left), ids(right))) violations.push("membership");
  if (!sameList(ids(left), ids(right))) violations.push("order");
  if (
    !sameList(
      left.map((row) => row.chunkText),
      right.map((row) => row.chunkText),
    )
  )
    violations.push("excerpt");
  if (
    JSON.stringify(hybrid?.evidence ?? []) !==
    JSON.stringify(graph?.evidence ?? [])
  )
    violations.push("evidence");
  return { equal: violations.length === 0, violations };
}
