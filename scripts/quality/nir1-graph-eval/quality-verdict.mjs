// CP-4 quality verdict (DR-CP4-QV-1): the five quality conditions of the Graph
// arm applied to the recorded receipts, outside the S2 procedure.
//
// Pure module: no file or process access. It never runs Graph, IR, Raw, a
// model, Electron or Native, never edits a receipt, and carries no threshold
// of its own: D is `GRAPH_EVAL_D_MS`, B and the p95 limit are the procedure
// file v2's (checked against constants.mjs), the percentile and the metric
// tolerance are read from the frozen manifests and the K6/2 text by
// the loader (quality-verdict-cli.mjs) and handed in as `policy` and
// `tolerance`. The definitions are fixed in
// docs/plans/nir1-cp4-records/quality-verdict-prereg-2026-11-06.md
// (contracts) before any value was computed.
//
// Existing pinned modules are imported only (followup.mjs, receipt.mjs,
// constants.mjs, nir1-retrieval/contract.mjs); none of them is changed.

import {
  GRAPH_EVAL_B_MS,
  GRAPH_EVAL_D_MS,
  GRAPH_EVAL_HYBRID_P95_LIMIT_MS,
  GRAPH_EVAL_VARIANTS,
} from "./constants.mjs";
import { MEASURED_RUNS_PER_ARM } from "./constants.mjs";
import { classifyFollowUp, nextGraphArmOf } from "./followup.mjs";
import { selectReceiptsForAggregation } from "./receipt.mjs";
import { nearestRank, scoreQuery } from "../nir1-retrieval/contract.mjs";

export const QUALITY_VERDICT_SCHEMA = "nir1-cp4-quality-verdict/1";
export const POSITIONING = "outside-procedure-supplementary-record";
export const CONDITION_IDS = Object.freeze([
  "g01-predeclared-improvement",
  "macro-non-regression",
  "hybrid-p95",
  "evidence-validity",
  "forbidden-contribution",
]);

const COMPLETED_STATES = new Set([
  "completed",
  "ok",
  "completed-safe-fallback",
]);
// fail > hold > not-evaluable > pass; `n/a` never counts.
const SEVERITY = ["fail", "hold", "not-evaluable", "pass"];

function precheck(message) {
  return new Error(`[precheck] ${message}`);
}

export function worstStatus(statuses) {
  const rows = statuses.filter((status) => status !== "n/a");
  if (rows.length === 0) return "n/a";
  for (const status of SEVERITY) if (rows.includes(status)) return status;
  throw precheck(`unknown status ${rows.join(",")}`);
}

function sameList(left, right) {
  return (
    Array.isArray(left) &&
    Array.isArray(right) &&
    left.length === right.length &&
    left.every((value, at) => value === right[at])
  );
}

function unique(values) {
  return [...new Set(values)];
}

/**
 * The percentile from the retrieval manifest's own statement
 * (`performance.warm`); B, D and the Hybrid p95 limit from the procedure
 * file's `values` (K6/5 変える点 4 and Mandatory defenses: v2 fixes them
 * before observation). B is never computed from D (D = 40 ms would give a B
 * of 200 ms and a limit of 240 ms; K6/5 In-scope attack 20): the procedure
 * file's values must equal the contract's constants (constants.mjs) or the
 * verdict is a `[precheck]`.
 */
export function deriveLatencyPolicy(retrievalManifest, procedure) {
  const warm = retrievalManifest?.performance?.warm;
  const percentile = /^Raw-only p(\d+)\(t_return-t_fetch\)/u.exec(
    warm?.B ?? "",
  );
  if (!percentile || warm?.hybridP95Limit !== "B+D")
    throw precheck(
      "retrieval manifest performance.warm does not state the percentile and hybridP95Limit in the expected form",
    );
  const values = procedure?.values;
  for (const [key, expected] of [
    ["dMs", GRAPH_EVAL_D_MS],
    ["bMs", GRAPH_EVAL_B_MS],
    ["hybridP95LimitMs", GRAPH_EVAL_HYBRID_P95_LIMIT_MS],
  ])
    if (values?.[key] !== expected)
      throw precheck(
        `the procedure file's values.${key} (${String(values?.[key])}) differs from the contract's ${expected} (K6/5)`,
      );
  return Object.freeze({
    percentile: Number(`0.${percentile[1]}`),
    b: values.bMs,
    d: values.dMs,
    limit: values.hybridP95LimitMs,
    source: {
      B: warm.B,
      D: warm.D,
      hybridP95Limit: warm.hybridP95Limit,
      percentileRule: warm.percentile,
      procedureFile: "values.bMs, values.hybridP95LimitMs, values.dMs",
    },
  });
}

function reverseScenes(receipt) {
  const scenes = receipt?.settings?.setupReceipt?.logicalToRuntime?.scenes;
  if (!scenes || typeof scenes !== "object")
    throw precheck(`${receipt?.runId}: logicalToRuntime.scenes is missing`);
  const reverse = new Map();
  for (const [logical, runtime] of Object.entries(scenes)) {
    if (reverse.has(runtime))
      throw precheck(`${receipt.runId}: logicalToRuntime is not one to one`);
    reverse.set(runtime, logical);
  }
  return reverse;
}

function toLogical(ids, reverse, runId) {
  if (!Array.isArray(ids))
    throw precheck(`${runId}: a Scene list is missing from a sample`);
  return ids.map((id) => {
    const logical = reverse.get(id);
    if (logical === undefined)
      throw precheck(
        `${runId}: Scene ${id} has no logical ID in logicalToRuntime`,
      );
    return logical;
  });
}

function pairSamples(receipt, key) {
  const rows = (receipt.samples ?? []).filter(
    (row) =>
      row.variantKey === key &&
      row.phase === "measured" &&
      row.trigger === "user-operation",
  );
  const graph = rows.filter((row) => row.arm === "graph");
  const hybrid = rows.filter((row) => row.arm === "hybrid");
  const hybridByRepeat = new Map(hybrid.map((row) => [row.repeat, row]));
  const ok =
    graph.length === MEASURED_RUNS_PER_ARM &&
    hybrid.length === MEASURED_RUNS_PER_ARM &&
    new Set(graph.map((row) => row.repeat)).size === MEASURED_RUNS_PER_ARM &&
    hybridByRepeat.size === MEASURED_RUNS_PER_ARM &&
    graph.every((row) => hybridByRepeat.has(row.repeat));
  return { ok, graph, hybrid, hybridByRepeat };
}

