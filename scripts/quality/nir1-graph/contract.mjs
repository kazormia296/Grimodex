// Predeclared C-product Graph case contract (G-01..G-08).
//
// This module never runs Graph, IR, Raw or a model. It validates fixed
// fixtures and recomputes their declared expectations from the documented
// rules below, using only the fixture's own declarations. Runtime results are
// compared against these fixtures later (CP-4); nothing here reads them.
//
// Rule sources (repository documents):
//   - docs/plans/nir1-l6-l9-execution-plan.md: G-01..G-08 table, L6 profile
//     evaluation (exact / any / unresolved / unknown), L7 (directed = stored
//     direction, symmetric = both; 2 hops, 50 discovered Entities, 512
//     qualified edge expansions, 8 returned Scenes; R+IR membership kept,
//     Graph uses path attachment and the shared one-scene slot only),
//     graph-limited-binding (limit exceeded / stale / unqualified => Graph
//     contribution 0, no partial Graph, no mixed generation).
//   - docs/plans/narrative-ir-nir1-implementation-plan.md: strict
//     reading-before-S2 for IR/Graph material; secret/reveal, holder and
//     audience as additional AND conditions; A6 availability table
//     (Graph unusable => R+IR, Chronicle unusable => exact R).
//   - docs/plans/nir1-c-scene-connection-candidate.md §1-§7: explicit pins of
//     reached Entities are the only Scene association; order tuple
//     (hop, edge IDs, Entity ID, Scene ID); one appended Scene only when R+IR
//     is below 8 and IR did not use the shared slot; first non-empty line
//     excerpt for a Graph-only Scene.
//   - docs/plans/nir1-post-b-execution-plan.md §6-§7: no partial Graph, no
//     non-disclosed bridge, Graph improvement judged against R+IR.
//   - docs/plans/nir1-dsn-2026-10.md §2.2-§2.3 (K1 confirmed without the
//     N_F>8 deviation): the worker frame keeps the first 8 Scenes in tuple
//     order, the parent judges eligibility from the front, then attaches paths
//     and fills the one shared slot. Every fixture keeps the pins of reached
//     Entities at or below 8, so that truncation never decides an expectation.
//   - src-tauri/crates/grimodex-db/src/narrative_extraction/
//     nir1_entity_relation.rs read_a3_reveal_state: the existing reveal rule
//     (non-secret or abandoned => disclosed; payoff Scene => disclosed when it
//     is not after S2; no payoff Scene => disclosed when payoff_confirmed).
//
// Observation-time preconditions (manifest `preconditions`) decide whether a
// variant is measured at all; an unmet one records `blocked:<id>`, never Hold.
// Fields outside manifest `runtimeComparison.comparedFields` are rule-derived
// explanations or design predictions and are never compared with runtime.
// The freeze record is accepted only after an approving independent
// expectation review whose approved bytes it binds (validateApprovingReview).
// A freeze written after Graph runtime observed the population
// (graphRuntimeObservedBeforeFreeze true) must declare every case it rebuilt
// in postObservationRevisions and bind the superseded freeze record, whose
// case hashes every other case keeps (validatePostObservationFreeze).
import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { scoreQuery } from "../nir1-retrieval/contract.mjs";
import { ftsQueryTokens, lexicalConflict, lexicalTokens } from "./porter.mjs";

export const NIR1_GRAPH_MANIFEST_PATH = "evals/nir1-graph/manifest.v1.json";
export const NIR1_GRAPH_SCHEMA_PATH = "evals/nir1-graph/schema.v1.json";
export const NIR1_GRAPH_FREEZE_PATH = "evals/nir1-graph/freeze.v2.json";
/**
 * The version-1 freeze record that the current freeze supersedes (DR-CP4-G4-6).
 * Its bytes stay in the repository unchanged: other records bind its sha256,
 * and the current freeze proves against it that every case but the rebuilt
 * ones keeps its version-1 bytes. `commit` is the last commit that wrote it.
 */
export const NIR1_GRAPH_SUPERSEDED_FREEZE = Object.freeze({
  path: "evals/nir1-graph/freeze.v1.json",
  sha256: "6080530adc0a7d2d45896005664f6f498d5f28c3eeed517875f8f599faa8bae7",
  commit: "a789039a779eb4df0dec2b8b3be5e29d2bff5a5c",
});
export const NIR1_GRAPH_README_PATH = "evals/nir1-graph/README.md";
export const NIR1_GRAPH_REVIEW_RECEIPT_PATH =
  "evals/nir1-graph/independent-expectation-review.v1.json";
export const NIR1_L6L9_PLAN_PATH = "docs/plans/nir1-l6-l9-execution-plan.md";
export const NIR1_RANKING_POLICY_PATH =
  "policies/narrative/nir1-related-scenes-ranking.json";
export const NIR1_RETRIEVAL_MANIFEST_PATH =
  "evals/nir1-retrieval/manifest.json";
export const NIR1_G01_FIXTURE_PATH = "evals/nir1-g01/fixture.v1.json";
export const NIR1_G01_FIXTURE_ID = "nir1-g01-explicit-pin-design/1";
export const NIR1_GRAPH_OBSERVATION_POLICY =
  "Do not change query, corpus, seed, Gold, ordering, or metrics after observing a runtime result.";

export const GRAPH_RULES = Object.freeze({
  maxHops: 2,
  maxDiscoveredEntities: 50,
  maxQualifiedEdgeExpansions: 512,
  maxReturnedScenes: 8,
  fusionMaxScenes: 8,
  maxAdditionalScenes: 1,
});

export const GRAPH_CASE_IDS = Object.freeze([
  "G-01",
  "G-02",
  "G-03",
  "G-04",
  "G-05",
  "G-06",
  "G-07",
  "G-08",
]);

export const SLOT_CLASSES = Object.freeze([
  "supplementable",
  "raw-full",
  "ir-supplemented",
]);

export const MANIFEST_STATUS = Object.freeze({
  pending: "predeclared-awaiting-independent-expectation-review",
  frozen: "frozen-after-independent-expectation-review",
});

/** The only independent expectation review verdict a freeze can follow. */
export const APPROVING_REVIEW_VERDICT = "approve";

/**
 * Bound files that may change after the approving review, and the only kind
 * of scope each change may declare. Every other bound file (the fixtures, the
 * schema and the earlier review receipt) keeps its approved bytes.
 */
export const CHANGE_AFTER_APPROVAL_SCOPES = Object.freeze({
  [NIR1_GRAPH_MANIFEST_PATH]: Object.freeze({
    kind: "json-keys",
    allowed: Object.freeze(["independentExpectationReview"]),
  }),
  [NIR1_GRAPH_README_PATH]: Object.freeze({ kind: "markdown-sections" }),
});

/**
 * The scopes a freeze written after a runtime observation may declare instead
 * (DR-CP4-G4-5, DR-CP4-G4-6): the rebuilt case's manifest entry, the
 * enumerations of the cases each precondition and the IR-supplemented class
 * name (never a precondition id, scope, notEvaluated list, the closed set or
 * the outcome rules), the post-observation record, the README sections that
 * repeat them (and the status preamble), and the schema's fixtureId pattern.
 * Each pointer is an RFC 6901 JSON pointer into the parsed document.
 */
export const POST_OBSERVATION_CHANGE_SCOPES = Object.freeze({
  [NIR1_GRAPH_MANIFEST_PATH]: Object.freeze({
    kind: "json-pointers",
    allowed: Object.freeze([
      "/graphRuntimeObservedBeforeFreeze",
      "/postObservationRevisions",
      "/cases/3",
      "/preconditions/definitions/2/check",
      "/preconditions/definitions/3/appliesTo",
      "/preconditions/definitions/5/appliesTo",
      "/preconditions/holdVersusBlocked",
      "/irSupplementedCoverage/cases",
      "/irSupplementedCoverage/admissionProbe",
      "/irSupplementedCoverage/probeOption",
      "/coverageGaps",
      "/independentExpectationReview",
    ]),
    // These may only grow: the approved text or list stays their prefix.
    appendOnly: Object.freeze([
      "/preconditions/holdVersusBlocked",
      "/coverageGaps",
    ]),
  }),
  [NIR1_GRAPH_README_PATH]: Object.freeze({
    kind: "markdown-sections",
    preamble: true,
    // Rule lines inside the declared sections that must stay verbatim.
    requiredLines: Object.freeze([
      "- 前提条件は、観測の後に足さず、外さず、読み替えない。前提条件が成り立たなくても期待値は変えない。",
      "  - variant が宣言していない前提条件で、観測結果を blocked にすることはできない。validator の `resolveVariantOutcome` がこれを拒否する。",
      "- 観測した後に、query、corpus、seed、Gold、順序、指標、fixture、前提条件を変えない。",
      "- 比較する期待値と実 runtime の結果が違えば、その結果を保持して Hold にする。正例の材料を setup で作れない場合も Hold とする。",
    ]),
  }),
  [NIR1_GRAPH_SCHEMA_PATH]: Object.freeze({
    kind: "json-pointers",
    allowed: Object.freeze(["/properties/fixtureId/pattern"]),
  }),
});

/**
 * The closed set of observation-time preconditions, in the order used to
 * name a blocked variant. Scope `variant` blocks the whole variant; scope
 * `added-scene` blocks only the appended Graph-only Scene sub-expectation.
 */
export const PRECONDITIONS = Object.freeze([
  Object.freeze({ id: "b-sealed-binding", scope: "variant" }),
  Object.freeze({ id: "maintenance-enabled", scope: "variant" }),
  Object.freeze({ id: "raw-membership", scope: "variant" }),
  Object.freeze({ id: "ir-supplement-admission", scope: "variant" }),
  Object.freeze({ id: "index-state-holding", scope: "variant" }),
  Object.freeze({ id: "cb4-inputs", scope: "added-scene" }),
]);

/** Expectation fields (relative to a variant's `expectations`) compared with runtime. */
export const RUNTIME_COMPARED_FIELDS = Object.freeze([
  "arms.raw.sceneIds",
  "arms.rPlusIr.sceneIds",
  "arms.rPlusIr.irSupplementSceneId",
  "arms.rPlusIrPlusGraph.baseline",
  "arms.rPlusIrPlusGraph.sceneIds",
  "arms.rPlusIrPlusGraph.appendedSceneId",
  "graph.status",
  "graph.nodes",
  "graph.edgeIds",
  "pathAttachments",
  "addedScene",
  "blockedCandidates[].sceneId",
  "blockedCandidates[].entityId",
  "scenesWithoutPath",
  "forbiddenSceneIds",
  "evidence",
  "metrics",
]);

/** Fields that only decide how a compared Scene list is compared. */
export const RUNTIME_COMPARISON_CONTROL_FIELDS = Object.freeze([
  "arms.raw.orderPredeclared",
  "arms.rPlusIr.orderPredeclared",
  "arms.rPlusIrPlusGraph.orderPredeclared",
]);

/** Rule-derived explanations and design predictions: recorded, never compared. */
export const RUNTIME_RECORDED_ONLY_FIELDS = Object.freeze([
  "arms.rPlusIr.resultKind",
  "graph.reasonClass",
  "graph.qualifiedRevisionIds",
  "graph.excludedRevisions",
  "graph.excludedEdges",
  "graph.excludedEntities",
  "graph.frontier",
  "blockedCandidates[].reason",
]);

/** Fields not evaluated when the `added-scene` precondition is unmet. */
export const ADDED_SCENE_SUB_EXPECTATION = Object.freeze([
  "addedScene",
  "arms.rPlusIrPlusGraph.appendedSceneId",
  "arms.rPlusIrPlusGraph.sceneIds[appended]",
  "evidence.requirements[added-scene-body-anchor]",
  "metrics.rPlusIrPlusGraph",
]);

const SCOPE_AXES = Object.freeze(["timeline", "worldline", "narrativeLayer"]);

const REVISION_REASON_ORDER = Object.freeze([
  "decision-rejected",
  "decision-missing",
  "stale-after-approval",
  "reading-future",
  "reading-same-boundary",
  "scope-marker-unknown",
  "scope-mismatch",
  "scope-unresolved",
  "holder-not-reader",
  "audience-not-reader",
  "secret-not-revealed",
]);

const MEASUREMENT_INDEX_STATE = Object.freeze({
  "after-maintenance-current": { chronicle: "usable", graph: "usable" },
  "while-graph-index-unusable": { chronicle: "usable", graph: "unusable" },
  "while-chronicle-index-unusable": { chronicle: "unusable", graph: "usable" },
  "while-both-indexes-unusable": { chronicle: "unusable", graph: "unusable" },
});

const REQUIRED_EVIDENCE = Object.freeze([
  "edge-relation-evidence",
  "node-entity-evidence",
  "revision-decision-binding",
  "explicit-pin-association",
]);

// ProseMirror/FTS structure words that every stored Scene body may contain.
const STRUCTURE_WORDS = Object.freeze([
  "doc",
  "paragraph",
  "text",
  "content",
  "type",
  "attrs",
  "marks",
  "heading",
  "level",
  "hardbreak",
]);

const EPSILON = 1e-12;

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

function sorted(values) {
  return [...values].sort();
}

