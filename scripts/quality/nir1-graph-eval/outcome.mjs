// CP-4 G-case outcome: preconditions from receipt evidence, the existing
// `resolveVariantOutcome` policy, steady-state quality (K6/2 step 8) and the
// existing 24 queries' R+IR+Graph = R+IR check.
//
// Nothing here observes a runtime or edits fixtures. Variant expectations
// come only from a fixture file loaded and checked by digest here; the
// caller cannot hand-build them.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  PRECONDITIONS,
  resolveVariantOutcome,
} from "../nir1-graph/contract.mjs";
import {
  classifyJoin,
  steadyStateInWindow,
  BOUNDARY_DISAGREEMENTS,
} from "./availability.mjs";
import {
  FROZEN_MATERIAL_SHA256,
  G01_FIXTURE,
  devVariant,
  variantByKey,
} from "./constants.mjs";

const PRODUCT_B_ROUTE = "b-route-maintenance";
const MAINTENANCE_SETTING = "runtime-policy-setting";
const LOADED = new WeakSet();

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

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function expectationsOf(fixtureVariant) {
  const arms = fixtureVariant.expectations?.arms;
  if (!Array.isArray(arms?.raw?.sceneIds))
    throw new Error("[artifact] fixture variant lacks expectations.arms.raw");
  return Object.freeze({
    rawSceneIds: Object.freeze([...arms.raw.sceneIds]),
    rawOrderPredeclared: arms.raw.orderPredeclared === true,
    irSupplementSceneId: arms.rPlusIr?.irSupplementSceneId ?? null,
  });
}

function seal(loaded) {
  const frozen = Object.freeze(loaded);
  LOADED.add(frozen);
  return frozen;
}

/**
 * Loads one frozen variant by catalog key: the file must have the frozen
 * digest and the case ID of the key (variant IDs such as `base` repeat).
 */
export async function loadFrozenVariant({ root, variantKey }) {
  const variant = variantByKey(variantKey);
  const bytes = await readFile(path.join(root, variant.fixturePath));
  if (sha256(bytes) !== variant.fixtureSha256)
    throw new Error(
      `[precheck] ${variant.fixturePath} differs from its frozen digest`,
    );
  const fixture = JSON.parse(bytes);
  if (variant.caseId === "G-01") {
    if (fixture.fixtureId !== G01_FIXTURE.fixtureId)
      throw new Error("[precheck] G-01 fixture identity differs");
    return seal({
      variantKey,
      caseId: "G-01",
      fixtureSha256: variant.fixtureSha256,
      fixtureVariant: null,
      expectations: null,
    });
  }
  if (fixture.caseId !== variant.caseId)
    throw new Error(
      `[precheck] ${variant.fixturePath} is not ${variant.caseId}`,
    );
  const fixtureVariant = fixture.variants?.find(
    (row) => row.id === variant.variantId,
  );
  if (!fixtureVariant)
    throw new Error(`[precheck] ${variantKey} is not in its frozen fixture`);
  return seal({
    variantKey,
    caseId: variant.caseId,
    fixtureSha256: variant.fixtureSha256,
    fixtureVariant,
    expectations: expectationsOf(fixtureVariant),
  });
}

/**
 * Loads one dev (synthetic) variant. The file must not be a copy of frozen
 * material; its key is `dev:<file base>/<variant id>`.
 */
export async function loadDevVariant({
  root,
  fixturePath,
  variantId,
  expectedGraph,
}) {
  const bytes = await readFile(path.join(root, fixturePath));
  const digest = sha256(bytes);
  if (FROZEN_MATERIAL_SHA256.has(digest))
    throw new Error(
      "[precheck] a dev fixture must not be a copy of frozen material",
    );
  const fixture = JSON.parse(bytes);
  const fixtureVariant = fixture.variants?.find((row) => row.id === variantId);
  if (!fixtureVariant)
    throw new Error(`[precheck] dev variant ${variantId} not found`);
  const key = `dev:${path.basename(fixturePath, ".json")}/${variantId}`;
  devVariant({ key, expectedGraph });
  return seal({
    variantKey: key,
    caseId: fixture.caseId ?? null,
    fixtureSha256: digest,
    fixtureVariant,
    expectations: expectationsOf(fixtureVariant),
  });
}

/**
 * Whether one declared precondition holds on the setup receipt evidence
 * (README "観測時の前提条件と blocked"). Missing evidence never holds.
 */