function metricsOf(expectation, list) {
  const grades = expectation.grades;
  const query = {
    eligibleSceneIds: expectation.eligibleSceneIds,
    relevanceGrades: grades,
    requiredRawPassages: [],
  };
  const score = scoreQuery(
    query,
    list.map((sceneId) => ({ sceneId, chunkText: "" })),
  );
  return { recallAt8: score.recallAt8, ndcgAt8: score.ndcgAt8 };
}

function nearly(left, right, tolerance) {
  return Math.abs(left - right) <= tolerance;
}

function metricsMatch(observed, expected, tolerance) {
  return (
    Number.isFinite(expected?.recallAt8) &&
    Number.isFinite(expected?.ndcgAt8) &&
    nearly(observed.recallAt8, expected.recallAt8, tolerance) &&
    nearly(observed.ndcgAt8, expected.ndcgAt8, tolerance)
  );
}

function latencyOf(rows, policy) {
  const values = rows.map((row) => row.tReturn - row.tFetch);
  const failed = rows.filter(
    (row) =>
      !COMPLETED_STATES.has(row.status) ||
      !Number.isFinite(row.tReturn - row.tFetch) ||
      row.tReturn - row.tFetch < 0,
  );
  const p95 =
    values.length > 0 && failed.length === 0
      ? nearestRank(values, policy.percentile)
      : null;
  return {
    n: rows.length,
    failedCount: failed.length,
    p95Ms: p95,
    status:
      rows.length === 0
        ? "hold"
        : failed.length > 0
          ? "fail"
          : p95 <= policy.limit
            ? "pass"
            : "fail",
  };
}

function observedPairs(entry) {
  return unique(
    (entry.pairs ?? []).map((pair) => String(pair).split("|").at(-1)),
  ).sort();
}

/**
 * The edge binding of one sample's displayed Graph against the fixture's
 * expectation. Prereg v2 D6: a first-render sample is read through the
 * parent's own contribution record (K6/6 FR-7), a follow-up sample through
 * its child's.
 */
function edgeBindingProblems(sample, expected, firstRender = false) {
  const parentContribution = sample.followUp?.parent?.contribution;
  const child = firstRender
    ? parentContribution
      ? { ...parentContribution, outcome: sample.graph?.outcome }
      : null
    : sample.followUp?.child;
  if (!child || child.outcome !== "graph-ready") return null;
  const problems = [];
  if (child.contributionBasis !== "material-revision")
    problems.push("basis-is-not-material-revision");
  const material = child.materialRevision;
  if (!material || typeof material !== "object")
    return ["material-revision-record-missing"];
  if (material.unresolvedEdges !== 0) problems.push("unresolved-edges");
  const observed = new Map(
    (material.observed ?? []).map((entry) => [
      `${entry.kind}:${entry.sceneId}`,
      entry,
    ]),
  );
  if (observed.size !== (material.observed ?? []).length)
    problems.push("duplicate-observed-entry");
  const wanted = new Map(
    expected.map((entry) => [`${entry.kind}:${entry.sceneId}`, entry]),
  );
  for (const [key, entry] of wanted) {
    const seen = observed.get(key);
    if (!seen) problems.push(`missing:${key}`);
    else if (
      !sameList(observedPairs(seen), unique(entry.edgeIds).sort()) ||
      seen.unresolved !== 0
    )
      problems.push(`edges-differ:${key}`);
  }
  for (const key of observed.keys())
    if (!wanted.has(key)) problems.push(`unexpected:${key}`);
  return problems;
}

/**
 * Prereg v2 D3 (1)〜(6) for one sample's child (the variant is checked by the
 * caller): an `index-ready` child that is not a `graph-ready` refresh, started
 * when the parent's Chronicle Index was not usable (IR `index-unavailable`) and
 * its Graph Index was, and whose own start found the Chronicle Index usable.
 */
export function d3Missing(sample, child) {
  if (child === null || child === undefined) return [2];
  const missing = [];
  if (child.origin !== "index-ready") missing.push(2);
  if (child.refreshTrigger === "graph-ready") missing.push(3);
  if (
    sample.snapshot?.chronicleIndexUsable !== false ||
    sample.irOutcome !== "index-unavailable"
  )
    missing.push(4);
  if (sample.snapshot?.usable !== true) missing.push(5);
  if (child.chronicleIndexUsable !== true) missing.push(6);
  return missing;
}

export function d3Eligible(sample, child) {
  return d3Missing(sample, child).length === 0;
}

/**
 * The latest typed Revision of one Relation in the setup record. The order is
 * the frozen fixture's own `revisions` array (the setup prepared them in that
 * order: the fixture's `setupTimeline` revision steps), handed in as `order`
 * (a list of Revision IDs); the JSON object's key order is never read. The
 * last Revision in `order` that the setup record carries for the Relation
 * wins — a later Revision supersedes an earlier one whatever its decision
 * (DR-CP4-QV-2 (iv), G-05's reading), a Revision refused at the `decision`
 * stage included (it was prepared). Only a Revision refused at `prepare`
 * (it was never made) is not counted. `null` when none binds the Relation.
 * A setup record row that `order` does not name is not ordered: the caller
 * (`revisionResolutionProblems`) holds.
 */
export function latestTypedRevisionOf(typedRevisions, relationId, order) {
  let latest = null;
  for (const id of Array.isArray(order) ? order : []) {
    const row = typedRevisions?.[id];
    if (!row || row.refusedAtSetup === "prepare") continue;
    if (
      !Array.isArray(row.relationIds) ||
      !row.relationIds.includes(relationId)
    )
      continue;
    latest = typeof row.id === "string" ? row.id : id;
  }
  return latest;
}

/**
 * Prereg v2 D3 (d), second half: every observed `revision|edge` pair names the
 * latest typed Revision of that edge's Relation in the setup record. A
 * different (older) Revision is a fail; a setup record that carries no typed
 * Revisions, or none for the edge, cannot answer and is a hold (prereg §3).
 */
