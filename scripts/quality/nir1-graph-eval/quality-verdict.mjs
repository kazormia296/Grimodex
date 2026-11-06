// CP-4 quality verdict (DR-CP4-QV-1): the five quality conditions of the Graph
// arm applied to the recorded receipts, outside the S2 procedure.
//
// Pure module: no file or process access. It never runs Graph, IR, Raw, a
// model, Electron or Native, never edits a receipt, and carries no threshold
// of its own: D is `GRAPH_EVAL_D_MS`, the percentile, the limit formula and
// the metric tolerance are read from the frozen manifests and the K6/2 text by
// the loader (quality-verdict-cli.mjs) and handed in as `policy` and
// `tolerance`. The definitions are fixed in
// docs/plans/nir1-cp4-records/quality-verdict-prereg-2026-11-06.md
// (contracts) before any value was computed.
//
// Existing pinned modules are imported only (followup.mjs, receipt.mjs,
// constants.mjs, nir1-retrieval/contract.mjs); none of them is changed.

import { GRAPH_EVAL_D_MS, GRAPH_EVAL_VARIANTS } from "./constants.mjs";
import { MEASURED_RUNS_PER_ARM } from "./constants.mjs";
import { classifyFollowUp } from "./followup.mjs";
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
 * Percentile, B and the Hybrid p95 limit from the retrieval manifest's own
 * statements (`performance.warm`), with D from the frozen constant.
 */
export function deriveLatencyPolicy(retrievalManifest, dMs = GRAPH_EVAL_D_MS) {
  const warm = retrievalManifest?.performance?.warm;
  const percentile = /^Raw-only p(\d+)\(t_return-t_fetch\)/u.exec(
    warm?.B ?? "",
  );
  const rule = /^min\((\d+)ms, ([0-9.]+)\*B\)$/u.exec(warm?.D ?? "");
  if (!percentile || !rule || warm?.hybridP95Limit !== "B+D")
    throw precheck(
      "retrieval manifest performance.warm does not state B, D and hybridP95Limit in the expected form",
    );
  const cap = Number(rule[1]);
  const coefficient = Number(rule[2]);
  if (!(Number.isFinite(coefficient) && coefficient > 0) || !(dMs < cap))
    throw precheck("B is not derivable from D (D is at or above its cap)");
  const b = dMs / coefficient;
  return Object.freeze({
    percentile: Number(`0.${percentile[1]}`),
    b: Number(b.toPrecision(12)),
    d: dMs,
    limit: Number((b + dMs).toPrecision(12)),
    source: {
      B: warm.B,
      D: warm.D,
      hybridP95Limit: warm.hybridP95Limit,
      percentileRule: warm.percentile,
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

/** The edge binding of one sample's child against the fixture's expectation. */
function edgeBindingProblems(sample, expected) {
  const child = sample.followUp?.child;
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
  for (const sample of graph) {
    const pair = pairList.get(sample.repeat);
    const result = classifyFollowUp(sample, { context: "steady" });
    if (result.violations.length > 0)
      violationsB.push({
        repeat: sample.repeat,
        violations: result.violations,
      });
    for (const record of [sample.followUp?.parent, sample.followUp?.child])
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
    const shown = [lists(sample.finalSceneIds)];
    if (child && child.publishCount > 0) shown.push(lists(child.finalSceneIds));
    lastShown.push(shown.at(-1));
    const contribution = unique(
      shown.flatMap((list) => list.filter((id) => !pair.includes(id))),
    );
    const bad = contribution.filter(
      (id) => forbidden.has(id) || blocked.has(id),
    );
    if (bad.length > 0)
      violationsA.push({ repeat: sample.repeat, sceneIds: bad });
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
        if (!sameList(lists(sample.finalSceneIds), pair))
          row.holdReasons.push("not-displayed-sample-differs-from-r-plus-ir");
      }
    }
    if (expectation.expectedContributions.length > 0) {
      const problems = edgeBindingProblems(
        sample,
        expectation.expectedContributions,
      );
      if (problems === null) edgeSkipped += 1;
      else {
        edgeChecked += 1;
        if (problems.length > 0)
          edgeProblems.push({ repeat: sample.repeat, problems });
      }
    }
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

function evidenceComponents(edgeStatus) {
  const missing = (reason) => ({ status: "not-evaluable", reason });
  return {
    "edge-binding": { status: edgeStatus },
    "utf16-range": missing("not-in-the-receipt"),
    "explicit-pin-association": missing("not-in-the-receipt"),
    "raw-excerpt-unchanged": missing("not-in-the-receipt"),
    "added-scene-body-anchor": missing("not-in-the-receipt"),
  };
}

function finishRow(row, expectation, tolerance) {
  const held = row.holdReasons.length > 0;
  const g = row.metrics?.graph;
  const h = row.metrics?.rPlusIr;
  const comparable = !held && g && h;
  const g01 = (() => {
    if (!expectation.predeclaredImprovement) return { status: "n/a" };
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
  const macro = !comparable
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
  const evidenceParts = evidenceComponents(row.edgeBinding.status);
  const forbiddenParts = {
    "a-forbidden-scene-or-blocked-candidate": {
      status: row.forbidden.a.violations.length > 0 ? "fail" : "pass",
      violations: row.forbidden.a.violations.length,
    },
    "b-late-graph-in-display": {
      status: row.forbidden.b.violations.length > 0 ? "fail" : "pass",
      violations: row.forbidden.b.violations.length,
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
  const mean = (rows, arm, metric) =>
    rows.reduce((sum, row) => sum + row.metrics[arm][metric], 0) / rows.length;
  let gcase;
  if (
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
  const evidenceParts = evidenceComponents(edgeStatus);
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