export function preconditionHolds(row, variant, evidence, expectations) {
  switch (row.id) {
    case "b-sealed-binding": {
      const sealed = evidence?.bSealedBinding;
      return (
        sealed?.route === PRODUCT_B_ROUTE &&
        sealed?.publisher === "product" &&
        Number.isInteger(sealed?.sealedGeneration) &&
        sealed.sealedGeneration > 0
      );
    }
    case "maintenance-enabled": {
      const maintenance = evidence?.maintenance;
      const reached =
        maintenance?.enabledVia === MAINTENANCE_SETTING &&
        maintenance?.sqlOverride === false &&
        Number.isInteger(maintenance?.probe?.sealedChronicleGeneration) &&
        Number.isInteger(maintenance?.probe?.sealedGraphGeneration);
      if (!reached) return false;
      // An unusable variant must reach it before its mutation commits.
      if (variant.measurementPoint === "after-maintenance-current") return true;
      return (
        Number.isFinite(maintenance.probe.sealedAtMs) &&
        Number.isFinite(maintenance.mutationCommittedAtMs) &&
        maintenance.probe.sealedAtMs < maintenance.mutationCommittedAtMs
      );
    }
    case "raw-membership": {
      const observed = evidence?.rawMembership?.observedSceneIds;
      return expectations?.rawOrderPredeclared
        ? sameList(observed, expectations.rawSceneIds)
        : sameSet(observed, expectations?.rawSceneIds);
    }
    case "ir-supplement-admission": {
      const supplement = evidence?.irSupplement;
      const raw = evidence?.rawMembership?.observedSceneIds;
      const hybrid = supplement?.observedHybridSceneIds;
      return (
        expectations?.irSupplementSceneId === row.sceneId &&
        supplement?.sceneId === row.sceneId &&
        supplement?.admitted === true &&
        Array.isArray(raw) &&
        Array.isArray(hybrid) &&
        sameList(hybrid.slice(0, raw.length), raw) &&
        hybrid.indexOf(row.sceneId) >= raw.length
      );
    }
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
 * all return the same final list; samples whose Graph result was not joined
 * must equal the paired R+IR sample. A joined-but-late sample within the
 * boundary tolerance carries Graph rows; the variant is then HOLD
 * (`boundary-disagreement`), fixed before observation. No in-window sample
 * is HOLD for a variant expected available.
 */
export function summarizeVariantQuality({ variant, samples }) {
  const key = variant.key;
  const measured = samples.filter(
    (row) =>
      row.variantKey === key &&
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
  const boundary = [];
  for (const row of graph) {
    const join = classifyJoin(row);
    if (join.disagreement === BOUNDARY_DISAGREEMENTS.joinedLateWithinTolerance)
      boundary.push(row.repeat);
    else if (steadyStateInWindow(row)) inWindow.push(row);
    else if (
      !join.joined &&
      !sameList(row.finalSceneIds, hybrid.get(row.repeat)?.finalSceneIds)
    )
      mixed.push(row.repeat);
  }
  if (mixed.length > 0)
    return {
      variantKey: key,
      status: "fail",
      reason: "out-of-window-sample-differs-from-r-plus-ir",
      repeats: mixed,
    };
  if (boundary.length > 0)
    return {
      variantKey: key,
      status: "hold",
      reason: "boundary-disagreement",
      repeats: boundary,
    };
  if (variant.expectedGraph === "unavailable") {
    if (inWindow.length > 0)
      return {
        variantKey: key,
        status: "fail",
        reason: "graph-joined-for-a-variant-expected-unavailable",
      };
    return {
      variantKey: key,
      status: "fallback-measured",
      finalSceneIds: graph[0]?.finalSceneIds ?? null,
    };
  }
  if (inWindow.length === 0)
    return { variantKey: key, status: "hold", reason: "no-in-window-sample" };
  const first = inWindow[0].finalSceneIds;
  if (!inWindow.every((row) => sameList(row.finalSceneIds, first)))
    return {
      variantKey: key,
      status: "fail",
      reason: "in-window-samples-differ",
    };
  return {
    variantKey: key,
    status: "measurable",
    steadyState: true,
    inWindowCount: inWindow.length,
    finalSceneIds: first,
  };
}

/**
 * Hold / blocked / pass of one loaded variant. G-02..G-08 apply the frozen
 * precondition policy through `resolveVariantOutcome`; G-01 declares none, so
 * an unreached B seal is a v1 expectation miss (Hold, TASK D2).
 */
export function resolveCp4VariantOutcome({
  loaded,
  evidence,
  quality,
  comparisonPassed,
}) {
  if (!LOADED.has(loaded))
    throw new Error(
      "[precheck] the variant must come from loadFrozenVariant or loadDevVariant",
    );
  const variantKey = loaded.variantKey;
  if (loaded.caseId === "G-01" && loaded.fixtureVariant === null) {
    const sealReached = preconditionHolds(
      { id: "b-sealed-binding" },
      {},
      evidence,
      null,
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
  const fixtureVariant = loaded.fixtureVariant;
  const unmet = unmetPreconditions(
    fixtureVariant,
    evidence,
    loaded.expectations,
  );
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
 * excerpt and Evidence. A seed is a forbidden contribution (N-15). Missing
 * result or Evidence arrays never compare equal.
 */
export function compareExistingQueryGraphArm(hybrid, graph) {
  const violations = [];
  if (graph?.graph?.seed !== null && graph?.graph?.seed !== undefined)
    violations.push("forbidden-contribution:seed");
  if (graph?.graph?.status !== "not-requested")
    violations.push(`graph-status:${graph?.graph?.status ?? "missing"}`);
  if ((graph?.graph?.contributionCount ?? 0) !== 0)
    violations.push("forbidden-contribution:graph-rows");
  const left = hybrid?.result?.scenes;
  const right = graph?.result?.scenes;
  if (!Array.isArray(left) || !Array.isArray(right))
    violations.push("missing-result");
  if (!Array.isArray(hybrid?.evidence) || !Array.isArray(graph?.evidence))
    violations.push("missing-evidence");
  if (
    violations.includes("missing-result") ||
    violations.includes("missing-evidence")
  )
    return { equal: false, violations };
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
  if (JSON.stringify(hybrid.evidence) !== JSON.stringify(graph.evidence))
    violations.push("evidence");
  return { equal: violations.length === 0, violations };
}