function revisionResolutionProblems(material, typedRevisions, order) {
  const hasSetup =
    typedRevisions &&
    typeof typedRevisions === "object" &&
    Object.keys(typedRevisions).length > 0;
  if (!hasSetup)
    return [{ kind: "hold", code: "d-revision-resolution-unavailable" }];
  // The order is the frozen fixture's; a setup record that carries a Revision
  // the fixture does not name (or no fixture order at all) cannot be ordered.
  const ordered = Array.isArray(order) ? new Set(order) : new Set();
  if (
    ordered.size === 0 ||
    Object.keys(typedRevisions).some((id) => !ordered.has(id))
  )
    return [{ kind: "hold", code: "d-revision-order-unavailable" }];
  const out = [];
  for (const entry of material.observed ?? [])
    for (const pair of entry.pairs ?? []) {
      const [revision, edge] = String(pair).split("|");
      const latest = latestTypedRevisionOf(typedRevisions, edge, order);
      if (latest === null)
        out.push({
          kind: "hold",
          code: "d-edge-has-no-typed-revision-in-setup",
          edge,
        });
      else if (latest !== revision)
        out.push({
          kind: "fail",
          code: "d-revision-is-not-the-latest",
          edge,
          observed: revision,
          latest,
        });
    }
  return out;
}

/**
 * Prereg v2 D3 (a)〜(d): the contribution of an eligible child. (a) what its
 * list adds to the paired R+IR is no forbidden Scene or blocked candidate;
 * (b) its Graph's path contributions (`materialRevision.observed[].sceneId`
 * as logical Scenes, R+IR's own Scenes included) are none either; (c) it
 * shows no late Graph and publishes at most once; (d) every edge is resolved
 * (`unresolvedEdges` 0) and each observed Revision is the latest typed
 * Revision of its edge in the setup record (`typedRevisions`). A missing
 * `materialRevision` record is a hold.
 */
export function d3Problems({
  child,
  pair,
  lists,
  forbidden,
  blocked,
  typedRevisions,
  typedRevisionOrder,
}) {
  const out = [];
  const bad = (id) => forbidden.has(id) || blocked.has(id);
  if (child.publishCount > 0) {
    const added = lists(child.finalSceneIds).filter((id) => !pair.includes(id));
    const hit = added.filter(bad);
    if (hit.length > 0)
      out.push({
        kind: "fail",
        code: "a-forbidden-contribution",
        sceneIds: hit,
      });
  }
  const material = child.materialRevision;
  const hasRecord = material !== null && typeof material === "object";
  // The record itself is inspected whenever it exists (whatever the child's
  // outcome or edgeCount says: fail closed). A child without a record cannot
  // be checked by (b)(d) and holds, whatever its outcome or edgeCount (prereg
  // §3 as written; DR-CP4-QV-3). `mayHaveShownGraph` (`graph-ready` with an
  // edgeCount that is not a proven 0) only decides below whether an empty
  // record is acceptable.
  const mayHaveShownGraph =
    child.outcome === "graph-ready" && child.edgeCount !== 0;
  if (!hasRecord)
    out.push({ kind: "hold", code: "b-material-revision-record-missing" });
  else {
    const observedEntries = Array.isArray(material.observed)
      ? material.observed
      : [];
    // A child that may have shown a Graph but whose record observed no path
    // (the probe handed no paths: `resolver(null)` is `observed: []` with
    // `unresolvedEdges` 0) cannot be checked by (b)(d): hold (prereg §2, §3).
    if (mayHaveShownGraph && observedEntries.length === 0)
      out.push({ kind: "hold", code: "b-observed-path-record-empty" });
    // A path whose Scene has no logical ID in the setup record (`sceneId`
    // null) cannot be matched against the forbidden and blocked Scenes:
    // hold, never dropped.
    if (observedEntries.some((entry) => typeof entry?.sceneId !== "string"))
      out.push({ kind: "hold", code: "b-observed-scene-has-no-logical-id" });
    const sceneIds = observedEntries
      .map((entry) => entry?.sceneId)
      .filter((id) => typeof id === "string");
    const hit = sceneIds.filter(bad);
    if (hit.length > 0)
      out.push({ kind: "fail", code: "b-forbidden-path", sceneIds: hit });
    if (material.unresolvedEdges !== 0)
      out.push({ kind: "fail", code: "d-unresolved-edges" });
    // A record that observed no path (a child that showed no Graph) has no
    // Revision to resolve, so the setup's typed Revisions are not needed.
    const observedPairs = (material.observed ?? []).some(
      (entry) => (entry.pairs ?? []).length > 0,
    );
    if (observedPairs || mayHaveShownGraph)
      out.push(
        ...revisionResolutionProblems(
          material,
          typedRevisions,
          typedRevisionOrder,
        ),
      );
  }
  if (child.lateGraphInDisplay === true)
    out.push({ kind: "fail", code: "c-late-graph-in-display" });
  if (child.publishCount > 1)
    out.push({ kind: "fail", code: "c-published-more-than-once" });
  return out;
}