function sameSet(left, right) {
  const a = sorted(left);
  const b = sorted(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function stableJson(value) {
  return JSON.stringify(value);
}

function utf16Length(text) {
  return String(text).length;
}

/** Rows `| G-0n | class | judgement | positive | negative |` of the l6-l9 table. */
export function parseGraphCaseTable(markdown) {
  const rows = new Map();
  for (const line of String(markdown).split(/\r?\n/)) {
    const match = /^\|\s*(G-0[1-8])\s*\|(.*)\|\s*$/.exec(line);
    if (!match) continue;
    const cells = match[2].split("|").map((cell) => cell.trim());
    if (cells.length !== 4) continue;
    rows.set(match[1], {
      queryClass: cells[0],
      expectedJudgement: cells[1],
      positive: cells[2],
      negative: cells[3],
    });
  }
  return rows;
}

function createSchemaValidator(schema) {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  return ajv.compile(schema);
}

function schemaErrors(validate, value, label) {
  if (validate(value)) return [];
  return (validate.errors ?? []).map(
    (error) =>
      `${label} schema ${error.instancePath || "/"} ${error.message ?? "invalid"}`,
  );
}

function appliesTo(item, variantId) {
  return !item.onlyInVariants || item.onlyInVariants.includes(variantId);
}

function indexFixture(fixture) {
  const querySceneId = fixture.query.sceneId;
  const scenes = new Map(fixture.scenes.map((scene) => [scene.id, scene]));
  const orders = new Map(
    fixture.scenes.map((scene) => [scene.id, scene.readingOrder]),
  );
  orders.set(querySceneId, fixture.query.readingOrder);
  return {
    querySceneId,
    queryOrder: fixture.query.readingOrder,
    scenes,
    orders,
    entities: new Map(fixture.entities.map((entity) => [entity.id, entity])),
    relations: new Map(
      fixture.relations.map((relation) => [relation.id, relation]),
    ),
    revisions: new Map(
      fixture.revisions.map((revision) => [revision.id, revision]),
    ),
    mutations: new Map(
      fixture.mutations.map((mutation) => [mutation.id, mutation]),
    ),
    variants: new Map(fixture.variants.map((variant) => [variant.id, variant])),
    eligible: new Set(fixture.eligibleSceneIds),
  };
}

export function effectiveScope(fixture, sceneId) {
  const base = fixture.scope.default;
  const override = fixture.scope.overrides?.[sceneId];
  if (!override) return base;
  if (override.marker === "unknown") return { marker: "unknown" };
  return {
    marker: "explicit",
    queryIdentity: { ...base.queryIdentity, ...(override.queryIdentity ?? {}) },
    materialConstraint: {
      ...base.materialConstraint,
      ...(override.materialConstraint ?? {}),
    },
    knowledgeHolder: override.knowledgeHolder ?? base.knowledgeHolder,
    audience: override.audience ?? base.audience,
  };
}

function mutationTouches(mutation, revision) {
  if (mutation.kind === "codex-entry-summary-edit")
    return revision.entityIds.includes(mutation.entityId);
  if (mutation.kind === "codex-relation-type-edit")
    return revision.relationIds.includes(mutation.relationId);
  return false;
}

function variantTimeline(fixture, index, variantId) {
  return fixture.setupTimeline.filter((step) => {
    if (step.kind === "qualified-ir") return true;
    const item =
      step.kind === "revision"
        ? index.revisions.get(step.id)
        : index.mutations.get(step.id);
    return item && appliesTo(item, variantId);
  });
}

/**
 * The existing reveal rule (read_a3_reveal_state): a non-secret or abandoned
 * foreshadow never withholds; a secret with a payoff Scene is disclosed when
 * that Scene is not after S2 in reading order (S2 itself included, payoff
 * confirmation not required); a secret without a payoff Scene is disclosed
 * only when its payoff is confirmed. The fixtures set no story time, so the
 * product compares reading ranks here.
 */
export function foreshadowDisclosedAtQuery(foreshadow, orders, queryOrder) {
  if (!foreshadow.secret || foreshadow.abandoned) return true;
  if (foreshadow.payoffSceneId === null) return foreshadow.payoffConfirmed;
  const payoffOrder = orders.get(foreshadow.payoffSceneId);
  return payoffOrder !== undefined && payoffOrder <= queryOrder;
}

/** Documented qualification rules for one typed Entity/Relation Revision. */
export function revisionExclusionReasons(fixture, index, revision, stale) {
  const reasons = new Set();
  if (revision.decision === "rejected") reasons.add("decision-rejected");
  else if (revision.decision !== "approved") reasons.add("decision-missing");
  if (stale) reasons.add("stale-after-approval");
  const reviewOrder = index.orders.get(revision.reviewSceneId);
  if (reviewOrder > index.queryOrder) reasons.add("reading-future");
  else if (reviewOrder === index.queryOrder)
    reasons.add("reading-same-boundary");
  const scope = effectiveScope(fixture, revision.reviewSceneId);
  const queryScope = effectiveScope(fixture, index.querySceneId);
  if (scope.marker !== "explicit") {
    reasons.add("scope-marker-unknown");
  } else {
    for (const axis of SCOPE_AXES) {
      const material = scope.materialConstraint[axis];
      const query = queryScope.queryIdentity[axis];
      if (material.kind === "unresolved") reasons.add("scope-unresolved");
      else if (
        material.kind === "exact" &&
        !(query.kind === "exact" && query.ref === material.ref)
      ) {
        reasons.add("scope-mismatch");
      }
    }
    if (scope.knowledgeHolder.kind !== "reader")
      reasons.add("holder-not-reader");
    if (scope.audience.kind !== "reader") reasons.add("audience-not-reader");
  }
  for (const foreshadow of fixture.foreshadows) {
    if (
      !foreshadow.linkedEntityIds.some((id) => revision.entityIds.includes(id))
    )
      continue;
    if (!foreshadowDisclosedAtQuery(foreshadow, index.orders, index.queryOrder))
      reasons.add("secret-not-revealed");
  }
  return REVISION_REASON_ORDER.filter((reason) => reasons.has(reason));
}

function traverse(index, qualifiedRelations, qualifiedEntities, seedId) {
  const hop = new Map([[seedId, 0]]);
  const parent = new Map();
  let frontier = [seedId];
  let expansions = 0;
  const relations = [...qualifiedRelations]
    .map((id) => index.relations.get(id))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (let depth = 1; depth <= GRAPH_RULES.maxHops; depth += 1) {
    const next = [];
    for (const node of frontier) {
      for (const relation of relations) {
        const targets = [];
        if (relation.fromEntityId === node) targets.push(relation.toEntityId);
        if (relation.direction === "symmetric" && relation.toEntityId === node)
          targets.push(relation.fromEntityId);
        for (const target of targets) {
          if (!qualifiedEntities.has(target)) continue;
          expansions += 1;
          if (!hop.has(target)) {
            hop.set(target, depth);
            parent.set(target, { from: node, edgeId: relation.id });
            next.push(target);
          }
        }
      }
    }
    frontier = next;
  }
  return { hop, parent, expansions };
}

function pathTo(parent, seedId, entityId) {
  const edgeIds = [];
  let cursor = entityId;
  while (cursor !== seedId) {
    const step = parent.get(cursor);
    edgeIds.unshift(step.edgeId);
    cursor = step.from;
  }
  return edgeIds;
}

/**
 * Recomputes one variant from the fixture's declarations and the documented
 * rules. Raw and IR memberships are inputs (predeclared design expectations);
 * everything Graph-derived is computed here.
 */
export function evaluateGraphCaseVariant(fixture, variant) {
  const index = indexFixture(fixture);
  const errors = [];
  const label = `${fixture.caseId}/${variant.id}`;
  const timeline = variantTimeline(fixture, index, variant.id);
  const stale = new Set();
  timeline.forEach((step, position) => {
    if (step.kind !== "mutation") return;
    const mutation = index.mutations.get(step.id);
    for (const earlier of timeline.slice(0, position)) {
      if (earlier.kind !== "revision") continue;
      if (mutationTouches(mutation, index.revisions.get(earlier.id)))
        stale.add(earlier.id);
    }
  });
  const activeRevisions = timeline
    .filter((step) => step.kind === "revision")
    .map((step) => index.revisions.get(step.id));
  const revisionReasons = new Map(
    activeRevisions.map((revision) => [
      revision.id,
      revisionExclusionReasons(
        fixture,
        index,
        revision,
        stale.has(revision.id),
      ),
    ]),
  );
  const qualifiedRevisions = activeRevisions.filter(
    (revision) => revisionReasons.get(revision.id).length === 0,
  );
  const qualifiedEntities = new Set(
    qualifiedRevisions.flatMap((revision) => revision.entityIds),
  );
  const qualifiedRelations = new Set(
    qualifiedRevisions.flatMap((revision) => revision.relationIds),
  );

  const arms = variant.expectations.arms;
  const rawIds = arms.raw.sceneIds;
  const rPlusIrIds = arms.rPlusIr.sceneIds;
  const seedId = fixture.manualSeed.entityId;
  const indexState = variant.indexState;

  const computed = {
    graph: {
      status: "available",
      reasonClass: null,
      nodes: [],
      edgeIds: [],
    },
    attachments: [],
    added: null,
    blocked: [],
    finalSceneIds: [...rPlusIrIds],
    frontier: null,
    framePinCount: null,
  };

  if (indexState.chronicle === "unusable") {
    computed.graph.status = "unavailable";
    computed.graph.reasonClass = "chronicle-index-unusable";
    computed.finalSceneIds = [...rawIds];
    return { errors, computed, qualifiedRevisions, revisionReasons };
  }
  if (indexState.graph === "unusable") {
    computed.graph.status = "unavailable";
    computed.graph.reasonClass = "graph-index-unusable";
    return { errors, computed, qualifiedRevisions, revisionReasons };
  }
  if (!qualifiedEntities.has(seedId)) {
    computed.graph.status = "unavailable";
    computed.graph.reasonClass = "seed-not-qualified";
    return { errors, computed, qualifiedRevisions, revisionReasons };
  }

  const { hop, parent, expansions } = traverse(
    index,
    qualifiedRelations,
    qualifiedEntities,
    seedId,
  );
  const discovered = hop.size - 1;
  computed.frontier = {
    discoveredEntities: discovered,
    limit: GRAPH_RULES.maxDiscoveredEntities,
  };
  const limitExceeded =
    discovered > GRAPH_RULES.maxDiscoveredEntities ||
    expansions > GRAPH_RULES.maxQualifiedEdgeExpansions;
  if (limitExceeded) {
    // Both "50 excluding the seed" and "50 including the seed" must agree.
    if (discovered < GRAPH_RULES.maxDiscoveredEntities + 1)
      errors.push(`${label} frontier is in the ambiguous counting zone`);
    computed.graph.status = "unavailable";
    computed.graph.reasonClass = "graph-limit-exceeded";
    return { errors, computed, qualifiedRevisions, revisionReasons };
  }
  if (hop.size > GRAPH_RULES.maxDiscoveredEntities)
    errors.push(`${label} frontier is in the ambiguous counting zone`);
  if (expansions > 100)
    errors.push(`${label} keeps edge expansions far below 512 only by design`);

  computed.graph.nodes = [...hop.entries()]
    .map(([entityId, depth]) => ({ entityId, hop: depth }))
    .sort((a, b) => a.hop - b.hop || (a.entityId < b.entityId ? -1 : 1));
  const treeEdges = new Set([...parent.values()].map((step) => step.edgeId));
  computed.graph.edgeIds = sorted(treeEdges);

  // Edge and Entity exclusion classes.
  const activeRevisionsByMaterial = (key, id) =>
    activeRevisions.filter((revision) => revision[key].includes(id));
  const excludedEdges = [];
  for (const relation of fixture.relations) {
    if (treeEdges.has(relation.id)) continue;
    const containing = activeRevisionsByMaterial("relationIds", relation.id);
    if (containing.length === 0) {
      excludedEdges.push({ edgeId: relation.id, reason: "no-revision" });
      continue;
    }
    if (!qualifiedRelations.has(relation.id)) {
      excludedEdges.push({ edgeId: relation.id, reason: "revision-excluded" });
      continue;
    }
    const sourceHops = [hop.get(relation.fromEntityId)];
    if (relation.direction === "symmetric")
      sourceHops.push(hop.get(relation.toEntityId));
    const reachedSources = sourceHops.filter((depth) => depth !== undefined);
    if (reachedSources.some((depth) => depth < GRAPH_RULES.maxHops)) {
      errors.push(
        `${label} qualified non-tree edge ${relation.id} makes the expected edge set ambiguous`,
      );
    } else if (reachedSources.some((depth) => depth === GRAPH_RULES.maxHops)) {
      excludedEdges.push({ edgeId: relation.id, reason: "beyond-max-hops" });
    } else if (
      relation.direction === "directed" &&
      hop.has(relation.toEntityId)
    ) {
      excludedEdges.push({ edgeId: relation.id, reason: "reverse-direction" });
    } else {
      excludedEdges.push({ edgeId: relation.id, reason: "unreachable" });
    }
  }
  const beyondTargets = new Set(
    excludedEdges
      .filter((edge) => edge.reason === "beyond-max-hops")
      .flatMap((edge) => {
        const relation = index.relations.get(edge.edgeId);
        const targets = [];
        if (hop.get(relation.fromEntityId) === GRAPH_RULES.maxHops)
          targets.push(relation.toEntityId);
        if (
          relation.direction === "symmetric" &&
          hop.get(relation.toEntityId) === GRAPH_RULES.maxHops
        )
          targets.push(relation.fromEntityId);
        return targets;
      }),
  );
  const excludedEntities = [];
  for (const entity of fixture.entities) {
    if (hop.has(entity.id)) continue;
    const containing = activeRevisionsByMaterial("entityIds", entity.id);
    if (containing.length === 0)
      excludedEntities.push({ entityId: entity.id, reason: "no-revision" });
    else if (!qualifiedEntities.has(entity.id))
      excludedEntities.push({
        entityId: entity.id,
        reason: "revision-excluded",
      });
    else if (beyondTargets.has(entity.id))
      excludedEntities.push({ entityId: entity.id, reason: "beyond-max-hops" });
    else excludedEntities.push({ entityId: entity.id, reason: "unreached" });
  }
  computed.graph.qualifiedRevisionIds = sorted(
    qualifiedRevisions.map((revision) => revision.id),
  );
  computed.graph.excludedRevisions = activeRevisions
    .filter((revision) => revisionReasons.get(revision.id).length > 0)
    .map((revision) => ({
      revisionId: revision.id,
      reasons: revisionReasons.get(revision.id),
    }));
  computed.graph.excludedEdges = excludedEdges;
  computed.graph.excludedEntities = excludedEntities;

  // K1 default rule (DSN §2.2-§2.3): the worker frame keeps the first N_F=8
  // Scenes in tuple order and the parent judges eligibility only afterwards.
  // Every pin of a reached non-seed Entity counts here, including pins on
  // Scenes that later fail eligibility; it bounds the frame's distinct Scenes,
  // so staying at or below 8 keeps every expectation independent of N_F.
  const framePins = fixture.pins.filter(
    (pin) => pin.entryId !== seedId && hop.has(pin.entryId),
  );
  computed.framePinCount = framePins.length;
  if (framePins.length > GRAPH_RULES.maxReturnedScenes)
    errors.push(
      `${label} reached Entities carry ${framePins.length} pins; the expectations would depend on the N_F=${GRAPH_RULES.maxReturnedScenes} frame truncation`,
    );

  // Scene association: explicit pins of reached non-seed Entities only.
  const candidates = [];
  for (const [entityId, depth] of hop) {
    if (entityId === seedId) continue;
    for (const pin of fixture.pins) {
      if (pin.entryId !== entityId || !index.eligible.has(pin.sceneId))
        continue;
      candidates.push({
        sceneId: pin.sceneId,
        entityId,
        path: {
          seedEntityId: seedId,
          edgeIds: pathTo(parent, seedId, entityId),
          targetEntityId: entityId,
          hop: depth,
        },
      });
    }
  }
  const candidatesByScene = new Map();
  for (const candidate of candidates) {
    const list = candidatesByScene.get(candidate.sceneId) ?? [];
    list.push(candidate);
    candidatesByScene.set(candidate.sceneId, list);
  }
  for (const [sceneId, list] of candidatesByScene) {
    if (list.length > 1)
      errors.push(
        `${label} Scene ${sceneId} has ${list.length} candidate paths; the representative path would depend on runtime IDs`,
      );
  }
  const inBaseline = new Set(rPlusIrIds);
  computed.attachments = candidates
    .filter((candidate) => inBaseline.has(candidate.sceneId))
    .map((candidate) => ({ sceneId: candidate.sceneId, path: candidate.path }));
  const fresh = candidates.filter(
    (candidate) => !inBaseline.has(candidate.sceneId),
  );
  const slotFree =
    rPlusIrIds.length < GRAPH_RULES.fusionMaxScenes &&
    arms.rPlusIr.irSupplementSceneId === null;
  if (slotFree && fresh.length > 0) {
    const minimumHop = Math.min(
      ...fresh.map((candidate) => candidate.path.hop),
    );
    const first = fresh.filter(
      (candidate) => candidate.path.hop === minimumHop,
    );
    if (new Set(first.map((candidate) => candidate.sceneId)).size > 1) {
      errors.push(
        `${label} several new Scenes share the minimum hop; the appended Scene would depend on runtime IDs`,
      );
    }
    computed.added = first[0];
    computed.blocked = fresh
      .filter((candidate) => candidate !== first[0])
      .map((candidate) => ({
        sceneId: candidate.sceneId,
        entityId: candidate.entityId,
        reason: "one-slot-used",
      }));
    computed.finalSceneIds = [...rPlusIrIds, first[0].sceneId];
  } else {
    const reason =
      arms.rPlusIr.irSupplementSceneId !== null
        ? "ir-supplement-used"
        : "raw-full";
    computed.blocked = fresh.map((candidate) => ({
      sceneId: candidate.sceneId,
      entityId: candidate.entityId,
      reason,
    }));
  }
  return { errors, computed, qualifiedRevisions, revisionReasons };
}

function metricFor(fixture, index, sceneIds) {
  const relevanceGrades = Object.fromEntries(
    fixture.scenes.map((scene) => [scene.id, scene.gold]),
  );
  return scoreQuery(
    {
      eligibleSceneIds: fixture.eligibleSceneIds,
      relevanceGrades,
      requiredRawPassages: [],
    },
    sceneIds.map((sceneId) => ({
      sceneId,
      chunkText: index.scenes.get(sceneId)?.body ?? "",
    })),
  );
}

function compareMetric(errors, label, declared, compute) {
  let actual;
  try {
    actual = compute();
  } catch (error) {
    errors.push(`${label} cannot be scored: ${error.message}`);
    return;
  }
  for (const key of ["recallAt8", "ndcgAt8"]) {
    if (Math.abs(declared[key] - actual[key]) > EPSILON)
      errors.push(
        `${label} ${key} is ${declared[key]}, rule-derived value is ${actual[key]}`,
      );
  }
}

function checkLexicalIsolation(fixture, errors) {
  const queryTokens = ftsQueryTokens(fixture.query.body);
  if (queryTokens.length === 0)
    errors.push(`${fixture.caseId} query has no FTS-visible token`);
  for (const word of STRUCTURE_WORDS) {
    if (queryTokens.some((token) => lexicalConflict(token, word)))
      errors.push(
        `${fixture.caseId} query token overlaps stored structure word "${word}"`,
      );
  }
  const capitalized = fixture.query.body
    .split(/\s+/u)
    .slice(1)
    .filter((word) => /^[A-Z]/.test(word));
  if (capitalized.length > 0)
    errors.push(
      `${fixture.caseId} query must not carry proper-noun seed terms: ${capitalized.join(", ")}`,
    );
  for (const entity of fixture.entities) {
    if (lexicalTokens(fixture.query.body).includes(entity.label.toLowerCase()))
      errors.push(`${fixture.caseId} query names Entity ${entity.id}`);
  }
  for (const scene of fixture.scenes) {
    if (scene.role === "control") {
      if (!scene.body.includes(fixture.query.body))
        errors.push(
          `${fixture.caseId} control ${scene.id} must quote the query verbatim`,
        );
      continue;
    }
    if (scene.body.includes(fixture.query.body))
      errors.push(`${fixture.caseId} non-control ${scene.id} quotes the query`);
    const sceneTokens = lexicalTokens(`${scene.title} ${scene.body}`);
    for (const queryToken of queryTokens) {
      const hit = sceneTokens.find((token) =>
        lexicalConflict(queryToken, token),
      );
      if (hit)
        errors.push(
          `${fixture.caseId} non-control ${scene.id} shares Raw-visible token "${hit}" with query token "${queryToken}"`,
        );
    }
  }
}

function checkReferences(fixture, index, errors) {
  const id = fixture.caseId;
  const prefix = `g0${id.at(-1)}-`;
  const allIds = [
    fixture.query.sceneId,
    ...fixture.scenes.map((scene) => scene.id),
    ...fixture.entities.map((entity) => entity.id),
    ...fixture.relations.map((relation) => relation.id),
    ...fixture.foreshadows.map((foreshadow) => foreshadow.id),
    ...fixture.revisions.map((revision) => revision.id),
    ...fixture.mutations.map((mutation) => mutation.id),
  ];
  if (new Set(allIds).size !== allIds.length)
    errors.push(`${id} logical IDs must be unique across the fixture`);
  for (const value of allIds) {
    if (!value.startsWith(prefix))
      errors.push(`${id} logical ID ${value} must start with ${prefix}`);
  }
  if (!fixture.fixtureId.startsWith(`nir1-${prefix}`))
    errors.push(`${id} fixtureId must start with nir1-${prefix}`);
  if (index.scenes.has(fixture.query.sceneId))
    errors.push(`${id} query Scene must not be a corpus Scene`);

  const expectedEligible = fixture.scenes
    .filter((scene) => scene.readingOrder < fixture.query.readingOrder)
    .map((scene) => scene.id);
  if (!sameSet(expectedEligible, fixture.eligibleSceneIds))
    errors.push(`${id} eligibleSceneIds must be exactly the Scenes before S2`);
  const orders = fixture.scenes.map((scene) => scene.readingOrder);
  if (
    new Set(orders).size !== orders.length ||
    orders.includes(fixture.query.readingOrder)
  )
    errors.push(`${id} reading orders must be unique`);
  for (const scene of fixture.scenes) {
    const eligible = index.eligible.has(scene.id);
    if (!eligible && scene.gold !== 0)
      errors.push(`${id} Scene ${scene.id} after S2 must have Gold 0`);
    if (!eligible && !["review", "payoff"].includes(scene.role))
      errors.push(`${id} only review or payoff Scenes may follow S2`);
  }
  const positives = fixture.scenes.filter(
    (scene) => index.eligible.has(scene.id) && scene.gold > 0,
  );
  if (positives.length === 0)
    errors.push(`${id} needs at least one eligible Gold-positive Scene`);
  const answerLabels = fixture.answerEntityIds.map((entityId) => {
    const entity = index.entities.get(entityId);
    if (!entity) errors.push(`${id} answer Entity ${entityId} is unknown`);
    return entity?.label;
  });
  for (const scene of positives) {
    if (!["answer", "ir-only"].includes(scene.role))
      errors.push(
        `${id} Gold-positive Scene ${scene.id} must be an answer or ir-only Scene`,
      );
    if (
      !answerLabels.some(
        (label) =>
          label && lexicalTokens(scene.body).includes(label.toLowerCase()),
      )
    )
      errors.push(
        `${id} Gold-positive Scene ${scene.id} must show an answer Entity`,
      );
  }
  for (const scene of fixture.scenes) {
    if (
      ["control", "decoy", "review", "filler", "payoff"].includes(scene.role) &&
      scene.gold !== 0
    )
      errors.push(`${id} ${scene.role} Scene ${scene.id} must have Gold 0`);
  }

  const registry = fixture.scope.registry;
  const refSets = {
    timeline: new Set(registry.timelineRefs),
    worldline: new Set(registry.worldlineRefs),
    narrativeLayer: new Set(registry.narrativeLayerRefs),
  };
  const checkScope = (scope, label) => {
    if (scope.marker !== "explicit") return;
    for (const group of ["queryIdentity", "materialConstraint"]) {
      for (const axis of SCOPE_AXES) {
        const constraint = scope[group][axis];
        if (constraint.kind === "exact" && !refSets[axis].has(constraint.ref))
          errors.push(
            `${id} ${label} ${group}.${axis} references an unregistered ref`,
          );
        if (group === "queryIdentity" && constraint.kind === "any")
          errors.push(`${id} ${label} query identity must not be any`);
      }
    }
    for (const principal of [scope.knowledgeHolder, scope.audience]) {
      if (principal.kind === "character" && !index.entities.has(principal.ref))
        errors.push(`${id} ${label} principal references an unknown character`);
    }
  };
  checkScope(fixture.scope.default, "default Scope");
  for (const [sceneId] of Object.entries(fixture.scope.overrides)) {
    if (!index.orders.has(sceneId))
      errors.push(`${id} Scope override targets unknown Scene ${sceneId}`);
    checkScope(effectiveScope(fixture, sceneId), `Scope of ${sceneId}`);
  }
  const queryScope = effectiveScope(fixture, fixture.query.sceneId);
  if (queryScope.marker !== "explicit")
    errors.push(`${id} the query Scene must keep an explicit Scope`);
  else {
    for (const axis of SCOPE_AXES) {
      if (queryScope.queryIdentity[axis].kind !== "exact")
        errors.push(`${id} the query identity ${axis} must be exact`);
    }
    if (
      queryScope.knowledgeHolder.kind !== "reader" ||
      queryScope.audience.kind !== "reader"
    )
      errors.push(`${id} the query keeps the reader holder and audience`);
  }

  for (const relation of fixture.relations) {
    for (const endpoint of [relation.fromEntityId, relation.toEntityId]) {
      if (!index.entities.has(endpoint))
        errors.push(
          `${id} relation ${relation.id} endpoint ${endpoint} is unknown`,
        );
    }
    if (relation.fromEntityId === relation.toEntityId)
      errors.push(`${id} relation ${relation.id} must not be a self-loop`);
  }
  const seed = fixture.manualSeed.entityId;
  if (!index.entities.has(seed)) errors.push(`${id} manual seed is unknown`);
  if (fixture.answerEntityIds.includes(seed))
    errors.push(`${id} the seed itself cannot be an answer Entity`);
  const pinKeys = new Set();
  for (const pin of fixture.pins) {
    if (!index.scenes.has(pin.sceneId))
      errors.push(`${id} pin targets unknown Scene ${pin.sceneId}`);
    if (!index.entities.has(pin.entryId))
      errors.push(`${id} pin targets unknown Entity ${pin.entryId}`);
    if (pin.entryId === seed)
      errors.push(
        `${id} the seed must not be pinned (seed pins are not Graph contributions)`,
      );
    const key = `${pin.sceneId}\u0000${pin.entryId}`;
    if (pinKeys.has(key))
      errors.push(`${id} duplicate pin ${pin.sceneId}/${pin.entryId}`);
    pinKeys.add(key);
  }
  for (const foreshadow of fixture.foreshadows) {
    // The payoff may be any corpus Scene or S2 itself (read_a3_reveal_state
    // treats a payoff at S2 as disclosed). It keeps an explicit Scope so the
    // product maps its reading position instead of withholding for a missing
    // mapping, which these rules do not model.
    if (foreshadow.payoffSceneId !== null) {
      if (!index.orders.has(foreshadow.payoffSceneId))
        errors.push(
          `${id} foreshadow ${foreshadow.id} payoff Scene is unknown`,
        );
      else if (
        effectiveScope(fixture, foreshadow.payoffSceneId).marker !== "explicit"
      )
        errors.push(
          `${id} foreshadow ${foreshadow.id} payoff Scene must keep an explicit Scope`,
        );
    }
    for (const entityId of foreshadow.linkedEntityIds) {
      if (!index.entities.has(entityId))
        errors.push(
          `${id} foreshadow ${foreshadow.id} links unknown Entity ${entityId}`,
        );
      if (entityId === seed)
        errors.push(`${id} foreshadow ${foreshadow.id} must not veto the seed`);
    }
  }
  const irScenes = new Set();
  for (const ir of fixture.qualifiedIr) {
    const scene = index.scenes.get(ir.sceneId);
    if (!scene)
      errors.push(`${id} qualified IR targets unknown Scene ${ir.sceneId}`);
    else if (!["control", "ir-only"].includes(scene.role))
      errors.push(
        `${id} qualified IR may only target control or ir-only Scenes`,
      );
    if (irScenes.has(ir.sceneId))
      errors.push(`${id} duplicate qualified IR for ${ir.sceneId}`);
    irScenes.add(ir.sceneId);
  }
  const irOnly = fixture.scenes.filter((scene) => scene.role === "ir-only");
  if (irOnly.length > 1)
    errors.push(`${id} at most one ir-only Scene is allowed`);
  for (const scene of irOnly) {
    if (!irScenes.has(scene.id))
      errors.push(`${id} ir-only Scene ${scene.id} needs qualified IR`);
  }

  const variantIds = new Set(fixture.variants.map((variant) => variant.id));
  if (variantIds.size !== fixture.variants.length)
    errors.push(`${id} variant IDs must be unique`);
  for (const item of [...fixture.revisions, ...fixture.mutations]) {
    for (const variantId of item.onlyInVariants ?? []) {
      if (!variantIds.has(variantId))
        errors.push(`${id} ${item.id} references unknown variant ${variantId}`);
    }
  }
  for (const revision of fixture.revisions) {
    if (!index.orders.has(revision.reviewSceneId))
      errors.push(`${id} revision ${revision.id} review Scene is unknown`);
    for (const entityId of revision.entityIds) {
      if (!index.entities.has(entityId))
        errors.push(
          `${id} revision ${revision.id} names unknown Entity ${entityId}`,
        );
    }
    for (const relationId of revision.relationIds) {
      const relation = index.relations.get(relationId);
      if (!relation) {
        errors.push(
          `${id} revision ${revision.id} names unknown relation ${relationId}`,
        );
        continue;
      }
      for (const endpoint of [relation.fromEntityId, relation.toEntityId]) {
        if (!revision.entityIds.includes(endpoint))
          errors.push(
            `${id} revision ${revision.id} must include endpoint ${endpoint} of ${relationId}`,
          );
      }
    }
  }
  const timelineIds = fixture.setupTimeline.map(
    (step) => `${step.kind}:${step.id}`,
  );
  if (new Set(timelineIds).size !== timelineIds.length)
    errors.push(`${id} setupTimeline repeats a step`);
  const expectedTimeline = [
    ...fixture.revisions.map((revision) => `revision:${revision.id}`),
    ...fixture.mutations.map((mutation) => `mutation:${mutation.id}`),
    `qualified-ir:${prefix}ir`,
  ];
  if (!sameSet(timelineIds, expectedTimeline))
    errors.push(
      `${id} setupTimeline must order every revision, mutation and the single ${prefix}ir step exactly once`,
    );
  // IR is created at an explicit point. A Graph Source mutation after it must
  // stay independent of every IR-bearing Scene, so it cannot stale IR through
  // a pin or a mention; an IR withdrawal can only follow IR creation.
  const irPosition = fixture.setupTimeline.findIndex(
    (step) => step.kind === "qualified-ir",
  );
  const irText = fixture.qualifiedIr
    .flatMap((ir) => [ir.summary, index.scenes.get(ir.sceneId)?.body ?? ""])
    .join(" ");
  fixture.setupTimeline.forEach((step, position) => {
    if (step.kind !== "mutation") return;
    const mutation = index.mutations.get(step.id);
    if (!mutation) return;
    if (mutation.kind === "ir-approval-withdrawal") {
      if (position < irPosition)
        errors.push(`${id} ${mutation.id} must follow the qualified-ir step`);
      return;
    }
    if (position < irPosition) return;
    const touched =
      mutation.kind === "codex-entry-summary-edit"
        ? [mutation.entityId]
        : [
            index.relations.get(mutation.relationId)?.fromEntityId,
            index.relations.get(mutation.relationId)?.toEntityId,
          ];
    for (const entityId of touched) {
      const entity = index.entities.get(entityId);
      if (!entity) continue;
      const pinnedToIr = fixture.pins.some(
        (pin) =>
          pin.entryId === entityId &&
          fixture.qualifiedIr.some((ir) => ir.sceneId === pin.sceneId),
      );
      if (
        pinnedToIr ||
        lexicalTokens(irText).includes(entity.label.toLowerCase())
      )
        errors.push(
          `${id} ${mutation.id} after the qualified-ir step must not touch an Entity pinned to or named by IR material`,
        );
    }
  });
  for (const mutation of fixture.mutations) {
    if (mutation.kind === "codex-entry-summary-edit") {
      const entity = index.entities.get(mutation.entityId);
      if (!entity)
        errors.push(`${id} mutation ${mutation.id} names an unknown Entity`);
      else if (entity.summary !== mutation.from)
        errors.push(
          `${id} mutation ${mutation.id} must start from the declared summary`,
        );
      if (mutation.from === mutation.to)
        errors.push(`${id} mutation ${mutation.id} is a no-op`);
    } else if (mutation.kind === "codex-relation-type-edit") {
      const relation = index.relations.get(mutation.relationId);
      if (!relation)
        errors.push(`${id} mutation ${mutation.id} names an unknown relation`);
      else if (relation.type !== mutation.from)
        errors.push(
          `${id} mutation ${mutation.id} must start from the declared type`,
        );
      if (mutation.from === mutation.to)
        errors.push(`${id} mutation ${mutation.id} is a no-op`);
    } else if (mutation.kind === "ir-approval-withdrawal") {
      if (!irScenes.has(mutation.sceneId))
        errors.push(
          `${id} mutation ${mutation.id} withdraws an undeclared IR approval`,
        );
    }
  }

  const materials = new Set([
    ...fixture.revisions.map((revision) => revision.id),
    ...fixture.relations.map((relation) => relation.id),
    ...fixture.entities.map((entity) => entity.id),
    ...fixture.foreshadows.map((foreshadow) => foreshadow.id),
    ...fixture.mutations.map((mutation) => mutation.id),
    ...fixture.scenes.map((scene) => scene.id),
  ]);
  const checkIds = [...fixture.positive, ...fixture.negative].map(
    (check) => check.id,
  );
  if (new Set(checkIds).size !== checkIds.length)
    errors.push(`${id} positive/negative IDs must be unique`);
  for (const [kind, checks] of [
    ["P", fixture.positive],
    ["N", fixture.negative],
  ]) {
    for (const check of checks) {
      if (!check.id.startsWith(`${id}-${kind}`))
        errors.push(
          `${id} check ${check.id} must use the ${id}-${kind} prefix`,
        );
      for (const material of check.materials) {
        if (!materials.has(material))
          errors.push(
            `${id} check ${check.id} references unknown material ${material}`,
          );
      }
    }
  }
}

function checkArms(fixture, index, variant, errors) {
  const label = `${fixture.caseId}/${variant.id}`;
  const { raw, rPlusIr, rPlusIrPlusGraph } = variant.expectations.arms;
  const controls = fixture.scenes
    .filter((scene) => scene.role === "control")
    .map((scene) => scene.id);
  if (!sameSet(raw.sceneIds, controls))
    errors.push(`${label} predeclared R must be exactly the control Scenes`);
  if (raw.orderPredeclared !== (raw.sceneIds.length === 1))
    errors.push(`${label} R order is predeclared only for a single control`);
  for (const sceneId of [
    ...raw.sceneIds,
    ...rPlusIr.sceneIds,
    ...rPlusIrPlusGraph.sceneIds,
  ]) {
    if (!index.eligible.has(sceneId))
      errors.push(`${label} arm Scene ${sceneId} is not eligible`);
  }
  const irOnly = fixture.scenes.find((scene) => scene.role === "ir-only");
  if (variant.indexState.chronicle === "unusable") {
    if (stableJson(rPlusIr.sceneIds) !== stableJson(raw.sceneIds))
      errors.push(`${label} Chronicle unusable makes R+IR exact R`);
    if (rPlusIr.irSupplementSceneId !== null || rPlusIr.resultKind !== "raw")
      errors.push(
        `${label} Chronicle unusable has no IR supplement and a raw result`,
      );
    const withdrawn = fixture.mutations.some(
      (mutation) =>
        mutation.kind === "ir-approval-withdrawal" &&
        appliesTo(mutation, variant.id),
    );
    if (!withdrawn)
      errors.push(
        `${label} Chronicle unusable must be caused by a declared IR withdrawal`,
      );
  } else {
    const expected = [...raw.sceneIds];
    if (irOnly) expected.push(irOnly.id);
    if (stableJson(rPlusIr.sceneIds) !== stableJson(expected))
      errors.push(
        `${label} R+IR must keep R and append only the ir-only Scene`,
      );
    if (rPlusIr.irSupplementSceneId !== (irOnly?.id ?? null))
      errors.push(`${label} irSupplementSceneId must name the ir-only Scene`);
    // resultKind is a recorded-only design prediction. Control IR may stay
    // below the IR floor (S1), so a usable Chronicle without an ir-only Scene
    // may observe raw or fused; R+IR+Graph uses the observed R+IR either way.
    // An admitted ir-only supplement (ir-supplement-admission) is fused.
    if (irOnly && rPlusIr.resultKind !== "fused")
      errors.push(`${label} an admitted IR supplement yields a fused R+IR`);
    if (irOnly && raw.sceneIds.length >= GRAPH_RULES.fusionMaxScenes)
      errors.push(`${label} Raw-full leaves no IR supplement slot`);
  }
  if (variant.indexState.graph === "unusable") {
    const dirtied = fixture.mutations.some(
      (mutation) =>
        ["codex-entry-summary-edit", "codex-relation-type-edit"].includes(
          mutation.kind,
        ) && appliesTo(mutation, variant.id),
    );
    if (!dirtied)
      errors.push(
        `${label} Graph unusable must be caused by a declared Graph Source mutation`,
      );
  }
  if (rPlusIr.orderPredeclared !== raw.orderPredeclared)
    errors.push(`${label} R+IR order follows the R order declaration`);
  if (rPlusIrPlusGraph.orderPredeclared !== raw.orderPredeclared)
    errors.push(`${label} R+IR+Graph order follows the R order declaration`);
  const expectedBaseline =
    variant.indexState.chronicle === "unusable" ? "raw" : "rPlusIr";
  if (rPlusIrPlusGraph.baseline !== expectedBaseline)
    errors.push(`${label} R+IR+Graph baseline must be ${expectedBaseline}`);
  if (!raw.orderPredeclared) {
    for (const sceneId of rPlusIr.sceneIds) {
      if (
        index.scenes.get(sceneId)?.gold !== 0 &&
        sceneId !== rPlusIr.irSupplementSceneId
      )
        errors.push(
          `${label} unordered R members must have Gold 0 so metrics are order-free`,
        );
    }
  }
  const measurementState = MEASUREMENT_INDEX_STATE[variant.measurementPoint];
  if (stableJson(measurementState) !== stableJson(variant.indexState))
    errors.push(`${label} indexState must follow measurementPoint`);
}

function compareVariant(fixture, index, variant, result, errors) {
  const label = `${fixture.caseId}/${variant.id}`;
  const expectations = variant.expectations;
  const { computed } = result;
  const declaredGraph = expectations.graph;
  if (declaredGraph.status !== computed.graph.status)
    errors.push(
      `${label} graph.status is ${declaredGraph.status}, rules give ${computed.graph.status}`,
    );
  if (declaredGraph.reasonClass !== computed.graph.reasonClass)
    errors.push(
      `${label} graph.reasonClass is ${declaredGraph.reasonClass}, rules give ${computed.graph.reasonClass}`,
    );
  const nodeKey = (nodes) =>
    stableJson([...nodes].map((node) => `${node.entityId}@${node.hop}`).sort());
  if (nodeKey(declaredGraph.nodes) !== nodeKey(computed.graph.nodes))
    errors.push(`${label} graph.nodes differ from the rule-derived traversal`);
  if (!sameSet(declaredGraph.edgeIds, computed.graph.edgeIds))
    errors.push(
      `${label} graph.edgeIds differ from the rule-derived traversal`,
    );
  if (computed.graph.status === "available") {
    if (
      !sameSet(
        declaredGraph.qualifiedRevisionIds ?? [],
        computed.graph.qualifiedRevisionIds,
      )
    )
      errors.push(
        `${label} qualifiedRevisionIds differ from the documented qualification rules`,
      );
    const revisionKey = (rows) =>
      stableJson(
        [...(rows ?? [])]
          .map((row) => `${row.revisionId}:${[...row.reasons].join("+")}`)
          .sort(),
      );
    if (
      revisionKey(declaredGraph.excludedRevisions) !==
      revisionKey(computed.graph.excludedRevisions)
    )
      errors.push(
        `${label} excludedRevisions differ: rules give ${revisionKey(computed.graph.excludedRevisions)}`,
      );
    const edgeKey = (rows) =>
      stableJson(
        [...(rows ?? [])].map((row) => `${row.edgeId}:${row.reason}`).sort(),
      );
    if (
      edgeKey(declaredGraph.excludedEdges) !==
      edgeKey(computed.graph.excludedEdges)
    )
      errors.push(
        `${label} excludedEdges differ: rules give ${edgeKey(computed.graph.excludedEdges)}`,
      );
    const entityKey = (rows) =>
      stableJson(
        [...(rows ?? [])].map((row) => `${row.entityId}:${row.reason}`).sort(),
      );
    if (
      entityKey(declaredGraph.excludedEntities) !==
      entityKey(computed.graph.excludedEntities)
    )
      errors.push(
        `${label} excludedEntities differ: rules give ${entityKey(computed.graph.excludedEntities)}`,
      );
  } else {
    for (const field of [
      "qualifiedRevisionIds",
      "excludedRevisions",
      "excludedEdges",
      "excludedEntities",
    ]) {
      if (declaredGraph[field] !== undefined)
        errors.push(`${label} an unavailable Graph declares no ${field}`);
    }
  }
  if (computed.graph.reasonClass === "graph-limit-exceeded") {
    if (stableJson(declaredGraph.frontier) !== stableJson(computed.frontier))
      errors.push(
        `${label} a limit refusal must record the rule-derived discovered count`,
      );
  } else if (declaredGraph.frontier !== undefined) {
    if (computed.frontier === null)
      errors.push(
        `${label} frontier is only declared for an evaluated traversal`,
      );
    else if (
      stableJson(declaredGraph.frontier) !== stableJson(computed.frontier)
    )
      errors.push(
        `${label} frontier must record the rule-derived discovered count`,
      );
  }

  const attachmentKey = (rows) =>
    stableJson(
      [...rows].map((row) => `${row.sceneId}:${stableJson(row.path)}`).sort(),
    );
  if (
    attachmentKey(expectations.pathAttachments) !==
    attachmentKey(computed.attachments)
  )
    errors.push(
      `${label} pathAttachments differ: rules give ${attachmentKey(computed.attachments)}`,
    );
  const declaredAdded = expectations.addedScene;
  if ((declaredAdded?.sceneId ?? null) !== (computed.added?.sceneId ?? null)) {
    errors.push(
      `${label} addedScene is ${declaredAdded?.sceneId ?? null}, rules give ${computed.added?.sceneId ?? null}`,
    );
  } else if (declaredAdded) {
    if (stableJson(declaredAdded.path) !== stableJson(computed.added.path))
      errors.push(
        `${label} addedScene.path differs from the rule-derived path`,
      );
    const scene = index.scenes.get(declaredAdded.sceneId);
    const excerpt = declaredAdded.sceneExcerpt;
    if (excerpt.sceneId !== scene.id || excerpt.body !== scene.body)
      errors.push(
        `${label} added Scene excerpt must be the exact single-line body`,
      );
    if (excerpt.canonicalUtf16Range.end !== utf16Length(scene.body))
      errors.push(
        `${label} added Scene excerpt must span the first non-empty line [0, length)`,
      );
  }
  const blockedKey = (rows) =>
    stableJson(
      [...rows]
        .map((row) => `${row.sceneId}:${row.entityId}:${row.reason}`)
        .sort(),
    );
  if (
    blockedKey(expectations.blockedCandidates) !== blockedKey(computed.blocked)
  )
    errors.push(
      `${label} blockedCandidates differ: rules give ${blockedKey(computed.blocked)}`,
    );

  const declaredFinal = expectations.arms.rPlusIrPlusGraph;
  if (stableJson(declaredFinal.sceneIds) !== stableJson(computed.finalSceneIds))
    errors.push(
      `${label} R+IR+Graph membership/order differs: rules give ${stableJson(computed.finalSceneIds)}`,
    );
  if (declaredFinal.appendedSceneId !== (computed.added?.sceneId ?? null))
    errors.push(
      `${label} appendedSceneId must name the rule-derived appended Scene`,
    );

  const attached = new Set(computed.attachments.map((row) => row.sceneId));
  const expectedWithoutPath = computed.finalSceneIds.filter(
    (sceneId) => !attached.has(sceneId) && sceneId !== computed.added?.sceneId,
  );
  if (!sameSet(expectations.scenesWithoutPath, expectedWithoutPath))
    errors.push(
      `${label} scenesWithoutPath must list every returned Scene without a Graph path`,
    );
  const decoys = fixture.scenes
    .filter((scene) => scene.role === "decoy")
    .map((scene) => scene.id);
  for (const decoy of decoys) {
    if (!expectations.forbiddenSceneIds.includes(decoy))
      errors.push(`${label} decoy ${decoy} must be a forbidden Scene`);
  }
  for (const sceneId of expectations.forbiddenSceneIds) {
    if (!index.scenes.has(sceneId))
      errors.push(`${label} forbidden Scene ${sceneId} is unknown`);
    if (computed.finalSceneIds.includes(sceneId) || attached.has(sceneId))
      errors.push(
        `${label} forbidden Scene ${sceneId} is returned or attached by the rules`,
      );
  }

  const evidence = expectations.evidence;
  const contributes =
    computed.attachments.length > 0 || computed.added !== null;
  for (const requirement of REQUIRED_EVIDENCE) {
    if (contributes && !evidence.requirements.includes(requirement))
      errors.push(`${label} evidence requirement ${requirement} is missing`);
  }
  if (contributes !== evidence.requirements.length > 0)
    errors.push(
      `${label} evidence requirements apply exactly when Graph contributes`,
    );
  if (
    computed.attachments.length > 0 &&
    !evidence.requirements.includes("raw-excerpt-unchanged")
  )
    errors.push(
      `${label} path attachments must keep the Raw excerpt unchanged`,
    );
  if (
    (computed.added !== null) !==
    evidence.requirements.includes("added-scene-body-anchor")
  )
    errors.push(
      `${label} added-scene-body-anchor applies exactly to an appended Scene`,
    );
  for (const assertion of evidence.assertions) {
    if (assertion.kind === "current-entity-evidence") {
      const entity = index.entities.get(assertion.entityId);
      const mutation = fixture.mutations.find(
        (row) =>
          row.kind === "codex-entry-summary-edit" &&
          row.entityId === assertion.entityId,
      );
      if (
        !entity ||
        !mutation ||
        mutation.to !== assertion.currentText ||
        mutation.from !== assertion.supersededText
      )
        errors.push(
          `${label} current-entity-evidence must quote the declared summary edit`,
        );
      for (const text of assertion.mustNotContain) {
        if (
          !assertion.supersededText.includes(text) ||
          assertion.currentText.includes(text)
        )
          errors.push(
            `${label} mustNotContain "${text}" must only occur in the superseded summary`,
          );
      }
      if (
        !computed.graph.nodes.some(
          (node) => node.entityId === assertion.entityId,
        )
      )
        errors.push(
          `${label} current-entity-evidence names an Entity outside the Graph`,
        );
    } else if (assertion.kind === "edge-sequence-preserved") {
      const row = computed.attachments.find(
        (item) => item.sceneId === assertion.sceneId,
      );
      if (
        !row ||
        stableJson(row.path.edgeIds) !== stableJson(assertion.edgeIds)
      )
        errors.push(
          `${label} edge-sequence-preserved must match an attached two-edge path`,
        );
    } else if (assertion.kind === "no-name-inferred-association") {
      const scene = index.scenes.get(assertion.sceneId);
      if (
        !scene ||
        !lexicalTokens(scene.body).includes(
          assertion.nameMentioned.toLowerCase(),
        )
      )
        errors.push(
          `${label} no-name-inferred-association must name a mentioned label`,
        );
      if (fixture.pins.some((pin) => pin.sceneId === assertion.sceneId))
        errors.push(
          `${label} no-name-inferred-association Scene must have no pin`,
        );
      if (!expectations.scenesWithoutPath.includes(assertion.sceneId))
        errors.push(
          `${label} no-name-inferred-association Scene must stay without a path`,
        );
    } else if (assertion.kind === "homonym-not-merged") {
      const labels = assertion.entityIds.map(
        (entityId) => index.entities.get(entityId)?.label,
      );
      if (!labels.every((value) => value === assertion.label))
        errors.push(
          `${label} homonym-not-merged Entities must share the label`,
        );
      const reached = assertion.entityIds.filter((entityId) =>
        computed.graph.nodes.some((node) => node.entityId === entityId),
      );
      if (reached.length !== 1)
        errors.push(
          `${label} exactly one homonym is reached by the qualified path`,
        );
    }
  }

  const metrics = expectations.metrics;
  compareMetric(errors, `${label} metrics.raw`, metrics.raw, () =>
    metricFor(fixture, index, expectations.arms.raw.sceneIds),
  );
  compareMetric(errors, `${label} metrics.rPlusIr`, metrics.rPlusIr, () =>
    metricFor(fixture, index, expectations.arms.rPlusIr.sceneIds),
  );
  compareMetric(
    errors,
    `${label} metrics.rPlusIrPlusGraph`,
    metrics.rPlusIrPlusGraph,
    () => metricFor(fixture, index, computed.finalSceneIds),
  );
  if (
    metrics.rPlusIrPlusGraph.ndcgAt8 + EPSILON < metrics.rPlusIr.ndcgAt8 ||
    metrics.rPlusIrPlusGraph.recallAt8 + EPSILON < metrics.rPlusIr.recallAt8
  )
    errors.push(
      `${label} a predeclared Graph expectation must not regress R+IR`,
    );
}

function checkSlotClass(fixture, errors) {
  const base = fixture.variants[0];
  if (base.measurementPoint !== "after-maintenance-current")
    errors.push(
      `${fixture.caseId} the first variant must be the steady-state base`,
    );
  const { raw, rPlusIr } = base.expectations.arms;
  const derived =
    raw.sceneIds.length >= GRAPH_RULES.fusionMaxScenes
      ? "raw-full"
      : rPlusIr.irSupplementSceneId !== null
        ? "ir-supplemented"
        : "supplementable";
  if (derived !== fixture.slotClass)
    errors.push(
      `${fixture.caseId} slotClass is ${fixture.slotClass}, the base arms give ${derived}`,
    );
  if (
    fixture.slotClass === "raw-full" &&
    raw.sceneIds.length !== GRAPH_RULES.fusionMaxScenes
  )
    errors.push(
      `${fixture.caseId} Raw-full needs exactly eight control Scenes`,
    );
}

function checkPositiveNegativeCoverage(fixture, results, errors) {
  const contributing = new Set();
  const excluded = new Set();
  for (const { variant, result } of results) {
    const { computed } = result;
    for (const sceneId of variant.expectations.forbiddenSceneIds)
      excluded.add(sceneId);
    for (const sceneId of variant.expectations.scenesWithoutPath)
      excluded.add(sceneId);
    for (const row of computed.blocked) excluded.add(row.sceneId);
    if (computed.graph.status !== "available") {
      // A fallback positive names what the safe fallback returns.
      for (const sceneId of computed.finalSceneIds) contributing.add(sceneId);
      continue;
    }
    for (const revision of result.qualifiedRevisions)
      contributing.add(revision.id);
    for (const node of computed.graph.nodes) contributing.add(node.entityId);
    for (const edgeId of computed.graph.edgeIds) contributing.add(edgeId);
    for (const row of computed.attachments) contributing.add(row.sceneId);
    if (computed.added) contributing.add(computed.added.sceneId);
    for (const row of computed.graph.excludedRevisions)
      excluded.add(row.revisionId);
    for (const row of computed.graph.excludedEdges) excluded.add(row.edgeId);
    for (const row of computed.graph.excludedEntities)
      excluded.add(row.entityId);
  }
  for (const mutation of fixture.mutations) excluded.add(mutation.id);
  for (const check of fixture.positive) {
    if (!check.materials.some((material) => contributing.has(material)))
      errors.push(
        `${fixture.caseId} positive ${check.id} names no contributing material`,
      );
    for (const material of check.materials) {
      if (
        fixture.revisions.some((revision) => revision.id === material) &&
        !contributing.has(material)
      )
        errors.push(
          `${fixture.caseId} positive ${check.id} names revision ${material}, which never qualifies`,
        );
    }
  }
  for (const check of fixture.negative) {
    if (!check.materials.some((material) => excluded.has(material)))
      errors.push(
        `${fixture.caseId} negative ${check.id} names no excluded, blocked or pathless material`,
      );
  }
}

/**
 * The preconditions a variant must declare, derived from the fixture and the
 * rule-derived appended Scene. Every variant needs the B sealed binding,
 * enabled maintenance and the predicted Raw membership; an ir-only Scene
 * needs its IR admitted while Chronicle is usable; an unusable measurement
 * point needs its Index state held; an appended Scene needs CB-4 inputs.
 */
export function requiredPreconditions(fixture, variant, appendedScene) {
  const required = [
    { id: "b-sealed-binding", scope: "variant" },
    { id: "maintenance-enabled", scope: "variant" },
    { id: "raw-membership", scope: "variant" },
  ];
  const irOnly = fixture.scenes.find((scene) => scene.role === "ir-only");
  if (irOnly && variant.indexState.chronicle === "usable")
    required.push({
      id: "ir-supplement-admission",
      scope: "variant",
      sceneId: irOnly.id,
    });
  if (variant.measurementPoint !== "after-maintenance-current")
    required.push({ id: "index-state-holding", scope: "variant" });
  if (appendedScene)
    required.push({
      id: "cb4-inputs",
      scope: "added-scene",
      sceneId: appendedScene.sceneId,
    });
  return required;
}

function preconditionKey(row) {
  return `${row.id}|${row.scope}|${row.sceneId ?? ""}`;
}

function checkPreconditions(fixture, variant, result, errors) {
  const label = `${fixture.caseId}/${variant.id}`;
  const declared = variant.preconditions;
  const catalogOrder = PRECONDITIONS.map((row) => row.id);
  const positions = declared.map((row) => catalogOrder.indexOf(row.id));
  if (positions.some((value, at) => at > 0 && value <= positions[at - 1]))
    errors.push(
      `${label} preconditions must be unique and follow the manifest definition order`,
    );
  for (const row of declared) {
    const scope = PRECONDITIONS.find((entry) => entry.id === row.id)?.scope;
    if (row.scope !== scope)
      errors.push(`${label} precondition ${row.id} has scope ${scope}`);
  }
  const expected = requiredPreconditions(
    fixture,
    variant,
    result.computed.added,
  )
    .map(preconditionKey)
    .sort();
  const actual = declared.map(preconditionKey).sort();
  if (stableJson(expected) !== stableJson(actual))
    errors.push(
      `${label} preconditions must be exactly [${expected.join(", ")}]`,
    );
}

function resolveSchemaNode(schema, node) {
  let current = node;
  for (let depth = 0; depth < 16; depth += 1) {
    if (
      typeof current?.$ref === "string" &&
      current.$ref.startsWith("#/$defs/")
    )
      current = schema.$defs?.[current.$ref.slice("#/$defs/".length)];
    else if (Array.isArray(current?.allOf) && current.allOf.length === 1)
      current = current.allOf[0];
    else return current;
  }
  return current;
}

/**
 * Every expectation field the schema allows, at the granularity of manifest
 * `runtimeComparison`: arm fields, Graph DTO fields, blocked-candidate row
 * fields and the other top-level expectation fields.
 */
export function schemaExpectationFieldPaths(schema) {
  const expectations = resolveSchemaNode(
    schema,
    schema.$defs?.variant?.properties?.expectations,
  );
  const paths = [];
  for (const [key, node] of Object.entries(expectations?.properties ?? {})) {
    const resolved = resolveSchemaNode(schema, node);
    if (key === "arms") {
      for (const [arm, armNode] of Object.entries(resolved.properties ?? {}))
        for (const field of Object.keys(
          resolveSchemaNode(schema, armNode)?.properties ?? {},
        ))
          paths.push(`arms.${arm}.${field}`);
    } else if (key === "graph") {
      for (const field of Object.keys(resolved.properties ?? {}))
        paths.push(`graph.${field}`);
    } else if (key === "blockedCandidates") {
      for (const field of Object.keys(
        resolveSchemaNode(schema, resolved.items)?.properties ?? {},
      ))
        paths.push(`blockedCandidates[].${field}`);
    } else {
      paths.push(key);
    }
  }
  return paths;
}

/** The manifest classification must be the fixed one and cover the schema. */
function checkRuntimeComparison(manifest, schema, errors) {
  const comparison = manifest.runtimeComparison ?? {};
  for (const [field, expected] of [
    ["comparedFields", RUNTIME_COMPARED_FIELDS],
    ["comparisonControlFields", RUNTIME_COMPARISON_CONTROL_FIELDS],
    ["recordedOnlyFields", RUNTIME_RECORDED_ONLY_FIELDS],
  ]) {
    if (stableJson(comparison[field]) !== stableJson(expected))
      errors.push(
        `nir1-graph manifest runtimeComparison.${field} must be ${stableJson(expected)}`,
      );
  }
  if (comparison.reasonClass !== "status-only")
    errors.push(
      "nir1-graph manifest compares graph.reasonClass by status only until a runtime reason mapping is fixed",
    );
  const classified = [
    ...RUNTIME_COMPARED_FIELDS,
    ...RUNTIME_COMPARISON_CONTROL_FIELDS,
    ...RUNTIME_RECORDED_ONLY_FIELDS,
  ];
  if (new Set(classified).size !== classified.length)
    errors.push("runtime comparison classes must not overlap");
  if (!sameSet(classified, schemaExpectationFieldPaths(schema)))
    errors.push(
      "runtime comparison classes must cover exactly the expectation fields of the case schema",
    );
}

/**
 * Applies the precondition policy to one observed variant. CP-4 supplies the
 * declared preconditions it observed as unmet and the comparison result of
 * every expectation those preconditions do not block; nothing here observes a
 * runtime. A precondition the variant does not declare can never turn an
 * observed difference into `blocked`, and a blocked variant is never a pass.
 */
export function resolveVariantOutcome(
  variant,
  { unmet = [], comparisonPassed } = {},
) {
  const declared = new Set((variant.preconditions ?? []).map((row) => row.id));
  for (const id of unmet) {
    if (!declared.has(id))
      throw new Error(
        `precondition ${id} is not declared for variant ${variant.id}; an observed result cannot be reclassified as blocked`,
      );
  }
  // Scopes come from the closed catalog, never from the variant's own claim.
  const ordered = PRECONDITIONS.filter((row) => unmet.includes(row.id));
  const blocking = ordered.filter((row) => row.scope === "variant");
  if (blocking.length > 0)
    return {
      outcome: `blocked:${blocking[0].id}`,
      unmet: ordered.map((row) => row.id),
      evaluated: false,
      macroEligible: false,
      pass: false,
      blockedSubExpectations: [],
    };
  if (typeof comparisonPassed !== "boolean")
    throw new Error(`variant ${variant.id} needs its comparison result`);
  return {
    outcome: comparisonPassed ? "pass" : "hold",
    unmet: ordered.map((row) => row.id),
    evaluated: true,
    macroEligible: true,
    pass: comparisonPassed,
    blockedSubExpectations: ordered.map((row) => ({
      outcome: `blocked:${row.id}`,
      notEvaluated: [...ADDED_SCENE_SUB_EXPECTATION],
    })),
  };
}

/** Validates one G-02..G-08 fixture; returns error strings. */
export function validateGraphCaseFixture(
  fixture,
  { validateSchema, caseTable },
) {
  const label = fixture?.caseId ?? "G-??";
  const errors = schemaErrors(validateSchema, fixture, label);
  if (errors.length > 0) return { errors, variants: [] };
  const index = indexFixture(fixture);
  const row = caseTable.get(fixture.caseId);
  if (!row) errors.push(`${label} has no row in the l6-l9 G-01..G-08 table`);
  else if (stableJson(row) !== stableJson(fixture.caseClass))
    errors.push(`${label} caseClass must copy the l6-l9 table row exactly`);
  checkReferences(fixture, index, errors);
  checkLexicalIsolation(fixture, errors);
  checkSlotClass(fixture, errors);
  const results = [];
  for (const variant of fixture.variants) {
    checkArms(fixture, index, variant, errors);
    const result = evaluateGraphCaseVariant(fixture, variant);
    errors.push(...result.errors);
    compareVariant(fixture, index, variant, result, errors);
    checkPreconditions(fixture, variant, result, errors);
    results.push({ variant, result });
  }
  checkPositiveNegativeCoverage(fixture, results, errors);
  return {
    errors,
    variants: results.map(({ variant, result }) => ({
      id: variant.id,
      graphStatus: result.computed.graph.status,
      finalSceneIds: result.computed.finalSceneIds,
      framePinCount: result.computed.framePinCount,
      preconditions: variant.preconditions.map((row) => row.id),
    })),
  };
}

function validateManifest(manifest, retrievalManifest, errors) {
  if (manifest.schemaVersion !== "nir1-graph-manifest/1")
    errors.push(
      "nir1-graph manifest schemaVersion must be nir1-graph-manifest/1",
    );
  if (!Object.values(MANIFEST_STATUS).includes(manifest.status))
    errors.push("nir1-graph manifest status is invalid");
  if (
    !["pending", "reviewed"].includes(
      manifest.independentExpectationReview?.status,
    )
  )
    errors.push(
      "nir1-graph manifest independentExpectationReview.status must be pending or reviewed",
    );
  const preconditions = manifest.preconditions ?? {};
  const definitions = Array.isArray(preconditions.definitions)
    ? preconditions.definitions
    : [];
  if (
    stableJson(definitions.map((row) => [row?.id, row?.scope])) !==
    stableJson(PRECONDITIONS.map((row) => [row.id, row.scope]))
  )
    errors.push(
      "nir1-graph manifest preconditions must define exactly the closed precondition set in order",
    );
  for (const row of definitions) {
    for (const field of ["appliesTo", "check", "source"]) {
      if (typeof row?.[field] !== "string" || row[field].trim() === "")
        errors.push(
          `nir1-graph manifest precondition ${row?.id} ${field} is required`,
        );
    }
  }
  const addedScene = definitions.find((row) => row?.scope === "added-scene");
  if (
    stableJson(addedScene?.notEvaluated) !==
    stableJson(ADDED_SCENE_SUB_EXPECTATION)
  )
    errors.push(
      "nir1-graph manifest added-scene precondition must list the appended-Scene sub-expectation",
    );
  if (
    stableJson(preconditions.outcomes) !==
    stableJson(["pass", "hold", "blocked:<preconditionId>"])
  )
    errors.push(
      "nir1-graph manifest preconditions must name the pass / hold / blocked outcomes",
    );
  const irSupplemented = (manifest.cases ?? [])
    .filter((entry) => entry.slotClass === "ir-supplemented")
    .map((entry) => entry.caseId);
  const coverage = manifest.irSupplementedCoverage ?? {};
  if (stableJson(coverage.cases) !== stableJson(irSupplemented))
    errors.push(
      "nir1-graph manifest irSupplementedCoverage must name every IR-supplemented case",
    );
  if (!["not-run", "run"].includes(coverage.admissionProbe))
    errors.push(
      "nir1-graph manifest irSupplementedCoverage.admissionProbe must be not-run or run",
    );
  if (
    typeof coverage.consequence !== "string" ||
    !/CP-4 cannot PASS/.test(coverage.consequence)
  )
    errors.push(
      "nir1-graph manifest must state that an all-blocked IR-supplemented class keeps CP-4 from PASS",
    );
  if (manifest.observationPolicy !== NIR1_GRAPH_OBSERVATION_POLICY)
    errors.push("nir1-graph manifest must repeat the fixed observation policy");
  if (manifest.graphRuntimeObservedBeforeFreeze === false) {
    if (manifest.postObservationRevisions !== undefined)
      errors.push(
        "nir1-graph manifest declares postObservationRevisions without a runtime observation before the freeze",
      );
  } else if (manifest.graphRuntimeObservedBeforeFreeze === true) {
    if (
      !Array.isArray(manifest.postObservationRevisions) ||
      manifest.postObservationRevisions.length === 0
    )
      errors.push(
        "nir1-graph manifest observed before the freeze must declare postObservationRevisions",
      );
  } else
    errors.push(
      "nir1-graph manifest graphRuntimeObservedBeforeFreeze must be a boolean",
    );
  if (!/\bfresh workspace\b/.test(manifest.isolation ?? ""))
    errors.push(
      "nir1-graph manifest must declare a fresh workspace per case and variant",
    );
  const caseIds = (manifest.cases ?? []).map((entry) => entry.caseId);
  if (stableJson(caseIds) !== stableJson(GRAPH_CASE_IDS))
    errors.push("nir1-graph manifest must list exactly G-01..G-08 in order");
  for (const entry of manifest.cases ?? []) {
    if (!SLOT_CLASSES.includes(entry.slotClass))
      errors.push(`${entry.caseId} manifest slotClass is invalid`);
    if (entry.predeclaredImprovement !== (entry.caseId === "G-01"))
      errors.push(
        `${entry.caseId} only G-01 is the predeclared Graph improvement case`,
      );
  }
  const g01 = (manifest.cases ?? []).find((entry) => entry.caseId === "G-01");
  if (
    g01?.path !== NIR1_G01_FIXTURE_PATH ||
    g01?.fixtureId !== NIR1_G01_FIXTURE_ID
  )
    errors.push("G-01 must stay the unchanged evals/nir1-g01 fixture");
  const slotClasses = new Set(
    (manifest.cases ?? []).map((entry) => entry.slotClass),
  );
  for (const slotClass of SLOT_CLASSES) {
    if (!slotClasses.has(slotClass))
      errors.push(`nir1-graph cases must cover the ${slotClass} slot class`);
  }
  const arms = manifest.arms ?? {};
  if (
    arms.raw !== "R" ||
    arms.hybrid !== "R+IR" ||
    arms.graph !== "R+IR+Graph" ||
    arms.graphComparedAgainst !== "hybrid" ||
    arms.seedOnly !== "diagnostic-only"
  )
    errors.push(
      "nir1-graph manifest arms must be R / R+IR / R+IR+Graph against R+IR",
    );
  const policy = manifest.existingRetrievalSeedPolicy ?? {};
  if (
    policy.population !== NIR1_RETRIEVAL_MANIFEST_PATH ||
    policy.queryCount !== 24 ||
    policy.manualSeed !== "none" ||
    policy.graphStatus !== "not-requested" ||
    policy.expectedGraphContribution !== 0 ||
    policy.rPlusIrPlusGraphEqualsRPlusIr !== true
  )
    errors.push(
      "existing 24-query seed policy must be no seed / Graph contribution 0",
    );
  if (policy.retrievalManifestScope !== retrievalManifest.scope)
    errors.push(
      "seed policy must copy the unchanged nir1-retrieval manifest scope",
    );
  if (!/\bnot Graph\b/.test(retrievalManifest.scope ?? ""))
    errors.push("the nir1-retrieval manifest scope must remain not Graph");
}

const FROZEN_AT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

/** Reads and checks the bound review receipt; returns it with its bytes. */
async function validateReviewReceipt(repoRoot, freeze, errors) {
  const relative = freeze.reviewReceipt;
  if (typeof relative !== "string" || relative.trim() === "") return null;
  const normalized = path.posix.normalize(relative);
  if (
    path.isAbsolute(relative) ||
    normalized !== relative ||
    normalized.startsWith("../")
  ) {
    errors.push("nir1-graph freeze reviewReceipt must be a repository path");
    return null;
  }
  let bytes;
  try {
    bytes = await readFile(path.join(repoRoot, relative));
  } catch {
    errors.push(`nir1-graph freeze review receipt ${relative} is missing`);
    return null;
  }
  const digest = sha256(bytes);
  if (freeze.reviewReceiptSha256 !== digest)
    errors.push("nir1-graph freeze review receipt hash differs");
  let receipt;
  try {
    receipt = JSON.parse(bytes);
  } catch {
    errors.push("nir1-graph review receipt is not JSON");
    return { path: relative, sha256: digest, bytes, value: null };
  }
  if (receipt.schemaVersion !== "nir1-graph-expectation-review/1")
    errors.push(
      "nir1-graph review receipt schemaVersion must be nir1-graph-expectation-review/1",
    );
  const reviewed = (receipt.result?.cases ?? []).map((row) => row?.id);
  if (stableJson(reviewed) !== stableJson(GRAPH_CASE_IDS.slice(1)))
    errors.push("nir1-graph review receipt must review G-02..G-08");
  if (receipt.graphRuntimeOutputObserved !== false)
    errors.push(
      "nir1-graph review receipt must record that no Graph runtime output was observed",
    );
  return { path: relative, sha256: digest, bytes, value: receipt };
}

function markdownSectionHeading(part) {
  if (!part.startsWith("## ")) return null;
  const end = part.indexOf("\n");
  return part.slice(3, end === -1 ? part.length : end).trim();
}

/** RFC 6901 reference tokens of a JSON pointer, or null when malformed. */
function pointerTokens(pointer) {
  if (typeof pointer !== "string" || !pointer.startsWith("/")) return null;
  return pointer
    .slice(1)
    .split("/")
    .map((token) => token.replaceAll("~1", "/").replaceAll("~0", "~"));
}

/**
 * Removes the value a JSON pointer names: an object member is deleted, an
 * array element is replaced by null so that later indexes keep their meaning.
 * A pointer whose target is absent (a member added after approval) is a no-op.
 */
function dropPointer(root, pointer) {
  const tokens = pointerTokens(pointer);
  if (tokens === null) throw new Error(`malformed JSON pointer ${pointer}`);
  let parent = root;
  for (const token of tokens.slice(0, -1)) {
    if (parent === null || typeof parent !== "object") return;
    parent = parent[token];
  }
  if (parent === null || typeof parent !== "object") return;
  const last = tokens.at(-1);
  if (!Object.hasOwn(parent, last)) return;
  if (Array.isArray(parent)) parent[Number(last)] = null;
  else delete parent[last];
}

/**
 * The content of a bound file outside the declared scope of a change made
 * after the approving review: a JSON document without the declared top-level
 * keys or JSON pointers, or a Markdown document without the declared `## `
 * sections (and without the text before the first section when the scope
 * declares the preamble).
 */
export function contentOutsideScope(bytes, scope) {
  if (scope?.kind === "json-keys") {
    const value = JSON.parse(bytes);
    for (const key of scope.keys) delete value[key];
    return JSON.stringify(value);
  }
  if (scope?.kind === "json-pointers") {
    const value = JSON.parse(bytes);
    for (const pointer of scope.pointers) dropPointer(value, pointer);
    return JSON.stringify(value);
  }
  if (scope?.kind === "markdown-sections") {
    const drop = new Set(scope.headings);
    return String(bytes)
      .split(/^(?=## )/m)
      .filter((part, index) => {
        const heading = markdownSectionHeading(part);
        if (heading === null) return !(index === 0 && scope.preamble === true);
        return !drop.has(heading);
      })
      .join("");
  }
  throw new Error(`unknown change scope kind ${scope?.kind}`);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

/** A declared post-approval scope is well formed and allowed for its file. */
/** The value a JSON pointer names, or undefined. */
function valueAtPointer(root, pointer) {
  const tokens = pointerTokens(pointer);
  if (tokens === null) return undefined;
  let value = root;
  for (const token of tokens) {
    if (value === null || typeof value !== "object") return undefined;
    if (!Object.hasOwn(value, token)) return undefined;
    value = value[token];
  }
  return value;
}

/**
 * The digest of the first `length` characters (string) or items (array) of
 * an append-only value; the approved value is the prefix the freeze binds.
 */
export function appendOnlyPrefixSha256(value, length) {
  if (typeof value === "string") return sha256(value.slice(0, length));
  if (Array.isArray(value))
    return sha256(JSON.stringify(value.slice(0, length)));
  return null;
}

function changeScopeErrors(file, bytes, scope, allowed) {
  if (scope?.kind !== allowed.kind)
    return [
      `${file} may change after the approving review only by ${allowed.kind}`,
    ];
  if (allowed.kind === "json-keys") {
    const keys = Array.isArray(scope.keys) ? scope.keys : [];
    if (keys.length === 0 || keys.some((key) => !allowed.allowed.includes(key)))
      return [
        `${file} may change after the approving review only in ${allowed.allowed.join(", ")}`,
      ];
    return [];
  }
  if (allowed.kind === "json-pointers") {
    const pointers = Array.isArray(scope.pointers) ? scope.pointers : [];
    if (
      pointers.length === 0 ||
      new Set(pointers).size !== pointers.length ||
      pointers.some((pointer) => !allowed.allowed.includes(pointer))
    )
      return [
        `${file} may change after the approving review only at ${allowed.allowed.join(", ")}`,
      ];
    const required = (allowed.appendOnly ?? []).filter((pointer) =>
      pointers.includes(pointer),
    );
    const rows = Array.isArray(scope.appendOnly) ? scope.appendOnly : [];
    if (
      stableJson(rows.map((row) => row?.pointer).sort()) !==
      stableJson([...required].sort())
    )
      return [
        `${file} change scope must bind the approved prefix of ${required.join(", ")}`,
      ];
    const value = JSON.parse(bytes);
    const errors = [];
    for (const row of rows) {
      const current = valueAtPointer(value, row.pointer);
      if (
        !Number.isInteger(row.approvedLength) ||
        row.approvedLength < 0 ||
        current === undefined ||
        current.length < row.approvedLength ||
        appendOnlyPrefixSha256(current, row.approvedLength) !==
          row.approvedSha256
      )
        errors.push(
          `${file} ${row.pointer} may only grow after the approving review (its approved prefix changed)`,
        );
    }
    return errors;
  }
  if (scope.preamble !== undefined && scope.preamble !== true)
    return [`${file} change scope preamble must be true when present`];
  if (scope.preamble === true && allowed.preamble !== true)
    return [`${file} may not change its preamble after the approving review`];
  const headings = Array.isArray(scope.headings) ? scope.headings : [];
  const present = new Set(
    String(bytes)
      .split(/^(?=## )/m)
      .map(markdownSectionHeading)
      .filter((heading) => heading !== null),
  );
  if (
    headings.length === 0 ||
    headings.some((heading) => !present.has(heading))
  )
    return [`${file} change scope must name existing ## sections`];
  const lines = new Set(String(bytes).split("\n"));
  return (allowed.requiredLines ?? [])
    .filter((line) => !lines.has(line))
    .map((line) => `${file} must keep the rule line: ${line}`);
}

/**
 * The freeze follows an approving independent expectation review: the final
 * round approves every G-02..G-08 case with no required change, the reviewer
 * is read-only, distinct from the fixture author and saw no Graph runtime
 * output, earlier rounds are the bound receipt, and every bound file keeps its
 * approved bytes except a declared, allowed scope of the manifest or README.
 */
function validateApprovingReview(
  freeze,
  manifest,
  receipt,
  bound,
  errors,
  scopes = CHANGE_AFTER_APPROVAL_SCOPES,
) {
  const fail = (message) => errors.push(`nir1-graph freeze ${message}`);
  const record = freeze.independentExpectationReview;
  if (record === null || typeof record !== "object") {
    fail("must record the independent expectation review");
    return;
  }
  const reviewer = record.reviewer ?? {};
  if (reviewer.role !== freeze.reviewedBy)
    fail("reviewer.role must be reviewedBy");
  if (!nonEmptyString(reviewer.model)) fail("reviewer.model is required");
  if (reviewer.distinctFromFixtureAuthor !== true)
    fail("reviewer must be distinct from the fixture author");
  if (reviewer.readOnly !== true) fail("reviewer must be read-only");
  if (reviewer.graphRuntimeOutputObserved !== false)
    fail("reviewer must not have observed Graph runtime output");

  const rounds = Array.isArray(record.rounds) ? record.rounds : [];
  if (rounds.length === 0) {
    fail("must record the review rounds");
    return;
  }
  if (rounds.some((round, index) => round?.round !== index + 1))
    fail("review rounds must be numbered from 1 in order");
  // A round run by another reviewer records its own reviewer block.
  for (const round of rounds) {
    if (round?.reviewer === undefined) continue;
    const own = round.reviewer ?? {};
    if (own.role !== freeze.reviewedBy)
      fail(`review round ${round?.round} reviewer.role must be reviewedBy`);
    if (!nonEmptyString(own.model))
      fail(`review round ${round?.round} reviewer.model is required`);
    if (own.distinctFromFixtureAuthor !== true)
      fail(
        `review round ${round?.round} reviewer must be distinct from the fixture author`,
      );
    if (own.readOnly !== true)
      fail(`review round ${round?.round} reviewer must be read-only`);
    if (own.graphRuntimeOutputObserved !== false)
      fail(
        `review round ${round?.round} reviewer must not have observed Graph runtime output`,
      );
  }
  const final = rounds.at(-1) ?? {};
  if (
    final.verdict !== APPROVING_REVIEW_VERDICT ||
    freeze.reviewVerdict !== APPROVING_REVIEW_VERDICT
  )
    fail("must follow an approving final review round");
  if (manifest.independentExpectationReview?.verdict !== freeze.reviewVerdict)
    fail("reviewVerdict and the manifest review verdict disagree");
  if (!Array.isArray(final.requiredChanges) || final.requiredChanges.length > 0)
    fail("approving review round must leave no required change");
  const cases = Array.isArray(final.cases) ? final.cases : [];
  if (
    stableJson(cases.map((row) => row?.id)) !==
    stableJson(GRAPH_CASE_IDS.slice(1))
  )
    fail("approving review round must cover G-02..G-08");
  for (const row of cases) {
    if (row?.verdict !== APPROVING_REVIEW_VERDICT)
      fail(`approving review round does not approve ${row?.id}`);
  }
  if (
    !Array.isArray(final.interpretations) ||
    final.interpretations.some(
      (row) => !nonEmptyString(row?.point) || !nonEmptyString(row?.decision),
    )
  )
    fail("approving review round must record each interpretation decision");
  // Round 1 is the bound receipt; any round naming a receipt must match it.
  for (const [index, round] of rounds.entries()) {
    if (index > 0 && round?.receipt === undefined) continue;
    if (
      round?.receipt !== freeze.reviewReceipt ||
      round?.receiptSha256 !== freeze.reviewReceiptSha256
    )
      fail(`review round ${index + 1} must be the bound review receipt`);
    else if (receipt && round.verdict !== receipt.result?.verdict)
      fail(`review round ${index + 1} verdict differs from its receipt`);
  }

  const reviewedFiles = Array.isArray(final.filesAtReview)
    ? final.filesAtReview
    : [];
  const approved = new Map(
    reviewedFiles.map((row) => [row?.path, row?.sha256]),
  );
  if (
    approved.size !== reviewedFiles.length ||
    !sameSet([...approved.keys()], [...bound.keys()])
  )
    fail(
      "approving review round must record the hash of every bound file once",
    );
  const changes = Array.isArray(record.changesAfterApproval)
    ? record.changesAfterApproval
    : [];
  const changed = new Map(changes.map((row) => [row?.path, row]));
  if (changed.size !== changes.length)
    fail("changesAfterApproval lists a file twice");
  for (const file of changed.keys()) {
    if (!bound.has(file)) fail(`declares a change to unbound ${file}`);
  }
  for (const [file, { sha256: digest, bytes }] of bound) {
    const change = changed.get(file);
    if (approved.get(file) === digest) {
      if (change)
        fail(`declares a change to ${file}, which keeps its approved bytes`);
      continue;
    }
    const allowed = scopes[file];
    if (!allowed) {
      fail(`${file} differs from the bytes the approving review saw`);
      continue;
    }
    if (!change) {
      fail(
        `${file} changed after the approving review without a declared scope`,
      );
      continue;
    }
    if (!nonEmptyString(change.change))
      fail(`change to ${file} after the approving review must be described`);
    const scopeErrors = changeScopeErrors(file, bytes, change.scope, allowed);
    if (scopeErrors.length > 0) {
      for (const message of scopeErrors) fail(message);
      continue;
    }
    if (
      sha256(contentOutsideScope(bytes, change.scope)) !==
      change.approvedSha256OutsideScope
    )
      fail(
        `${file} changed outside its declared scope after the approving review`,
      );
  }
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * A freeze written after Graph runtime observed the population. It declares
 * each rebuilt case (postObservationRevisions, repeated by the manifest), binds
 * the superseded version-1 freeze record, which stays in the repository with
 * its pinned bytes, and every case it did not rebuild keeps the path and
 * sha256 that record bound. Only a rebuilt case may carry a fixtureId of a
 * later version. Returns the rebuilt case IDs.
 */
async function validatePostObservationFreeze(
  repoRoot,
  { freeze, manifest, caseHashes },
  errors,
) {
  const fail = (message) => errors.push(`nir1-graph freeze ${message}`);
  const rows = Array.isArray(freeze.postObservationRevisions)
    ? freeze.postObservationRevisions
    : [];
  if (rows.length === 0) {
    fail(
      "observed before the freeze must declare postObservationRevisions for every rebuilt case",
    );
    return new Set();
  }
  const revised = new Set(rows.map((row) => row?.caseId));
  if (revised.size !== rows.length)
    fail("postObservationRevisions lists a case twice");
  const declared = Array.isArray(manifest.postObservationRevisions)
    ? manifest.postObservationRevisions
    : [];
  if (
    stableJson(declared.map((row) => row?.caseId)) !==
    stableJson(rows.map((row) => row?.caseId))
  )
    fail("and manifest postObservationRevisions must name the same cases");

  const block = freeze.supersedes ?? {};
  const superseded = NIR1_GRAPH_SUPERSEDED_FREEZE;
  if (
    block.freezeRecord?.path !== superseded.path ||
    block.freezeRecord?.sha256 !== superseded.sha256 ||
    block.freezeRecordCommit !== superseded.commit
  )
    fail(
      `supersedes must bind ${superseded.path} (${superseded.sha256}, last written by ${superseded.commit})`,
    );
  let previous = null;
  try {
    const bytes = await readFile(path.join(repoRoot, superseded.path));
    if (sha256(bytes) !== superseded.sha256)
      fail(`superseded ${superseded.path} must keep its pinned bytes`);
    else previous = JSON.parse(bytes);
  } catch {
    fail(`superseded ${superseded.path} must stay in the repository`);
  }
  const previousCases = new Map(
    (previous?.cases ?? []).map((entry) => [entry.caseId, entry]),
  );
  if (previous && previous.graphRuntimeObservedBeforeFreeze !== false)
    fail(
      "superseded freeze must be one written before any runtime observation",
    );
  // The review of a post-observation revision reads the bytes the superseded
  // freeze bound (its later changes are declared in changesAfterApproval).
  if (previous) {
    const final =
      freeze.independentExpectationReview?.rounds?.at(-1)?.filesAtReview ?? [];
    const reviewed = new Map(final.map((row) => [row?.path, row?.sha256]));
    for (const [file, digest] of [
      [NIR1_GRAPH_MANIFEST_PATH, previous.manifestSha256],
      [NIR1_GRAPH_SCHEMA_PATH, previous.schemaSha256],
      [NIR1_GRAPH_README_PATH, previous.readmeSha256],
      [previous.reviewReceipt, previous.reviewReceiptSha256],
    ])
      if (reviewed.get(file) !== digest)
        fail(
          `final review round must have read the superseded freeze's ${file} (${digest})`,
        );
  }

  for (const caseId of GRAPH_CASE_IDS) {
    const current = caseHashes.get(caseId);
    const before = previousCases.get(caseId);
    if (!current || !before) continue;
    if (revised.has(caseId)) continue;
    if (current.path !== before.path || current.sha256 !== before.sha256)
      fail(
        `${caseId} is not a declared post-observation revision, so it must keep the superseded freeze's ${before.path} bytes`,
      );
  }
  const manifestCases = new Map(
    (manifest.cases ?? []).map((entry) => [entry.caseId, entry]),
  );
  for (const entry of manifest.cases ?? []) {
    if (!/\/1$/.test(entry.fixtureId ?? "") && !revised.has(entry.caseId))
      fail(
        `${entry.caseId} fixtureId ${entry.fixtureId} needs a declared post-observation revision`,
      );
  }

  for (const row of rows) {
    const caseId = row?.caseId;
    const label = `postObservationRevisions ${caseId}`;
    if (!GRAPH_CASE_IDS.slice(1).includes(caseId)) {
      fail(`${label} must name one of G-02..G-08`);
      continue;
    }
    const before = previousCases.get(caseId);
    const current = caseHashes.get(caseId);
    const entry = manifestCases.get(caseId);
    const from = row.from ?? {};
    const to = row.to ?? {};
    if (before && (from.path !== before.path || from.sha256 !== before.sha256))
      fail(`${label} from must be the superseded freeze's ${caseId} binding`);
    if (current && (to.path !== current.path || to.sha256 !== current.sha256))
      fail(`${label} to must be the bound ${caseId} fixture`);
    if (entry && to.fixtureId !== entry.fixtureId)
      fail(`${label} to.fixtureId must be the manifest fixtureId`);
    if (
      !nonEmptyString(from.fixtureId) ||
      from.fixtureId === to.fixtureId ||
      from.path === to.path
    )
      fail(`${label} must name a new file and a new fixtureId`);
    if (typeof from.path === "string" && SHA256_HEX.test(from.sha256 ?? "")) {
      try {
        const kept = await readFile(path.join(repoRoot, from.path));
        if (sha256(kept) !== from.sha256)
          fail(`${label} earlier version ${from.path} changed`);
      } catch {
        fail(
          `${label} earlier version ${from.path} must stay in the repository`,
        );
      }
    }
    const manifestRow = declared.find((item) => item?.caseId === caseId);
    if (
      manifestRow &&
      (manifestRow.from?.path !== from.path ||
        manifestRow.from?.fixtureId !== from.fixtureId ||
        manifestRow.to?.path !== to.path ||
        manifestRow.to?.fixtureId !== to.fixtureId)
    )
      fail(`${label} differs from the manifest's entry`);
    if (row.graphOutputUsed !== false)
      fail(`${label} must record that no Graph runtime output was used`);
    for (const field of ["changedFields", "observedRuns"]) {
      if (
        !Array.isArray(row[field]) ||
        row[field].length === 0 ||
        row[field].some((item) => !nonEmptyString(item))
      )
        fail(`${label} ${field} is required`);
    }
    for (const field of ["userConfirmation", "expectationReview"]) {
      if (
        !nonEmptyString(row[field]?.record) ||
        !nonEmptyString(row[field]?.commit)
      )
        fail(`${label} ${field} must name its record and commit`);
    }
  }
  return revised;
}

async function validateFreeze(
  repoRoot,
  { manifest, manifestBytes, schemaBytes, readmeBytes, caseHashes },
  errors,
) {
  const freezePath = path.join(repoRoot, NIR1_GRAPH_FREEZE_PATH);
  const review = manifest.independentExpectationReview ?? {};
  if (!(await exists(freezePath))) {
    if (manifest.status !== MANIFEST_STATUS.pending)
      errors.push(
        `nir1-graph manifest status must stay ${MANIFEST_STATUS.pending} without ${NIR1_GRAPH_FREEZE_PATH}`,
      );
    return { status: "pending-independent-expectation-review" };
  }
  const freeze = JSON.parse(await readFile(freezePath, "utf8"));
  if (manifest.status !== MANIFEST_STATUS.frozen)
    errors.push(
      `nir1-graph freeze record requires manifest status ${MANIFEST_STATUS.frozen}`,
    );
  if (review.status !== "reviewed")
    errors.push(
      "nir1-graph freeze record requires independentExpectationReview.status reviewed",
    );
  if (review.verdict !== APPROVING_REVIEW_VERDICT)
    errors.push(
      `nir1-graph freeze record requires independentExpectationReview.verdict ${APPROVING_REVIEW_VERDICT}`,
    );
  if (review.freezeRecord !== NIR1_GRAPH_FREEZE_PATH)
    errors.push(
      "nir1-graph manifest independentExpectationReview.freezeRecord must name the freeze record",
    );
  if (freeze.schemaVersion !== "nir1-graph-freeze/1")
    errors.push("nir1-graph freeze schemaVersion must be nir1-graph-freeze/1");
  if (freeze.status !== MANIFEST_STATUS.frozen)
    errors.push("nir1-graph freeze status is invalid");
  let scopes = CHANGE_AFTER_APPROVAL_SCOPES;
  if (freeze.graphRuntimeObservedBeforeFreeze === false) {
    if (freeze.postObservationRevisions !== undefined)
      errors.push(
        "nir1-graph freeze declares postObservationRevisions without a runtime observation before it",
      );
    for (const entry of manifest.cases ?? []) {
      if (!/\/1$/.test(entry.fixtureId ?? ""))
        errors.push(
          `${entry.caseId} fixtureId ${entry.fixtureId} needs a declared post-observation revision`,
        );
    }
  } else if (freeze.graphRuntimeObservedBeforeFreeze === true) {
    await validatePostObservationFreeze(
      repoRoot,
      { freeze, manifest, caseHashes },
      errors,
    );
    scopes = POST_OBSERVATION_CHANGE_SCOPES;
  } else
    errors.push(
      "nir1-graph freeze graphRuntimeObservedBeforeFreeze must be a boolean",
    );
  if (
    freeze.graphRuntimeObservedBeforeFreeze !==
    manifest.graphRuntimeObservedBeforeFreeze
  )
    errors.push(
      "nir1-graph freeze and manifest disagree on graphRuntimeObservedBeforeFreeze",
    );
  if (freeze.manifestSha256 !== sha256(manifestBytes))
    errors.push("nir1-graph freeze manifest hash differs");
  if (freeze.schemaSha256 !== sha256(schemaBytes))
    errors.push("nir1-graph freeze schema hash differs");
  if (freeze.readmeSha256 !== sha256(readmeBytes))
    errors.push("nir1-graph freeze README hash differs");
  for (const field of [
    "reviewedBy",
    "reviewVerdict",
    "reviewReceipt",
    "reviewReceiptSha256",
    "frozenAt",
    "baselineHead",
  ]) {
    if (typeof freeze[field] !== "string" || freeze[field].trim() === "")
      errors.push(`nir1-graph freeze ${field} is required`);
  }
  if (!/^[0-9a-f]{40}$/.test(freeze.baselineHead ?? ""))
    errors.push("nir1-graph freeze baselineHead must be a full commit id");
  if (!FROZEN_AT_PATTERN.test(freeze.frozenAt ?? ""))
    errors.push("nir1-graph freeze frozenAt must be a UTC timestamp");
  if (freeze.reviewReceipt !== review.receipt)
    errors.push(
      "nir1-graph freeze must bind the manifest's independent review receipt",
    );
  const receipt = await validateReviewReceipt(repoRoot, freeze, errors);
  const bound = new Map([
    [
      NIR1_GRAPH_MANIFEST_PATH,
      { sha256: sha256(manifestBytes), bytes: manifestBytes },
    ],
    [
      NIR1_GRAPH_SCHEMA_PATH,
      { sha256: sha256(schemaBytes), bytes: schemaBytes },
    ],
    [
      NIR1_GRAPH_README_PATH,
      { sha256: sha256(readmeBytes), bytes: readmeBytes },
    ],
  ]);
  if (receipt)
    bound.set(receipt.path, { sha256: receipt.sha256, bytes: receipt.bytes });
  for (const { path: casePath, sha256: digest } of caseHashes.values())
    bound.set(casePath, { sha256: digest });
  validateApprovingReview(
    freeze,
    manifest,
    receipt?.value,
    bound,
    errors,
    scopes,
  );
  const probe = freeze.irSupplementAdmissionProbe?.status;
  if (!["not-run", "run"].includes(probe))
    errors.push(
      "nir1-graph freeze irSupplementAdmissionProbe.status must be not-run or run",
    );
  else if (probe !== manifest.irSupplementedCoverage?.admissionProbe)
    errors.push(
      "nir1-graph freeze and manifest disagree on the IR admission probe",
    );
  const frozen = new Map(
    (freeze.cases ?? []).map((entry) => [entry.caseId, entry]),
  );
  for (const [caseId, { path: casePath, sha256: digest }] of caseHashes) {
    const entry = frozen.get(caseId);
    if (!entry || entry.path !== casePath || entry.sha256 !== digest)
      errors.push(`nir1-graph freeze does not bind ${caseId} ${casePath}`);
  }
  if (frozen.size !== caseHashes.size)
    errors.push("nir1-graph freeze case list differs");
  return {
    status: "frozen",
    path: NIR1_GRAPH_FREEZE_PATH,
    reviewVerdict: freeze.reviewVerdict,
    reviewReceipt: freeze.reviewReceipt,
    frozenAt: freeze.frozenAt,
  };
}

/** Loads and validates the whole fixed population. */
export async function validateNir1GraphCases({ repoRoot }) {
  const errors = [];
  const read = (relative) => readFile(path.join(repoRoot, relative));
  const manifestBytes = await read(NIR1_GRAPH_MANIFEST_PATH);
  const manifest = JSON.parse(manifestBytes);
  const schemaBytes = await read(NIR1_GRAPH_SCHEMA_PATH);
  const schema = JSON.parse(schemaBytes);
  const readmeBytes = await read(NIR1_GRAPH_README_PATH);
  const caseTable = parseGraphCaseTable(
    await readFile(path.join(repoRoot, NIR1_L6L9_PLAN_PATH), "utf8"),
  );
  const retrievalManifest = JSON.parse(
    await read(NIR1_RETRIEVAL_MANIFEST_PATH),
  );
  const ranking = JSON.parse(await read(NIR1_RANKING_POLICY_PATH));
  if (
    ranking.fusion?.maxScenes !== GRAPH_RULES.fusionMaxScenes ||
    ranking.fusion?.maxAdditionalScenes !== GRAPH_RULES.maxAdditionalScenes
  )
    errors.push(
      "ranking policy fusion no longer matches the one-slot rule used by these fixtures",
    );
  for (const caseId of GRAPH_CASE_IDS) {
    if (!caseTable.has(caseId)) errors.push(`l6-l9 table is missing ${caseId}`);
  }
  validateManifest(manifest, retrievalManifest, errors);
  checkRuntimeComparison(manifest, schema, errors);

  const validateSchema = createSchemaValidator(schema);
  const caseHashes = new Map();
  const cases = [];
  for (const entry of manifest.cases ?? []) {
    let bytes;
    try {
      bytes = await read(entry.path);
    } catch {
      errors.push(`${entry.caseId} fixture ${entry.path} is missing`);
      continue;
    }
    const digest = sha256(bytes);
    caseHashes.set(entry.caseId, { path: entry.path, sha256: digest });
    const fixture = JSON.parse(bytes);
    if (entry.caseId === "G-01") {
      if (
        fixture.fixtureId !== NIR1_G01_FIXTURE_ID ||
        fixture.status !== "predeclared-design-fixture" ||
        fixture.observationPolicy !== NIR1_GRAPH_OBSERVATION_POLICY
      )
        errors.push("G-01 fixture identity or observation policy changed");
      if (entry.sha256 !== digest)
        errors.push("G-01 fixture bytes differ from the manifest binding");
      cases.push({
        caseId: "G-01",
        fixtureId: fixture.fixtureId,
        path: entry.path,
        sha256: digest,
        slotClass: entry.slotClass,
        variants: 1,
      });
      continue;
    }
    if (entry.sha256 !== undefined)
      errors.push(`${entry.caseId} hash binding belongs in the freeze record`);
    if (
      fixture.caseId !== entry.caseId ||
      fixture.fixtureId !== entry.fixtureId
    )
      errors.push(`${entry.caseId} manifest entry does not match its fixture`);
    if (fixture.slotClass !== entry.slotClass)
      errors.push(
        `${entry.caseId} manifest slotClass does not match its fixture`,
      );
    const result = validateGraphCaseFixture(fixture, {
      validateSchema,
      caseTable,
    });
    errors.push(...result.errors);
    cases.push({
      caseId: entry.caseId,
      fixtureId: fixture.fixtureId,
      path: entry.path,
      sha256: digest,
      slotClass: fixture.slotClass,
      variants: result.variants.length,
    });
  }
  const freeze = await validateFreeze(
    repoRoot,
    { manifest, manifestBytes, schemaBytes, readmeBytes, caseHashes },
    errors,
  );
  return { errors, cases, freeze, manifest };
}