function evaluateVariant({ variant, receipt, expectation, policy, tolerance }) {
  const key = variant.key;
  const runId = receipt.runId;
  const reverse = reverseScenes(receipt);
  const { ok, graph, hybrid } = pairSamples(receipt, key);
  const row = {
    variantKey: key,
    caseId: variant.caseId,
    expectedGraph: expectation.expectedGraph,
    blocked: null,
    pairs: { graph: graph.length, hybrid: hybrid.length, ok },
    holdReasons: [],
    requeryRowsWithoutVariantKey: 0,
  };
  if (!ok) {
    row.holdReasons.push(
      "measured-graph-and-r-plus-ir-samples-are-not-30-pairs",
    );
    return finishHeldRow(row, expectation);
  }
  const lists = (ids) => toLogical(ids, reverse, runId);
  const pairList = new Map(
    hybrid.map((sample) => [sample.repeat, lists(sample.finalSceneIds)]),
  );
  const hybridLists = hybrid.map((sample) => pairList.get(sample.repeat));
  if (!hybridLists.every((list) => sameList(list, hybridLists[0])))
    row.holdReasons.push("r-plus-ir-lists-differ");
  const hybridList = hybridLists[0];

  // Follow-up reading, forbidden contribution (a)(b) and the edge binding.
  const displayedLists = [];
  const counts = { firstRender: 0, followUp: 0, notDisplayed: 0 };
  const violationsB = [];
  const violationsA = [];
  const baselineForbidden = [];
  const outsideExpectation = [];
  const edgeProblems = [];
  let edgeChecked = 0;
  let edgeSkipped = 0;
  const forbidden = new Set(expectation.forbiddenSceneIds);
  const blocked = new Set(expectation.blockedSceneIds);
  const unavailable = expectation.expectedGraph === "unavailable";
  const expectedScenes = new Set(
    expectation.expectedContributions.map((entry) => entry.sceneId),
  );
  const lastShown = [];
  // Prereg v2 D8: a parent that brought a Graph into the display but was not
  // counted as a first render (or a not-displayed sample whose list differs
  // from R+IR) fails conditions 1, 2 and 4; it is no longer a hold.
  const notDisplayedFailures = [];
  // Prereg v2 D3: the G-08/chronicle-index-unusable `index-ready` re-query.
  // The disclosure (not a condition): the eligible children, those that showed
  // a Graph and their edges, the Scenes they added to R+IR outside the
  // expectation, and the `index-ready` children D2 keeps with the (3)〜(6) each
  // lacks.
  const indexReady = {
    eligible: 0,
    graphShown: 0,
    graphEdgeCount: 0,
    outsideExpectationAdded: 0,
    outOfD3: 0,
    outOfD3Rows: [],
    problems: [],
  };
  const nexts = nextGraphArmOf(graph);
  for (const sample of graph) {
    const pair = pairList.get(sample.repeat);
    const result = classifyFollowUp(sample, {
      context: "steady",
      next: nexts.get(sample),
    });
    if (result.violations.length > 0)
      violationsB.push({
        repeat: sample.repeat,
        violations: result.violations,
      });
    // Prereg v2 D2·D4: the follow-up record's own `requeries[]` rows are read
    // as N29·N32 like the child (a late Graph in the display, two publishes).
    for (const record of [
      sample.followUp?.parent,
      sample.followUp?.child,
      ...(Array.isArray(sample.followUp?.requeries)
        ? sample.followUp.requeries
        : []),
    ])
      if (
        record &&
        (record.lateGraphInDisplay === true || record.publishCount > 1)
      )
        violationsB.push({
          repeat: sample.repeat,
          violations: [
            record.lateGraphInDisplay === true
              ? "late-graph-in-display"
              : "published-more-than-once",
          ],
        });
    const child = sample.followUp?.child;
    // D2/D3: only a child that meets D3's six conditions is set apart from
    // the "child" of K6/4:52 and checked by D3; every other child (including
    // an `index-ready` one missing a condition) stays a child (fail closed).
    const d3 =
      variant.key === "G-08/chronicle-index-unusable" &&
      d3Eligible(sample, child);
    const shown = [lists(sample.finalSceneIds)];
    if (child && child.publishCount > 0 && !d3)
      shown.push(lists(child.finalSceneIds));
    lastShown.push(shown.at(-1));
    const contribution = unique(
      shown.flatMap((list) => list.filter((id) => !pair.includes(id))),
    );
    const bad = contribution.filter(
      (id) => forbidden.has(id) || blocked.has(id),
    );
    if (bad.length > 0)
      violationsA.push({ repeat: sample.repeat, sceneIds: bad });
    // v2 C6 (ii): a `followUp.requeries` row that carries a Scene list adds to
    // the paired R+IR like a child does; a forbidden Scene or blocked
    // candidate is condition 5 (a) (a row without a list is N29·N32's).
    for (const requery of Array.isArray(sample.followUp?.requeries)
      ? sample.followUp.requeries
      : []) {
      if (!Array.isArray(requery?.finalSceneIds)) continue;
      const hit = unique(
        lists(requery.finalSceneIds).filter(
          (id) => !pair.includes(id) && (forbidden.has(id) || blocked.has(id)),
        ),
      );
      if (hit.length > 0)
        violationsA.push({
          repeat: sample.repeat,
          sceneIds: hit,
          reason: "followup-requery-row-forbidden-or-blocked-contribution",
        });
    }
    const baseline = unique(shown.flat()).filter(
      (id) => forbidden.has(id) && pair.includes(id),
    );
    if (baseline.length > 0)
      baselineForbidden.push({ repeat: sample.repeat, sceneIds: baseline });
    const outside = contribution.filter((id) => !expectedScenes.has(id));
    if (outside.length > 0 && !unavailable)
      outsideExpectation.push({ repeat: sample.repeat, sceneIds: outside });
    if (unavailable) {
      const shownGraph =
        sample.graph?.joined === true ||
        (child &&
          !d3 &&
          child.outcome === "graph-ready" &&
          child.publishCount > 0 &&
          (child.edgeCount ?? 0) > 0);
      if (shownGraph)
        violationsA.push({
          repeat: sample.repeat,
          sceneIds: [],
          reason: "graph-shown-for-a-variant-expected-unavailable",
        });
      // The parent's and the child's display must be the same list, in the
      // same order, as the paired R+IR (prereg 3; outcome.mjs unavailableQuality).
      if (!shown.every((list) => sameList(list, pair)))
        violationsA.push({
          repeat: sample.repeat,
          sceneIds: [],
          reason:
            "display-differs-from-r-plus-ir-for-a-variant-expected-unavailable",
        });
    } else {
      if (result.displayed) {
        displayedLists.push(lists(result.displayedSceneIds));
        counts[
          result.display === "first-render" ? "firstRender" : "followUp"
        ] += 1;
      } else {
        counts.notDisplayed += 1;
        if (result.parentContributed)
          notDisplayedFailures.push({
            repeat: sample.repeat,
            reason: "graph-contributed-parent-not-counted-as-first-render",
            firstRenderFails: result.firstRenderFails,
          });
        else if (!sameList(lists(sample.finalSceneIds), pair))
          notDisplayedFailures.push({
            repeat: sample.repeat,
            reason: "not-displayed-sample-differs-from-r-plus-ir",
          });
      }
    }
    if (d3) {
      indexReady.eligible += 1;
      const problems = d3Problems({
        sample,
        child,
        pair,
        lists,
        forbidden,
        blocked,
        typedRevisions:
          receipt?.settings?.setupReceipt?.logicalToRuntime?.typedRevisions,
        typedRevisionOrder: expectation.typedRevisionOrder,
      });
      if (child.outcome === "graph-ready" && (child.edgeCount ?? 0) > 0) {
        indexReady.graphShown += 1;
        indexReady.graphEdgeCount += child.edgeCount;
      }
      if (child.publishCount > 0)
        indexReady.outsideExpectationAdded += unique(
          lists(child.finalSceneIds).filter(
            (id) => !pair.includes(id) && !expectedScenes.has(id),
          ),
        ).length;
      for (const problem of problems)
        indexReady.problems.push({ repeat: sample.repeat, ...problem });
    } else if (
      variant.key === "G-08/chronicle-index-unusable" &&
      child?.origin === "index-ready"
    ) {
      indexReady.outOfD3 += 1;
      indexReady.outOfD3Rows.push({
        repeat: sample.repeat,
        missingConditions: d3Missing(sample, child),
      });
    }
    if (expectation.expectedContributions.length > 0) {
      const problems = edgeBindingProblems(
        sample,
        expectation.expectedContributions,
        result.firstRender,
      );
      if (problems === null) edgeSkipped += 1;
      else {
        edgeChecked += 1;
        if (problems.length > 0)
          edgeProblems.push({ repeat: sample.repeat, problems });
      }
    }
  }

  // Prereg v2 D4: the receipt's top-level `requeries` rows (trigger other than
  // `user-operation`) that carry a Scene list contribute like a child: what
  // they add to the paired R+IR must be no forbidden Scene or blocked
  // candidate. A row whose pair cannot be found (no `repeat` of a measured pair)
  // is matched against the forbidden and blocked Scenes alone. A row without a
  // Scene list is N29/N32's (classifyFollowUp). An R+IR arm row is the baseline.
  for (const requery of Array.isArray(receipt.requeries)
    ? receipt.requeries
    : []) {
    // A row that names no variant cannot be attributed to any variant and is
    // never dropped: condition 5 holds for every Graph arm variant (v2 C5,
    // DR-CP4-QV-3; see `a3-requery-row-without-variant-key`). A row of the
    // R+IR arm (`arm: "hybrid"`) is the baseline the others are read
    // against, so it is outside D4.
    if (
      requery !== null &&
      typeof requery === "object" &&
      requery.trigger !== "user-operation" &&
      typeof requery.variantKey !== "string"
    )
      row.requeryRowsWithoutVariantKey += 1;
    if (
      requery?.variantKey !== key ||
      requery.trigger === "user-operation" ||
      requery.arm === "hybrid" ||
      !Array.isArray(requery.finalSceneIds)
    )
      continue;
    const paired = pairList.get(requery.repeat) ?? [];
    const added = lists(requery.finalSceneIds).filter(
      (id) => !paired.includes(id),
    );
    const hit = unique(
      added.filter((id) => forbidden.has(id) || blocked.has(id)),
    );
    if (hit.length > 0)
      violationsA.push({
        repeat: requery.repeat ?? null,
        sceneIds: hit,
        reason: "requery-row-forbidden-or-blocked-contribution",
        trigger: requery.trigger ?? null,
      });
  }

  let graphList;
  if (unavailable) {
    graphList = lastShown[0];
    if (!lastShown.every((list) => sameList(list, graphList)))
      row.holdReasons.push("graph-arm-lists-differ");
  } else {
    if (displayedLists.length === 0)
      row.holdReasons.push("no-displayed-sample");
    graphList = displayedLists[0];
    if (!displayedLists.every((list) => sameList(list, graphList)))
      row.holdReasons.push("displayed-lists-differ");
  }
  row.displayed = counts;
  row.notDisplayedFailures = notDisplayedFailures;
  row.indexReadyRequery = indexReady;
  row.lists = { rPlusIr: hybridList, graph: graphList ?? null };

  // Metrics. A list the scorer refuses (ineligible, duplicate) holds.
  try {
    row.metrics = {
      rPlusIr: metricsOf(expectation, hybridList),
      graph: graphList ? metricsOf(expectation, graphList) : null,
    };
  } catch (error) {
    row.metrics = { rPlusIr: null, graph: null };
    row.holdReasons.push(`scorer-refused:${error.message}`);
  }
  row.expectedMetrics = expectation.metrics;
  row.expectationMatch =
    row.metrics.rPlusIr && row.metrics.graph
      ? {
          rPlusIr: metricsMatch(
            row.metrics.rPlusIr,
            expectation.metrics.rPlusIr,
            tolerance,
          ),
          graph: metricsMatch(
            row.metrics.graph,
            expectation.metrics.rPlusIrPlusGraph,
            tolerance,
          ),
        }
      : null;

  row.latency = {
    hybrid: latencyOf(hybrid, policy),
    graph: latencyOf(graph, policy),
    countsInVerdict: false,
  };
  row.edgeBinding = {
    status:
      expectation.expectedContributions.length === 0
        ? "n/a"
        : edgeProblems.length > 0
          ? "fail"
          : edgeChecked === 0
            ? "hold"
            : "pass",
    checked: edgeChecked,
    skipped: edgeSkipped,
    problems: edgeProblems,
  };
  row.forbidden = {
    a: {
      violations: violationsA,
      baseline: baselineForbidden,
      outsideExpectation,
    },
    b: { violations: violationsB },
  };
  return finishRow(row, expectation, tolerance);
}

function finishHeldRow(row, expectation) {
  row.displayed = null;
  row.notDisplayedFailures = [];
  row.indexReadyRequery = null;
  row.lists = null;
  row.metrics = null;
  row.expectedMetrics = expectation.metrics;
  row.expectationMatch = null;
  row.latency = null;
  row.edgeBinding = { status: "hold", checked: 0, skipped: 0, problems: [] };
  row.forbidden = { a: null, b: null };
  row.conditions = {
    "g01-predeclared-improvement": {
      status: expectation.predeclaredImprovement ? "hold" : "n/a",
    },
    "macro-non-regression": { status: "hold" },
    "hybrid-p95": { status: "hold", countsInVerdict: false },
    "evidence-validity": { status: "hold" },
    "forbidden-contribution": { status: "hold" },
  };
  return row;
}

function evidenceComponents(edgeStatus, contributionStatus = "n/a") {
  const missing = (reason) => ({ status: "not-evaluable", reason });
  return {
    "edge-binding": { status: edgeStatus },
    // Prereg v2 D8: a Graph that reached a display without being counted.
    "graph-contributed-parent-counted": { status: contributionStatus },
    "utf16-range": missing("not-in-the-receipt"),
    "explicit-pin-association": missing("not-in-the-receipt"),
    "raw-excerpt-unchanged": missing("not-in-the-receipt"),
    "added-scene-body-anchor": missing("not-in-the-receipt"),
  };
}

function finishRow(row, expectation, tolerance) {
  const held = row.holdReasons.length > 0;
  // Prereg v2 D8 (K6/4:171, K6/6 変える点 6): conditions 1 and 2, and 4 for a
  // variant with an expectation, fail.
  const notDisplayedFail = row.notDisplayedFailures.length > 0;
  const g = row.metrics?.graph;
  const h = row.metrics?.rPlusIr;
  const comparable = !held && g && h;
  const g01 = (() => {
    if (!expectation.predeclaredImprovement) return { status: "n/a" };
    if (notDisplayedFail)
      return {
        status: "fail",
        reasons: row.notDisplayedFailures.map((entry) => entry.reason),
      };
    if (!comparable) return { status: "hold", reasons: row.holdReasons };
    const improved =
      g.ndcgAt8 > h.ndcgAt8 + tolerance &&
      g.recallAt8 + tolerance >= h.recallAt8;
    const matches = row.expectationMatch.rPlusIr && row.expectationMatch.graph;
    return {
      status: !improved ? "fail" : matches ? "pass" : "hold",
      improved,
      matchesPredeclared: matches,
      rPlusIr: h,
      graph: g,
      predeclared: {
        rPlusIr: expectation.metrics.rPlusIr,
        rPlusIrPlusGraph: expectation.metrics.rPlusIrPlusGraph,
      },
    };
  })();
  const macro = notDisplayedFail
    ? {
        status: "fail",
        reasons: row.notDisplayedFailures.map((entry) => entry.reason),
      }
    : !comparable
      ? { status: "hold", reasons: row.holdReasons }
      : {
          status:
            g.recallAt8 + tolerance >= h.recallAt8 &&
            g.ndcgAt8 + tolerance >= h.ndcgAt8
              ? "pass"
              : "fail",
          deltaRecallAt8: g.recallAt8 - h.recallAt8,
          deltaNdcgAt8: g.ndcgAt8 - h.ndcgAt8,
        };
  const evidenceParts = evidenceComponents(
    row.edgeBinding.status,
    expectation.expectedContributions.length === 0
      ? "n/a"
      : notDisplayedFail
        ? "fail"
        : "pass",
  );
  const indexReady = row.indexReadyRequery;
  const indexReadyStatus =
    indexReady === null || indexReady.eligible === 0
      ? "n/a"
      : indexReady.problems.some((entry) => entry.kind === "fail")
        ? "fail"
        : indexReady.problems.some((entry) => entry.kind === "hold")
          ? "hold"
          : "pass";
  const forbiddenParts = {
    "a-forbidden-scene-or-blocked-candidate": {
      status: row.forbidden.a.violations.length > 0 ? "fail" : "pass",
      violations: row.forbidden.a.violations.length,
    },
    "b-late-graph-in-display": {
      status: row.forbidden.b.violations.length > 0 ? "fail" : "pass",
      violations: row.forbidden.b.violations.length,
    },
    "a2-index-ready-requery-forbidden": {
      status: indexReadyStatus,
      eligible: indexReady?.eligible ?? 0,
      graphShown: indexReady?.graphShown ?? 0,
      graphEdgeCount: indexReady?.graphEdgeCount ?? 0,
      outsideExpectationAdded: indexReady?.outsideExpectationAdded ?? 0,
      outOfD3: indexReady?.outOfD3 ?? 0,
      outOfD3Rows: indexReady?.outOfD3Rows ?? [],
      problems: indexReady?.problems ?? [],
    },
    "c-existing-24-graph-appearance-and-dto": {
      status: "not-evaluable",
      reason: "not-in-the-receipt",
    },
  };
  row.conditions = {
    "g01-predeclared-improvement": g01,
    "macro-non-regression": macro,
    "hybrid-p95": {
      status: worstStatus([
        row.latency.hybrid.status,
        row.latency.graph.status,
      ]),
      countsInVerdict: false,
    },
    "evidence-validity": {
      status: worstStatus(
        Object.values(evidenceParts).map((part) => part.status),
      ),
      components: evidenceParts,
    },
    "forbidden-contribution": {
      status: worstStatus(
        Object.values(forbiddenParts).map((part) => part.status),
      ),
      components: forbiddenParts,
    },
  };
  return row;
}

function assertAdmitted(receipts, allowList, label, expectedRunKind) {
  if (!allowList?.s4Commit || !allowList?.candidate)
    throw precheck("the allow list needs s4Commit and candidate");
  for (const receipt of receipts) {
    if (receipt?.runKind !== expectedRunKind)
      throw precheck(
        `${receipt?.runId}: ${label} receipt has runKind ${receipt?.runKind}`,
      );
    if (
      receipt.head?.observationPrep?.commit !== allowList.s4Commit ||
      receipt.candidate?.commit !== allowList.candidate
    )
      throw precheck(
        `${receipt.runId}: (s4Commit, candidate) is not the allowed pair`,
      );
    if (receipt.preview !== false || receipt.verdict?.outcome !== "recorded")
      throw precheck(`${receipt.runId}: not a recorded formal receipt`);
  }
  const selected = selectReceiptsForAggregation(receipts);
  if (selected.excluded.length > 0)
    throw precheck(
      `${label} receipts excluded from aggregation: ${selected.excluded
        .map((row) => `${row.runId}:${row.reason}`)
        .join(", ")}`,
    );
}

/**
 * The verdict. `expectations` maps each catalog variant key to the normalized
 * fixture expectation (loadExpectations in the CLI module). `blocked` is null
 * (no ledger: nothing is treated as blocked, and the output says so) or a map
 * of variant key to the ledger's `blocked:*` value.
 */
export function evaluateQualityVerdict({
  gold,
  parity = [],
  expectations,
  policy,
  tolerance,
  allowList,
  blocked = null,
}) {
  if (!Number.isFinite(tolerance) || tolerance <= 0)
    throw precheck("the metric tolerance must be read from the K6/2 text");
  assertAdmitted(gold, allowList, "gold", "g-case-gold");
  assertAdmitted(parity, allowList, "parity", "g-case-parity-unrestricted");
  const byKey = new Map(
    gold.map((receipt) => [receipt.settings?.variantKey, receipt]),
  );
  if (byKey.size !== gold.length)
    throw precheck("two gold receipts name the same variant");
  const variants = [];
  for (const variant of GRAPH_EVAL_VARIANTS) {
    const expectation = expectations?.[variant.key];
    if (!expectation)
      throw precheck(`${variant.key}: no expectation (fixture, manifest)`);
    if (expectation.expectedGraph !== variant.expectedGraph)
      throw precheck(
        `${variant.key}: fixture and catalog disagree on the expected Graph`,
      );
    const blockedReason = blocked?.[variant.key];
    if (
      typeof blockedReason === "string" &&
      blockedReason.startsWith("blocked")
    ) {
      variants.push({
        variantKey: variant.key,
        caseId: variant.caseId,
        blocked: blockedReason,
        conditions: null,
      });
      continue;
    }
    const receipt = byKey.get(variant.key);
    if (!receipt)
      throw precheck(`${variant.key}: neither a receipt nor a blocked record`);
    variants.push(
      evaluateVariant({ variant, receipt, expectation, policy, tolerance }),
    );
  }
  const live = variants.filter((row) => row.blocked === null);

  // 1. G-01 predeclared improvement.
  const g01Rows = live.filter(
    (row) => row.conditions["g01-predeclared-improvement"].status !== "n/a",
  );
  const g01Blocked = variants.some(
    (row) =>
      row.blocked !== null &&
      expectations[row.variantKey].predeclaredImprovement,
  );
  const g01 =
    g01Rows.length === 1
      ? {
          ...g01Rows[0].conditions["g01-predeclared-improvement"],
          variantKey: g01Rows[0].variantKey,
        }
      : {
          status: g01Blocked ? "not-evaluable" : "hold",
          reason: g01Blocked ? "blocked" : "no-predeclared-variant-measured",
        };

  // 2. macro non-regression (G-case scope only).
  // Prereg v2 D8 first: a variant that brought a Graph into the display
  // without being counted (or whose not-displayed sample differs from R+IR)
  // is a FAIL of condition 2 whatever the other variants hold, and it may have
  // no Graph list at all (`metrics.graph` null: nothing was displayed), so the
  // mean is never taken over it (the row's own macro is that fail already).
  const mean = (rows, arm, metric) =>
    rows.reduce((sum, row) => sum + row.metrics[arm][metric], 0) / rows.length;
  const notDisplayedRows = live.filter(
    (row) => row.notDisplayedFailures.length > 0,
  );
  let gcase;
  if (notDisplayedRows.length > 0) {
    gcase = {
      status: "fail",
      variants: live.length,
      notDisplayedFailures: notDisplayedRows.map((row) => ({
        variantKey: row.variantKey,
        repeats: row.notDisplayedFailures.map((entry) => entry.repeat),
        reasons: [
          ...new Set(row.notDisplayedFailures.map((entry) => entry.reason)),
        ],
      })),
    };
  } else if (
    live.length === 0 ||
    live.some((row) => row.conditions["macro-non-regression"].status === "hold")
  ) {
    gcase = { status: "hold", variants: live.length };
  } else {
    const recall = {
      rPlusIr: mean(live, "rPlusIr", "recallAt8"),
      graph: mean(live, "graph", "recallAt8"),
    };
    const ndcg = {
      rPlusIr: mean(live, "rPlusIr", "ndcgAt8"),
      graph: mean(live, "graph", "ndcgAt8"),
    };
    gcase = {
      status:
        recall.graph + tolerance >= recall.rPlusIr &&
        ndcg.graph + tolerance >= ndcg.rPlusIr
          ? "pass"
          : "fail",
      variants: live.length,
      recallAt8: recall,
      ndcgAt8: ndcg,
    };
  }
  const macroComponents = {
    "g-case": gcase,
    "existing-24-graph-arm": {
      status: "not-evaluable",
      reason: "no-graph-arm-receipt-for-the-existing-24-queries",
    },
  };
  const macro = {
    status: worstStatus(
      Object.values(macroComponents).map((part) => part.status),
    ),
    components: macroComponents,
  };

  // 3. Hybrid p95 (pooled per arm; both arms must be within the limit).
  const pool = (arm) => {
    const rows = live.flatMap((row) => {
      const receipt = byKey.get(row.variantKey);
      return pairSamples(receipt, row.variantKey)[
        arm === "graph" ? "graph" : "hybrid"
      ];
    });
    return { arm, ...latencyOf(rows, policy) };
  };
  const pooled = { hybrid: pool("hybrid"), graph: pool("graph") };
  const parityRows = parity.flatMap((receipt) =>
    (receipt.samples ?? []).filter(
      (row) =>
        row.arm === "hybrid" &&
        row.phase === "measured" &&
        row.trigger === "user-operation",
    ),
  );
  const p95 = {
    status: worstStatus([pooled.hybrid.status, pooled.graph.status]),
    populationNote:
      "G-case measured samples of the gold receipts, pooled per arm; not the 24-query P population",
    limitMs: policy.limit,
    percentile: policy.percentile,
    hybridArm: pooled.hybrid,
    graphArm: pooled.graph,
    parityHybridDisclosure:
      parityRows.length > 0
        ? { ...latencyOf(parityRows, policy), countsInVerdict: false }
        : null,
  };

  // 4. Evidence validity (edge binding only).
  const edgeRows = live.filter((row) => row.edgeBinding.status !== "n/a");
  const edgeStatus =
    edgeRows.length === 0
      ? "hold"
      : worstStatus(edgeRows.map((row) => row.edgeBinding.status));
  const evidenceParts = evidenceComponents(
    edgeStatus,
    worstStatus(
      live.map(
        (row) =>
          row.conditions["evidence-validity"].components?.[
            "graph-contributed-parent-counted"
          ]?.status ?? "n/a",
      ),
    ),
  );
  evidenceParts["edge-binding"].variants = edgeRows.length;
  evidenceParts["edge-binding"].checked = edgeRows.reduce(
    (sum, row) => sum + row.edgeBinding.checked,
    0,
  );
  evidenceParts["edge-binding"].skipped = edgeRows.reduce(
    (sum, row) => sum + row.edgeBinding.skipped,
    0,
  );
  const evidence = {
    status: worstStatus(
      Object.values(evidenceParts).map((part) => part.status),
    ),
    components: evidenceParts,
  };

  // 5. Forbidden contribution.
  const countOf = (pick) =>
    live.reduce((sum, row) => sum + pick(row).length, 0);
  const forbiddenParts = {
    "a-forbidden-scene-or-blocked-candidate": {
      status: worstStatus(
        live.map(
          (row) =>
            row.conditions["forbidden-contribution"].components?.[
              "a-forbidden-scene-or-blocked-candidate"
            ]?.status ?? "hold",
        ),
      ),
      violatingSamples: countOf((row) => row.forbidden.a?.violations ?? []),
      baselineForbiddenSamples: countOf(
        (row) => row.forbidden.a?.baseline ?? [],
      ),
      outsideExpectationSamples: countOf(
        (row) => row.forbidden.a?.outsideExpectation ?? [],
      ),
    },
    "b-late-graph-in-display": {
      status: worstStatus(
        live.map(
          (row) =>
            row.conditions["forbidden-contribution"].components?.[
              "b-late-graph-in-display"
            ]?.status ?? "hold",
        ),
      ),
      violatingSamples: countOf((row) => row.forbidden.b?.violations ?? []),
    },
    // Prereg v2 D3 (G-08/chronicle-index-unusable's `index-ready` re-query).
    "a2-index-ready-requery-forbidden": {
      status: worstStatus(
        live.map(
          (row) =>
            row.conditions["forbidden-contribution"].components?.[
              "a2-index-ready-requery-forbidden"
            ]?.status ?? "n/a",
        ),
      ),
      eligibleChildren: live.reduce(
        (sum, row) => sum + (row.indexReadyRequery?.eligible ?? 0),
        0,
      ),
      graphShownChildren: live.reduce(
        (sum, row) => sum + (row.indexReadyRequery?.graphShown ?? 0),
        0,
      ),
      graphEdgeCount: live.reduce(
        (sum, row) => sum + (row.indexReadyRequery?.graphEdgeCount ?? 0),
        0,
      ),
      outsideExpectationAdded: live.reduce(
        (sum, row) =>
          sum + (row.indexReadyRequery?.outsideExpectationAdded ?? 0),
        0,
      ),
      keptAsChildren: live.reduce(
        (sum, row) => sum + (row.indexReadyRequery?.outOfD3 ?? 0),
        0,
      ),
      keptAsChildrenMissing: live.flatMap((row) =>
        (row.indexReadyRequery?.outOfD3Rows ?? []).map((entry) => ({
          variantKey: row.variantKey,
          ...entry,
        })),
      ),
      problems: live.flatMap((row) =>
        (row.indexReadyRequery?.problems ?? []).map((entry) => ({
          variantKey: row.variantKey,
          ...entry,
        })),
      ),
    },
    // v2 C5: a top-level re-query row with no `variantKey` cannot be
    // attributed to a variant, so condition 5 holds for all of them.
    "a3-requery-row-without-variant-key": {
      status: live.some((row) => row.requeryRowsWithoutVariantKey > 0)
        ? "hold"
        : "n/a",
      rows: live.reduce(
        (sum, row) => sum + row.requeryRowsWithoutVariantKey,
        0,
      ),
    },
    "c-existing-24-graph-appearance-and-dto": {
      status: "not-evaluable",
      reason: "not-in-the-receipt",
    },
  };
  const forbiddenContribution = {
    status: worstStatus(
      Object.values(forbiddenParts).map((part) => part.status),
    ),
    components: forbiddenParts,
  };

  const conditions = {
    "g01-predeclared-improvement": g01,
    "macro-non-regression": macro,
    "hybrid-p95": p95,
    "evidence-validity": evidence,
    "forbidden-contribution": forbiddenContribution,
  };
  const ids = Object.keys(conditions);
  const failed = ids.filter((id) => conditions[id].status === "fail");
  const held = ids.filter((id) => conditions[id].status === "hold");
  const unverified = ids.filter(
    (id) => conditions[id].status === "not-evaluable",
  );
  const reasons = [
    ...(failed.length > 0 ? ["failed-required-items"] : []),
    ...(held.length > 0 ? ["held-required-items"] : []),
    ...(unverified.length > 0 ? ["unverified-required-items"] : []),
  ];
  const notEvaluable = [];
  for (const id of ids)
    for (const [part, value] of Object.entries(conditions[id].components ?? {}))
      if (value.status === "not-evaluable")
        notEvaluable.push({
          condition: id,
          component: part,
          reason: value.reason ?? null,
        });

  return {
    schema: QUALITY_VERDICT_SCHEMA,
    positioning: POSITIONING,
    allowList: { s4Commit: allowList.s4Commit, candidate: allowList.candidate },
    policy: { ...policy, metricTolerance: tolerance },
    blockedDetermination:
      blocked === null
        ? "not-imported (no ledger): every variant was counted"
        : "ledger",
    variants,
    conditions,
    verdict: {
      verdict: reasons.length === 0 ? "pass" : "hold",
      reasons,
      failed,
      held,
      unverified,
    },
    notEvaluable,
  };
}
