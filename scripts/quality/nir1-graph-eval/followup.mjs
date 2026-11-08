// CP-4 K6/4 follow-up availability: one recorded query becomes first-render
// (in the D window), follow-up (F1〜F7 all hold) or not displayed (X1〜X13),
// with the 「遅れた結果を混ぜない」 violations kept apart (FAIL) and the 批准 12
// violations of the candidate (N30) reported for the summary.
//
// Contract: draftRef `nir1-final-request-eval-proposal/4`, contractId
// `graph-eval-procedure`, SHA-256 d205b35f…23c3 (K64_FREEZE), confirmed
// 2026-10-26 (Session B5), read with K6/5 (`…/5`, SHA-256 1ad10884…24a7,
// K65_FREEZE): D is 40 ms and the parent window check is a `[precheck]`
// (K6/5 変える点 6). Line numbers below are the /4 file's:
//   F1〜F7 :137-145, X1〜X13 :147-161, FAIL :163, 表示の可用性 :165-167,
//   品質 :169-171, R1〜R7 :190-198, 変える点 15 :109, 批准 5 :32, 批准 12 :39.
//
// K6/6 (draftRef `nir1-final-request-eval-proposal/6`, revision 3, confirmed
// 2026-11-08 and frozen at `56fb4fad…`): the steady state's first render is decided by `firstRenderOf`
// (R-6 (a)〜(c), R-7, FR-1〜FR-8) instead of K6/2's literal reading, which is
// structurally false under R1 (join.mjs `k62SteadyStateInWindow`). The (b)
// trace's first render is unchanged. Not judged, not frozen.
//
// Pure module: it classifies a query that a harness already recorded through
// the product hook consumer (R5) and never observes a runtime. W_f, T_late,
// T_show, D and the boundary tolerance come from constants.mjs only.
//
// The R7 record is `sample.followUp` (test-support.mjs `followUpRecord` is the
// reference shape): `issuedVia`, `parent` (generation, sceneId, seed, tPub =
// t_pub_p, declaration, graphContinueAnswer, graphWindowMs, refreshTrigger,
// publishCount, lateGraphInDisplay, rSceneIds, irSceneIds, ticket,
// irRetryTimer), `notices` [{kind, at}], `counters` {before, after} of
// begins / cacheHits / lateCached, `nativeBegins` (the begin kinds in
// order), `r1` / `r2` (steady state only), `cacheLoss`, `dPrimeCounters`,
// `loading` and `child` (null when no child began). A key that is present
// with null means the event did not happen; a missing key is a missing record
// (X10).

import { isCollectedFacts, isTestEvidenceAllowed } from "./admission-facts.mjs";
import {
  BOUNDARY_TOLERANCE_MS,
  GRAPH_EVAL_D_MS,
  K64_CANDIDATE_REQUIREMENTS,
  K64_HOOK_CONSUMER_RUNNER,
  K64_T_LATE_MS,
  K64_T_SHOW_MS,
  K64_W_F_MS,
  OWNER_REBUILD_MIN_INTERVAL_MS,
  rejectOverrides,
} from "./constants.mjs";
import {
  BOUNDARY_DISAGREEMENTS,
  FRESHNESS_REASONS,
  RETIRED_FRESHNESS_STAMP_BUSY,
  SETUP_DEFECT_REASONS,
  assertNoRetiredBusy,
  classifyJoin,
  finite,
  lapseKind,
  USER_OPERATION,
} from "./join.mjs";

export const FOLLOW_UP_CONTEXTS = Object.freeze(["steady", "trace"]);
/** R5: the only issuer whose queries K6/4 judges (N16). */
export const PRODUCT_HOOK = "product-hook";
/**
 * DR-CP4-F-6 (integrator, 2026-10-27): the unit F6's 「事前登録した期待寄与の
 * 材料から寄与がある」 was matched on. A formal receipt carries only F6
 * judgements matched on the materials' Revisions (option (b): the evaluation
 * Native records the Graph result's material Revisions; not built yet, so a
 * formal receipt stops). The Scene-level approximation is preview only.
 */
export const F6_FORMAL_BASIS = "material-revision";
export const F6_PREVIEW_BASIS = "scene-level-preview";

const NOTICE_KINDS = new Set(["graph-ready", "index-ready"]);
const COUNTER_KEYS = Object.freeze(["begins", "cacheHits", "lateCached"]);
const DPRIME_COUNTER_KEYS = Object.freeze([
  "deferredReleased",
  "deferredExpired",
  "deferredDropped",
  "staleReadyRetired",
  "prepareFailures",
  "driftAtQuery",
  "stamp0Missing",
]);
/**
 * K6/6 変える点 7: the two counters the first-render condition (R-6 (b)) reads.
 * Required in the steady state only; a (b) trace record keeps the seven keys
 * above (K6/6-P5; `trace-record.mjs` is not changed).
 */
const DPRIME_STEADY_ONLY_KEYS = Object.freeze([
  "preparesStarted",
  "preparesReady",
]);
const DPRIME_STEADY_KEYS = Object.freeze([
  ...DPRIME_COUNTER_KEYS,
  ...DPRIME_STEADY_ONLY_KEYS,
]);
/**
 * The order of the follow-up's stages (K6/4:109 「失敗した段の理由」). The
 * failed stage of a query is the first one with a failure; within a stage
 * K6/2 rule 4 (失効、その他、鮮度) picks the category. DR-CP4-K64-3.
 */
export const FOLLOW_UP_STAGES = Object.freeze([
  "records",
  "parent",
  "cache",
  "notice",
  "child-begin",
  "child-join",
  "child-publish",
  "display",
  "quality",
]);
const CATEGORY_ORDER = Object.freeze(["lapse", "other", "freshness"]);
const SHA256_HEX = /^[0-9a-f]{64}$/u;
const LAPSE_TICKET_REASONS = new Set([
  "registration-unavailable",
  "invalidated",
]);

function has(object, key) {
  return (
    object !== null && typeof object === "object" && Object.hasOwn(object, key)
  );
}
const numberOrNull = (value) => value === null || finite(value);
const stringOrNull = (value) => value === null || typeof value === "string";
const sceneIds = (value) =>
  Array.isArray(value) && value.every((row) => typeof row === "string");
const counterBlock = (value) =>
  value !== null &&
  typeof value === "object" &&
  COUNTER_KEYS.every((key) => Number.isInteger(value[key]) && value[key] >= 0);

function sameList(left, right) {
  return (
    Array.isArray(left) &&
    Array.isArray(right) &&
    left.length === right.length &&
    left.every((value, at) => value === right[at])
  );
}

function ticketShape(ticket) {
  return (
    ticket === null ||
    (typeof ticket === "object" &&
      typeof ticket.settled === "boolean" &&
      typeof ticket.outcome === "string" &&
      has(ticket, "reason") &&
      stringOrNull(ticket.reason) &&
      has(ticket, "disposition") &&
      stringOrNull(ticket.disposition))
  );
}

/**
 * DR-CP4-V-3 (rule P-b): a (b) trace's counted parent the product cancelled
 * before its begin (no begin, no Native record, never published; the trace
 * records it with `parent.cancelledBeforeBegin`). Only the observable items
 * are recorded: the generation, the Scene and seed, the call and the return
 * of the fetch, the publish count 0, no Native begin and no child. Any other
 * shape is not this case (the usual R7 check applies, X10). DR-CP4-V-4
 * (レビュー P3): the mark holds only with the sample's own values of that case
 * (the fetch `cancelled` / `not-started`, the join `cancelled`, the snapshot
 * not usable); a mark the sample contradicts is not this case either.
 */
function cancelledBeforeBeginRecord(sample, context) {
  const record = sample?.followUp;
  const parent = record?.parent;
  return (
    context === "trace" &&
    sample?.status === "cancelled" &&
    sample?.rawStatus === "not-started" &&
    sample?.graph?.outcome === "cancelled" &&
    sample?.snapshot?.usable === false &&
    record !== null &&
    typeof record === "object" &&
    parent !== null &&
    typeof parent === "object" &&
    parent.cancelledBeforeBegin === true &&
    Number.isInteger(parent.generation) &&
    typeof parent.sceneId === "string" &&
    typeof parent.seed === "string" &&
    finite(parent.calledAt) &&
    finite(parent.resolvedAt) &&
    parent.calledAt <= parent.resolvedAt &&
    parent.publishCount === 0 &&
    Array.isArray(record.nativeBegins) &&
    record.nativeBegins.length === 0 &&
    has(record, "child") &&
    record.child === null
  );
}

/**
 * DR-CP4-C7: a (b) trace's counted parent whose begin the Chronicle Index's
 * stop kept from creating a Native record (no Native record, no child; the
 * trace records it with `parent.excludedChronicleStop`). Only the observable
 * items are recorded, and the mark holds only with the sample's own values of
 * that case: the IR outcome `index-unavailable`, the join
 * `graph-unavailable` / `cancelled`, no Native begin. Any other shape is not
 * this case (the usual R7 check applies, X10).
 */
function chronicleStopRecord(sample, context) {
  const record = sample?.followUp;
  const parent = record?.parent;
  return (
    context === "trace" &&
    sample?.irOutcome === "index-unavailable" &&
    sample?.graph?.outcome === "graph-unavailable" &&
    sample?.graph?.reason === "cancelled" &&
    sample?.nativeBegin === null &&
    record !== null &&
    typeof record === "object" &&
    parent !== null &&
    typeof parent === "object" &&
    parent.excludedChronicleStop === true &&
    Number.isInteger(parent.generation) &&
    typeof parent.sceneId === "string" &&
    typeof parent.seed === "string" &&
    finite(parent.calledAt) &&
    finite(parent.resolvedAt) &&
    parent.calledAt <= parent.resolvedAt &&
    Number.isInteger(parent.publishCount) &&
    parent.publishCount >= 0 &&
    typeof parent.lateGraphInDisplay === "boolean" &&
    Array.isArray(record.requeries) &&
    record.requeries.every(
      (row) =>
        Number.isInteger(row?.publishCount) &&
        row.publishCount >= 0 &&
        typeof row.lateGraphInDisplay === "boolean",
    ) &&
    Array.isArray(record.nativeBegins) &&
    record.nativeBegins.length === 0 &&
    has(record, "child") &&
    record.child === null
  );
}

/**
 * The R7 items a query lacks (K6/4:198; X10 :158). `null` means "did not
 * happen" and is allowed where the event is optional; an absent key or a
 * wrong type is missing. R1 / R2 are required in the steady state only
 * (変える点 15: (b) では R1 と R2 を当てず). DR-CP4-V-3: a (b) parent
 * cancelled before its begin needs only its observable items.
 */
export function missingR7(sample, context) {
  const record = sample?.followUp;
  if (!record || typeof record !== "object") return ["followUp"];
  if (cancelledBeforeBeginRecord(sample, context)) return [];
  if (chronicleStopRecord(sample, context)) return [];
  const missing = [];
  const need = (ok, name) => {
    if (!ok) missing.push(name);
  };
  const parent = record.parent;
  if (!parent || typeof parent !== "object") missing.push("parent");
  else {
    need(Number.isInteger(parent.generation), "parent.generation");
    need(
      typeof parent.sceneId === "string" && typeof parent.seed === "string",
      "parent.sceneId/seed",
    );
    need(finite(parent.tPub), "parent.tPub");
    need(
      has(parent, "declaration") && stringOrNull(parent.declaration),
      "parent.declaration",
    );
    need(
      has(parent, "graphContinueAnswer") &&
        stringOrNull(parent.graphContinueAnswer),
      "parent.graphContinueAnswer",
    );
    need(
      has(parent, "graphWindowMs") && numberOrNull(parent.graphWindowMs),
      "parent.graphWindowMs",
    );
    need(
      has(parent, "refreshTrigger") && stringOrNull(parent.refreshTrigger),
      "parent.refreshTrigger",
    );
    need(
      Number.isInteger(parent.publishCount) && parent.publishCount >= 0,
      "parent.publishCount",
    );
    need(
      typeof parent.lateGraphInDisplay === "boolean",
      "parent.lateGraphInDisplay",
    );
    need(
      sceneIds(parent.rSceneIds) && sceneIds(parent.irSceneIds),
      "parent.rSceneIds/irSceneIds",
    );
    need(has(parent, "ticket") && ticketShape(parent.ticket), "parent.ticket");
    need(typeof parent.irRetryTimer === "boolean", "parent.irRetryTimer");
  }
  need(
    Array.isArray(record.notices) &&
      record.notices.every(
        (row) => NOTICE_KINDS.has(row?.kind) && finite(row.at),
      ),
    "notices",
  );
  need(
    counterBlock(record.counters?.before) &&
      counterBlock(record.counters?.after),
    "counters",
  );
  need(
    Array.isArray(record.nativeBegins) &&
      record.nativeBegins.every((row) => typeof row === "string"),
    "nativeBegins",
  );
  need(
    record.dPrimeCounters !== null &&
      typeof record.dPrimeCounters === "object" &&
      (context === "steady" ? DPRIME_STEADY_KEYS : DPRIME_COUNTER_KEYS).every(
        (key) => Number.isInteger(record.dPrimeCounters[key]),
      ),
    "dPrimeCounters",
  );
  need(typeof record.loading?.switched === "boolean", "loading.switched");
  need(
    !has(record, "cacheLoss") ||
      (Array.isArray(record.cacheLoss) &&
        record.cacheLoss.every((row) => typeof row === "string")),
    "cacheLoss",
  );
  need(has(record, "child"), "child");
  const child = record.child;
  if (child !== null && child !== undefined) {
    if (typeof child !== "object") missing.push("child");
    else {
      need(typeof child.origin === "string", "child.origin");
      need(Number.isInteger(child.generation), "child.generation");
      need(
        has(child, "refreshTrigger") && stringOrNull(child.refreshTrigger),
        "child.refreshTrigger",
      );
      need(
        has(child, "graphWindowMs") && numberOrNull(child.graphWindowMs),
        "child.graphWindowMs",
      );
      need(
        typeof child.sceneId === "string" && typeof child.seed === "string",
        "child.sceneId/seed",
      );
      need(finite(child.beginAt), "child.beginAt");
      need(typeof child.beginKind === "string", "child.beginKind");
      for (const key of [
        "tRawReady",
        "tGraph",
        "irArrivedAt",
        "tFollow",
        "reactCommitAt",
      ])
        need(has(child, key) && numberOrNull(child[key]), `child.${key}`);
      need(typeof child.irOutcome === "string", "child.irOutcome");
      need(
        typeof child.outcome === "string" &&
          has(child, "reason") &&
          stringOrNull(child.reason),
        "child.outcome/reason",
      );
      need(
        has(child, "edgeCount") &&
          (child.edgeCount === null ||
            (Number.isInteger(child.edgeCount) && child.edgeCount >= 0)),
        "child.edgeCount",
      );
      need(
        typeof child.expectedContribution === "boolean",
        "child.expectedContribution",
      );
      need(
        has(child, "requalification") && stringOrNull(child.requalification),
        "child.requalification",
      );
      need(typeof child.completion === "string", "child.completion");
      need(
        Number.isInteger(child.publishCount) && child.publishCount >= 0,
        "child.publishCount",
      );
      need(
        typeof child.currentAtDisplay === "boolean",
        "child.currentAtDisplay",
      );
      need(
        typeof child.lateGraphInDisplay === "boolean",
        "child.lateGraphInDisplay",
      );
      // D-4: the child's initial snapshot (the product's completion never
      // says index-unavailable, DR-CP4-K64-11).
      need(
        typeof child.chronicleIndexUsable === "boolean",
        "child.chronicleIndexUsable",
      );
      need(
        sceneIds(child.rSceneIds) &&
          sceneIds(child.irSceneIds) &&
          sceneIds(child.finalSceneIds),
        "child.sceneIds",
      );
      // P2-3: the K6/4 runner observes the mixing (N29, N32) after the
      // sample's end until the child's Graph continues returned and W_f
      // passed; a window the harness guard cut leaves 公開の回数 unobserved.
      if (
        sample.runnerKind === K64_HOOK_CONSUMER_RUNNER &&
        child.completion !== "not-returned"
      )
        need(child.mixWindow?.reason === "settled", "child.mixWindow");
      if (child.publishCount > 0)
        need(
          finite(child.tRawReady) &&
            finite(child.tFollow) &&
            finite(child.reactCommitAt),
          "child.publishedTimes",
        );
      if (child.outcome === "graph-ready")
        need(
          finite(child.tRawReady) && finite(child.tGraph),
          "child.graphTimes",
        );
    }
  }
  if (context === "steady") {
    const r1 = record.r1;
    need(
      r1 !== null &&
        typeof r1 === "object" &&
        typeof r1.slotEmpty === "boolean" &&
        typeof r1.cacheEmpty === "boolean" &&
        has(r1, "sinceLastSeededMs") &&
        numberOrNull(r1.sinceLastSeededMs) &&
        typeof r1.previousReleaseWithinLimit === "boolean" &&
        typeof r1.reachedQuiet === "boolean",
      "r1",
    );
    need(typeof record.r2?.cacheEmptyAtEnd === "boolean", "r2");
    // レビュー P3: F2 over the whole sample through R4's release wait.
    if (sample.runnerKind === K64_HOOK_CONSUMER_RUNNER)
      need(counterBlock(record.countersAfterRelease), "countersAfterRelease");
  }
  return missing;
}

/** R1 (1)〜(4) (K6/4:192) that the record's values do not meet (D-3). */
function unmetR1(r1) {
  const unmet = [];
  if (r1.slotEmpty !== true) unmet.push("slot");
  if (r1.cacheEmpty !== true) unmet.push("cache");
  if (
    r1.sinceLastSeededMs !== null &&
    !(r1.sinceLastSeededMs >= OWNER_REBUILD_MIN_INTERVAL_MS)
  )
    unmet.push("interval");
  if (r1.previousReleaseWithinLimit !== true) unmet.push("release");
  return unmet;
}

/** N1 / N29 / N32 read defensively from a record that may be incomplete. */
export function mixedIntoDisplay(record) {
  const out = [];
  const parent = record?.parent;
  const child = record?.child;
  if (parent?.lateGraphInDisplay === true)
    out.push("N1:late-graph-in-parent-display");
  if (Number.isInteger(parent?.publishCount) && parent.publishCount > 1)
    out.push("N1:parent-published-more-than-once");
  if (child?.lateGraphInDisplay === true)
    out.push("N29:late-graph-in-child-display");
  if (Number.isInteger(child?.publishCount) && child.publishCount > 1)
    out.push("N32:child-published-more-than-once");
  // DR-CP4-C7: a parent without a Native record has no child record; its
  // re-queries in the window are checked as the child is.
  for (const requery of Array.isArray(record?.requeries)
    ? record.requeries
    : []) {
    if (requery?.lateGraphInDisplay === true)
      out.push("N29:late-graph-in-child-display");
    if (Number.isInteger(requery?.publishCount) && requery.publishCount > 1)
      out.push("N32:child-published-more-than-once");
  }
  return out;
}

const sameCounter = (record, key, want) =>
  record.dPrimeCounters?.[key] === want;

/**
 * K6/6 (変える点 1〜3): for each Graph-arm sample of a receipt, the next Graph
 * arm sample of the same phase in the receipt's order (hybrid-arm samples are
 * skipped by construction), as `{ preparesReady }`, or `null` for the last one
 * of its phase. R-6 (c) reads `next.preparesReady − this.preparesReady`.
 * A Map keyed by the row object; non-Graph-arm rows have no entry.
 *
 * A Gold receipt holds one variant (the 13 receipts of s6r1), so "the phase"
 * is read per variant: the sequence is grouped by `variantKey` and `phase`, which
 * is the same thing for one receipt and keeps a concatenated pool from
 * pairing the last sample of one variant with the first of the next (a setup
 * in between). Only the scheduled user-operation rows count (re-query rows are
 * never scheduled; `availability.mjs` `separateRequeries`).
 */
export function nextGraphArmOf(samples) {
  const out = new Map();
  const nextByGroup = new Map();
  for (let at = samples.length - 1; at >= 0; at -= 1) {
    const row = samples[at];
    if (row?.arm !== "graph" || row.trigger !== USER_OPERATION) continue;
    const group = `${row.variantKey}\u0000${row.phase}`;
    out.set(row, nextByGroup.get(group) ?? null);
    nextByGroup.set(group, { preparesReady: row.startSlot?.preparesReady });
  }
  return out;
}

/**
 * K6/6 変える点 3 (FR-1〜FR-8) with 1 (R-6) and 2 (R-7): does a steady-state
 * parent count as a first render? Only a parent whose join is in the D window
 * is a candidate; the others are decided by the join alone (no `fails`).
 * `fails` lists every sub-condition the candidate misses (codes begin with the
 * condition: `R1`, `a`/`b`/`c` of R-6, `FR1`〜`FR7`), so that the disclosure
 * (変える点 5) and the F1 detail name which one dropped it. A record error
 * N-d (FR-8) stops with `[artifact]`.
 *
 * `next` is `nextGraphArmOf(samples).get(sample)`: `null` for the last Graph
 * arm sample of its phase (then (c) is not applied, K6/6-P4); `undefined`
 * (not given) is a `[precheck]` for a candidate.
 */
export function firstRenderOf(sample, join, next) {
  const fails = [];
  const no = (code, detail = null) =>
    fails.push(detail === null ? code : `${code}:${detail}`);
  if (!join.inWindow) return { candidate: false, counted: false, fails };
  const graph = sample.graph;
  const record = sample.followUp;
  const parent = record.parent;
  const counters = record.dPrimeCounters;

  // FR-8 / N-d: records the product's own rules rule out.
  if (sample.freshnessStamp?.result === "stale")
    throw new Error(
      "[artifact] K6/6 FR-8: a parent that joined its Graph in the window has a `stale` freshness stamp (the product never queries on Stale)",
    );
  if (counters.driftAtQuery !== 0 || counters.prepareFailures !== 0)
    throw new Error(
      `[artifact] K6/6 FR-8: a parent that joined its Graph in the window recorded driftAtQuery=${counters.driftAtQuery}, prepareFailures=${counters.prepareFailures}`,
    );

  // FR-1: a worker result that passed the return-time revalidation
  // (classifyJoin: in window and `revalidation: "passed"`); a `Cached` origin
  // is not counted (K6/4-N39).
  if (graph.source !== "worker") no("FR1", `source-${graph.source}`);

  // R1 (a): R-6 (a) and K6/6-N1.
  if (record.r1.reachedQuiet !== true) no("a", "reached-quiet-false");
  else {
    const unmet = unmetR1(record.r1);
    if (unmet.length > 0)
      no("a", `r1-self-report-disagrees-${unmet.join("+")}`);
  }

  // R-6 (b): the one prepare of this sample, and the worker that answered.
  if (!sameList(record.nativeBegins, ["pending"]))
    no("b", `begin-records-${(record.nativeBegins ?? []).join(">")}`);
  if (sample.startSlot?.kind !== "empty")
    no("b", `start-slot-${String(sample.startSlot?.kind)}`);
  if (!sameCounter(record, "preparesStarted", 1))
    no("b", `prepares-started-${counters.preparesStarted}`);
  if (!sameCounter(record, "preparesReady", 1))
    no("b", `prepares-ready-${counters.preparesReady}`);
  if (!sameCounter(record, "deferredReleased", 1))
    no("b", `deferred-released-${counters.deferredReleased}`);
  if (!sameCounter(record, "staleReadyRetired", 0))
    no("b", `stale-ready-retired-${counters.staleReadyRetired}`);

  // R-6 (c): the next Graph arm sample of the phase starts one READY later.
  if (next === undefined)
    throw new Error(
      "[precheck] K6/6 (c): the next Graph arm sample of the phase was not given (nextGraphArmOf); a first-render candidate cannot be judged",
    );
  if (next !== null) {
    const here = sample.startSlot?.preparesReady;
    const there = next.preparesReady;
    if (!(finite(here) && finite(there))) no("c", "prepares-ready-unrecorded");
    else if (there - here !== 1)
      no("c", `next-prepares-ready-diff-${there - here}`);
  }

  // R-7 (ii′), FR-3.
  const stamp = sample.freshnessStamp?.result ?? null;
  if (stamp === "fresh") {
    // counted
  } else if (stamp === "stamp0-missing") {
    // The ② items a record can show (a joined parent has them all).
    if (parent.ticket?.outcome !== "available")
      no("FR3", "ticket-not-available");
    if (parent.declaration !== "used") no("FR3", "declaration-not-used");
    if (!(graph.outcome === "graph-ready" && graph.joined === true))
      no("FR3", "not-joined");
    if (graph.revalidation !== "passed") no("FR3", "revalidation-not-passed");
    if (!Number.isInteger(graph.edgeCount)) no("FR3", "edge-count-not-integer");
  } else no("FR3", `stamp-${stamp === null ? "missing" : stamp}`);

  // FR-4: owner counters, over the whole sample and after the release wait.
  const delta = (block) =>
    counterBlock(block)
      ? Object.fromEntries(
          COUNTER_KEYS.map((key) => [
            key,
            block[key] - record.counters.before[key],
          ]),
        )
      : null;
  for (const [name, block] of [
    ["after", record.counters.after],
    ["after-release", record.countersAfterRelease],
  ]) {
    const d = delta(block);
    if (d === null) no("FR4", `counters-${name}-missing`);
    else if (!(d.begins === 1 && d.lateCached === 0 && d.cacheHits === 0))
      no(
        "FR4",
        `counters-${name}-begins=${d.begins},lateCached=${d.lateCached},cacheHits=${d.cacheHits}`,
      );
  }
  if (record.r2.cacheEmptyAtEnd !== true) no("FR4", "cache-left-at-end");

  // FR-5: declaration, one publish. (The window D itself is a `[precheck]`
  // before this function is reached.)
  if (parent.declaration !== "used")
    no("FR5", `declaration-${parent.declaration}`);
  if (parent.publishCount !== 1)
    no("FR5", `publish-count-${parent.publishCount}`);

  // FR-6: nothing after the parent (K6/4-P2: 「子は出ない」 observed).
  if (record.notices.some((row) => row.kind === "graph-ready"))
    no("FR6", "graph-ready-notice");
  if (record.child !== null && record.child !== undefined)
    no("FR6", `child-${record.child.origin}`);
  if (parent.irRetryTimer === true) no("FR6", "ir-retry-timer");

  // FR-7: the parent's contribution record, matched on the materials'
  // Revisions with every edge resolved (the same unit as F6).
  const contribution = parent.contribution;
  if (contribution === null || typeof contribution !== "object")
    no("FR7", "no-contribution-record");
  else {
    if (contribution.contributionBasis !== F6_FORMAL_BASIS)
      no("FR7", `basis-${String(contribution.contributionBasis)}`);
    if (contribution.materialRevision?.unresolvedEdges !== 0)
      no(
        "FR7",
        `unresolved-edges-${String(contribution.materialRevision?.unresolvedEdges)}`,
      );
    if (!(Number.isInteger(graph.edgeCount) && graph.edgeCount >= 1))
      no("FR7", "no-edge");
    if (contribution.expectedContribution !== true)
      no("FR7", "no-expected-contribution");
  }
  return { candidate: true, counted: fails.length === 0, fails };
}

/**
 * K6/6 変える点 6: the parent's join brought a Graph into the display
 * (`graph-ready`, joined, declared `used`, at least one edge) within the D
 * window. A parent like this that is not counted as a first render fails the
 * variant's quality whatever its Scene list.
 */
function parentContributed(sample, join) {
  return (
    join.inWindow &&
    sample.graph?.outcome === "graph-ready" &&
    sample.graph.joined === true &&
    sample.followUp?.parent?.declaration === "used" &&
    Number.isInteger(sample.graph.edgeCount) &&
    sample.graph.edgeCount >= 1
  );
}

/**
 * One query → its K6/4 classification. `context` is "steady" (定常状態: the
 * first render counts worker results only, K6/2 step 3; R1, R2 and the F2
 * sample counters apply) or "trace" ((b): the first render is K6/2 rule 2,
 * R1/R2 do not apply, F2 is read between the parent's and the child's begin).
 */
export function classifyFollowUp(sample, options) {
  rejectOverrides(options ?? {}, ["context", "next"]);
  const context = options?.context;
  if (!FOLLOW_UP_CONTEXTS.includes(context))
    throw new Error(
      "[precheck] classifyFollowUp needs context steady or trace",
    );
  assertNoRetiredBusy(sample);
  const join = classifyJoin(sample);
  // (b): K6/2 rule 2 read through K6/4:165 — a parent that joined as
  // `Cached` within D is not displayed (D-5, the strict reading). The steady
  // state is decided below by `firstRenderOf` (K6/6 変える点 3), after the
  // records and the parent's window are checked.
  let firstRender =
    context === "steady"
      ? false
      : join.inWindow &&
        sample.graph?.source === "worker" &&
        sample.snapshot?.usable === true;
  let firstRenderFails = [];
  const stages = [];
  const x = {};
  const violations = [];
  const ratification12 = [];
  const q = { q1: null, q2: null, q3: null };
  const add = (stage, code, detail) => {
    stages.push({ stage, code, detail });
    if (!Object.hasOwn(x, code)) x[code] = detail;
  };
  const finish = (followUp, child = null) => {
    const failed = FOLLOW_UP_STAGES.find((name) =>
      stages.some((row) => row.stage === name),
    );
    return Object.freeze({
      context,
      firstRender,
      firstRenderFails,
      parentContributed: parentContributed(sample, join),
      followUp,
      displayed: firstRender || followUp,
      display: firstRender ? "first-render" : followUp ? "follow-up" : null,
      displayedSceneIds: firstRender
        ? sample.finalSceneIds
        : followUp
          ? child.finalSceneIds
          : null,
      x,
      stages,
      failedStage:
        firstRender || followUp || !failed
          ? null
          : {
              stage: failed,
              codes: stages.filter((row) => row.stage === failed),
            },
      violations,
      ratification12,
      q,
      loadingSwitched:
        sample.followUp?.loading?.switched === true &&
        sample.followUp?.child != null,
      boundary: join.disagreement,
    });
  };

  const missing = missingR7(sample, context);
  if (missing.length > 0) {
    add("records", "X10", `missing:${missing.join(",")}`);
    // D-11: a late result mixed into a display stays a violation even when
    // other records are missing (K6/4:163).
    violations.push(...mixedIntoDisplay(sample.followUp));
    return finish(false);
  }
  // DR-CP4-V-3 (rule P-b): the parent's generation was cancelled before its
  // begin; K6/4:160 X12 (「親の合流が … `cancelled` … の世代」), a follow-up
  // failure kept in the denominator. Nothing after the parent was recorded.
  if (cancelledBeforeBeginRecord(sample, context)) {
    add("parent", "X12", "cancelled-before-begin");
    return finish(false);
  }
  // DR-CP4-C7: the parent's begin met the Chronicle Index's stop (no IR
  // operation, no Graph): X11 (the IR outcome) and X12 (the join), as the
  // usual reading gives for these values; nothing after the parent exists.
  if (chronicleStopRecord(sample, context)) {
    add("parent", "X11", sample.irOutcome);
    add("parent", "X12", `graph-unavailable:${sample.graph.reason}`);
    // The mixing checks still apply (a parent that published more than once
    // or showed a late Graph, a re-query that did): E-5 like any other row.
    violations.push(...mixedIntoDisplay(sample.followUp));
    return finish(false);
  }
  const record = sample.followUp;
  const parent = record.parent;
  const child = record.child;

  // 批准 12 / N30: the parent's window is D, never W_f. K6/5 変える点 6 (the
  // per-sample check; K6/5-N2): under the /5 row a window other than D, or no
  // recorded window (null cannot be matched), is not a 批准 12 fallback to
  // K6/2 but a `[precheck]`: the /5 row is not judged (admission.mjs checks
  // the candidate's product D before the run). The match is exact (K6/5 変える点
  // 6: 「D と一致」): D is a fixed 40, not a measured value, so no boundary
  // tolerance applies to the window itself.
  if (
    parent.graphWindowMs === null ||
    !Number.isFinite(parent.graphWindowMs) ||
    parent.graphWindowMs !== GRAPH_EVAL_D_MS
  )
    throw new Error(
      `[precheck] K6/5 変える点 6: the parent's Graph window is ${String(parent.graphWindowMs)} ms, not D=${GRAPH_EVAL_D_MS} ms (a missing value cannot be matched); the /5 row is not judged`,
    );
  // :163 / N1: the parent's display never carries a late Graph, and the
  // parent's join publishes once.
  if (parent.lateGraphInDisplay)
    violations.push("N1:late-graph-in-parent-display");
  if (parent.publishCount > 1)
    violations.push("N1:parent-published-more-than-once");
  if (context === "steady") {
    const verdict = firstRenderOf(sample, join, options.next);
    firstRender = verdict.counted;
    firstRenderFails = verdict.fails;
  }
  if (firstRender) return finish(false);

  // records: R1 (4) / R4 (X10 :158). (b) では R1 と R2 を当てない (:109).
  // D-3: R1 is recomputed from its four items, never read from reachedQuiet.
  if (context === "steady") {
    const unmet = unmetR1(record.r1);
    if (record.r1.reachedQuiet !== true)
      add("records", "X10", "reached-quiet-false");
    else if (unmet.length > 0)
      add("records", "X10", `r1-self-report-disagrees:${unmet.join(",")}`);
  }

  // parent: F1 (:139), X11 (:159), X12 (:160), X1 (:149).
  if (sample.irOutcome !== "ir-ready")
    add("parent", "X11", sample.irOutcome ?? "missing");
  const outcome = sample.graph.outcome;
  if (outcome === "graph-unavailable")
    add("parent", "X12", `graph-unavailable:${sample.graph.reason}`);
  else if (outcome !== "graph-late")
    add(
      "parent",
      "F1",
      outcome === "graph-ready"
        ? firstRenderFails.length > 0
          ? `parent-joined:${firstRenderFails.join(",")}`
          : "parent-joined"
        : `outcome:${outcome}`,
    );
  else {
    if (parent.declaration !== "unused")
      add("parent", "F1", `declaration:${parent.declaration}`);
    const ticket = parent.ticket;
    if (ticket === null) add("parent", "X1", "no-ticket");
    else if (ticket.outcome !== "available") {
      if (ticket.busyCause === RETIRED_FRESHNESS_STAMP_BUSY)
        throw new Error(
          "[artifact] the product owner never answers Busy for a stamp read; record it as freshnessStamp.result unavailable",
        );
      add("parent", "X1", ticket.reason ?? ticket.outcome);
    } else if (!(ticket.settled && ticket.disposition === "unused"))
      add("parent", "X1", "not-cached");
  }

  // cache: X2 (:150).
  const cacheLoss = record.cacheLoss ?? [];
  if (cacheLoss.length > 0) add("cache", "X2", cacheLoss.join(","));

  // notice: F3 (:141), X3 (:151). The first notice decides; one at or
  // before t_pub_p is not the parent ticket's (「事実」:119).
  const graphReady = record.notices
    .filter((row) => row.kind === "graph-ready")
    .sort((left, right) => left.at - right.at);
  let tNotice = null;
  if (graphReady.length === 0) add("notice", "X3", "no-notice");
  else if (!(graphReady[0].at > parent.tPub))
    add("notice", "X3", "before-publish");
  else {
    tNotice = graphReady[0].at;
    q.q1 = tNotice - sample.tRawReady;
    if (q.q1 > K64_T_LATE_MS) add("notice", "X3", "late");
  }

  // child-begin: F2 (:140), F4 (:142), F5 (:143); X4 (:152), X7 (:155).
  const delta = Object.fromEntries(
    COUNTER_KEYS.map((key) => [
      key,
      record.counters.after[key] - record.counters.before[key],
    ]),
  );
  if (child === null) add("child-begin", "X6", "no-child");
  else {
    if (child.beginKind !== "cached")
      add("child-begin", "X4", "child-not-cached");
    if (child.origin !== "graph-ready")
      add("child-begin", "X7", `origin:${child.origin}`);
    if (child.refreshTrigger !== "graph-ready")
      add("child-begin", "X7", `trigger-mark:${child.refreshTrigger}`);
    if (child.generation !== parent.generation + 1)
      add("child-begin", "X7", "not-next-generation");
    if (child.sceneId !== parent.sceneId || child.seed !== parent.seed)
      add("child-begin", "X7", "scene-or-seed-differs");
    if (parent.irRetryTimer) add("child-begin", "X7", "ir-retry-timer");
    if (tNotice !== null && !(child.beginAt > tNotice))
      add("child-begin", "X7", "child-before-notice");
    if (
      record.notices.some(
        (row) =>
          row.kind === "index-ready" &&
          row.at >= sample.tFetch &&
          row.at <= child.beginAt,
      )
    )
      add("child-begin", "X7", "index-ready-between");
  }
  // レビュー P3: the Native begin records pair with the renderer's begins in
  // order only when the counts agree (k64-record.mjs); otherwise which
  // record is the child's is unknown (X4, F2's begin records do not hold).
  if (record.beginRecordsAligned === false)
    add("child-begin", "X4", "begin-records-unaligned");
  if (context === "steady") {
    if (
      !(delta.begins === 2 && delta.lateCached === 1 && delta.cacheHits === 1)
    )
      add(
        "child-begin",
        "X4",
        `counters:begins=${delta.begins},lateCached=${delta.lateCached},cacheHits=${delta.cacheHits}`,
      );
    // レビュー P3: K6/4:140 「sample の全体（R2 で cache を空にした後、R4 の
    // 終わりまで）」. R4 holds the release wait, so the counters read after it
    // must give the same exact deltas (the strict side; a begin or a late
    // cache entry during the wait is X4).
    if (counterBlock(record.countersAfterRelease)) {
      const after = Object.fromEntries(
        COUNTER_KEYS.map((key) => [
          key,
          record.countersAfterRelease[key] - record.counters.before[key],
        ]),
      );
      if (
        !(after.begins === 2 && after.lateCached === 1 && after.cacheHits === 1)
      )
        add(
          "child-begin",
          "X4",
          `counters-after-release:begins=${after.begins},lateCached=${after.lateCached},cacheHits=${after.cacheHits}`,
        );
    }
    if (!sameList(record.nativeBegins, ["pending", "cached"]))
      add(
        "child-begin",
        "X4",
        `begin-records:${record.nativeBegins.join(">")}`,
      );
    if (record.r2.cacheEmptyAtEnd !== true)
      add("child-begin", "X4", "cache-left-at-end");
  } else {
    if (
      !(
        record.nativeBegins.length === 2 &&
        record.nativeBegins[0] === "pending" &&
        record.nativeBegins[1] === "cached"
      )
    )
      add(
        "child-begin",
        "X4",
        `begin-records:${record.nativeBegins.join(">")}`,
      );
    if (delta.lateCached !== 1)
      add("child-begin", "X4", `late-cached:${delta.lateCached}`);
  }
  if (child === null) return finish(false);

  // child-join: F6 (:144); X5 (:153), X13 (:161); 批准 12 (N30).
  if (child.outcome === "graph-late") add("child-join", "X13", "graph-late");
  else if (child.outcome === "graph-unavailable")
    add("child-join", "X5", `join:${child.reason}`);
  else if (child.outcome !== "graph-ready")
    add("child-join", "X5", `join:${child.outcome}`);
  if (child.irOutcome !== "ir-ready")
    add("child-join", "X5", `ir:${child.irOutcome}`);
  if (
    child.chronicleIndexUsable === false &&
    child.irOutcome !== "index-unavailable"
  )
    add("child-join", "X5", "ir:index-unavailable");
  if (finite(child.tGraph) && finite(child.tRawReady))
    q.q2 = child.tGraph - child.tRawReady;
  if (child.outcome === "graph-ready") {
    if (q.q2 > K64_W_F_MS) {
      if (q.q2 <= K64_W_F_MS + BOUNDARY_TOLERANCE_MS)
        add("child-join", "X13", "joined-late-within-tolerance");
      else {
        violations.push("N29:child-joined-after-w-f");
        add("child-join", "X13", "joined-after-w-f");
      }
    }
    if (!(child.edgeCount >= 1) || child.expectedContribution !== true)
      add("child-join", "X5", "empty-contribution");
    if (child.requalification !== "passed")
      add("child-join", "X5", `requalification:${child.requalification}`);
  }
  if (child.lateGraphInDisplay)
    violations.push("N29:late-graph-in-child-display");
  if (child.refreshTrigger === "graph-ready") {
    if (child.graphWindowMs !== K64_W_F_MS) {
      ratification12.push("child-window-not-w-f");
      add("child-join", "F6", `window:${child.graphWindowMs}`);
    }
  } else if (child.graphWindowMs === K64_W_F_MS)
    ratification12.push("w-f-on-another-trigger");
  if (
    child.irOutcome === "ir-ready" &&
    finite(child.irArrivedAt) &&
    finite(child.tRawReady) &&
    child.irArrivedAt - child.tRawReady >
      GRAPH_EVAL_D_MS + BOUNDARY_TOLERANCE_MS
  )
    ratification12.push("child-ir-deadline-beyond-d");

  // child-publish: F7 (:145); X6 (:154); N32.
  if (child.completion !== "completed")
    add("child-publish", "X6", `completion:${child.completion}`);
  if (child.publishCount === 0) add("child-publish", "X6", "not-published");
  if (child.publishCount > 1)
    violations.push("N32:child-published-more-than-once");
  if (!child.currentAtDisplay) add("child-publish", "X6", "generation-changed");

  // display: F7 q3 ≤ T_show; X8 (:156).
  if (finite(child.tFollow)) {
    q.q3 = child.tFollow - sample.tRawReady;
    if (q.q3 > K64_T_SHOW_MS) add("display", "X8", "t-show-exceeded");
  }

  // quality: X9 (:157), compared only when the parent's IR is ready.
  if (
    sample.irOutcome === "ir-ready" &&
    (!sameList(child.rSceneIds, parent.rSceneIds) ||
      !sameList(child.irSceneIds, parent.irSceneIds))
  )
    add("quality", "X9", "r-or-ir-differs");

  return finish(stages.length === 0 && violations.length === 0, child);
}

function ticketReasonCategory(reason) {
  if (FRESHNESS_REASONS.has(reason)) return "freshness";
  if (LAPSE_TICKET_REASONS.has(reason)) return "lapse";
  if (SETUP_DEFECT_REASONS.has(reason)) return "setup-defect";
  // busy (its cause is not a stamp read; that cause is retired and throws),
  // timeout, limit, failed, cancelled, no ticket, not cached: :109 「ここに
  // 挙げていない X1 の理由は…「その他」」 / K6/2 720.
  return "other";
}

/** X5 details → K6/2 719-721 (変える点 15 「子の合流の理由は…同じ規則」). */
function childJoinCategory(detail) {
  const at = detail.indexOf(":");
  const kind = at < 0 ? detail : detail.slice(0, at);
  const value = at < 0 ? null : detail.slice(at + 1);
  if (kind === "join") return ticketReasonCategory(value);
  if (kind === "requalification")
    return value === "invalidated" ? "lapse" : "other";
  if (kind === "ir") return value === "index-unavailable" ? "lapse" : "other";
  // empty-contribution: no reason of 719-721 names it (720 「この規則に挙げて
  // いない理由」). Whether it counts in the lapse rate is the open question
  // FOLLOW_UP_LAPSE_QUESTIONS.
  return "other";
}

function codeCategory(row) {
  if (row.code === "X1") return ticketReasonCategory(row.detail);
  if (row.code === "X5") return childJoinCategory(row.detail);
  // X2〜X4, X6〜X13, F1, F6, and T_late / W_f / T_show overruns with the
  // parent ticket available (:109) are 「その他」.
  return "other";
}

/**
 * (b) category of one query that was not displayed (変える点 15, K6/4:109).
 * K6/2 rule 4 first (失効, the boundary disagreement, the setup defect; and,
 * when the caller computed it, a stamp without comparison is 「その他」,
 * DR-CP4-S1C1-8). The D′ structural graph-late itself is never a reason
 * (N33): the category is that of the stage where the follow-up failed, with
 * K6/2 rule 4's order inside the stage.
 */
export function followUpFailureCategory(sample, result, stampReason = null) {
  // A query whose B was not usable at its start is out of U whatever its
  // display (K6/2 rule 3 (i)); it is a lapse.
  const kind = lapseKind(sample, false);
  if (kind && kind !== "iv-empty-contribution")
    return { category: "lapse", reason: kind };
  if (result.displayed)
    throw new Error(
      "[artifact] a displayed query has no out-of-window category",
    );
  if (result.boundary === BOUNDARY_DISAGREEMENTS.joinedLateWithinTolerance)
    return { category: "other", reason: "boundary-disagreement:joined-late" };
  const parentReason =
    sample.graph.outcome === "graph-unavailable" ? sample.graph.reason : null;
  if (SETUP_DEFECT_REASONS.has(parentReason))
    return { category: "setup-defect", reason: parentReason };
  if (stampReason !== null) return { category: "other", reason: stampReason };
  const failed = result.failedStage;
  if (!failed)
    return { category: "other", reason: "follow-up:no-failed-stage" };
  const rows = failed.codes.map((row) => ({
    ...row,
    category: codeCategory(row),
  }));
  const setup = rows.find((row) => row.category === "setup-defect");
  if (setup) return { category: "setup-defect", reason: setup.detail };
  for (const name of CATEGORY_ORDER) {
    const row = rows.find((candidate) => candidate.category === name);
    if (row)
      return {
        category: name,
        reason: `follow-up:${failed.stage}:${row.code}:${row.detail}`,
      };
  }
  return { category: "other", reason: `follow-up:${failed.stage}` };
}

/** The lapse kind (K6/2 717) each follow-up lapse is counted as. */
const FOLLOW_UP_LAPSE_KINDS = Object.freeze({
  "parent-ticket-registration-unavailable": "i-b-seal",
  "parent-ticket-invalidated": "iii-invalidated",
  "child-join-registration-unavailable": "i-b-seal",
  "child-join-invalidated": "iii-invalidated",
  "child-requalification-invalidated": "iii-invalidated",
  "child-chronicle-stop": "i-chronicle-stop",
  "child-empty-contribution": "iv-empty-contribution",
});
const LAPSE_KIND_ORDER = Object.freeze([
  "i-b-seal",
  "i-chronicle-stop",
  "iii-invalidated",
  "iv-empty-contribution",
]);

/**
 * Follow-up failures on a lapse-like stage, counted as the parent query's
 * lapse (DR-CP4-K64-5 (A), integrator 2026-10-26): K6/4 is silent, and not
 * counting them (B) would loosen the lapse rate. Under D′ the parent's Graph
 * reaches the user only through the child, so the child's invalidated (iii),
 * empty contribution (iv), the parent ticket's / child's
 * registration-unavailable and the child's Chronicle stop (i) are the
 * query's lapse. Returns the questions and the one kind the query counts as
 * (first in K6/2 717's order), or `kind: null` when there is none.
 */
export function followUpLapses(result) {
  const out = [];
  for (const row of result.stages) {
    if (row.code === "X1" && LAPSE_TICKET_REASONS.has(row.detail))
      out.push(`parent-ticket-${row.detail}`);
    if (row.code === "X5") {
      if (row.detail === "empty-contribution")
        out.push("child-empty-contribution");
      else if (
        row.detail === "join:invalidated" ||
        row.detail === "join:registration-unavailable" ||
        row.detail === "requalification:invalidated"
      )
        out.push(`child-${row.detail.replace(":", "-")}`);
      else if (row.detail === "ir:index-unavailable")
        out.push("child-chronicle-stop");
    }
  }
  const questions = [...new Set(out)];
  const kinds = new Set(
    questions.map((question) => FOLLOW_UP_LAPSE_KINDS[question]),
  );
  const kind = LAPSE_KIND_ORDER.find((name) => kinds.has(name)) ?? null;
  return { questions, kind };
}

/**
 * 批准 5: whether the K6/4 relaxation may apply to the candidate. Evidence
 * (receipt `candidate.ratification5`): (a) `dPrime` {commit, ancestor}, (b)
 * `rsJoinHook` {evidence: "candidate-test", testFile, passed} or {evidence:
 * "ancestor", commit, ancestor}, (c) `wfWindow` {commit, ancestor}. Anything
 * missing or different is `k62` (N31: K6/2 の文のまま). (b-3) and 批准 12 are
 * checked on the records by the summaries.
 */
export function assessCandidateRegime(evidence, candidateHead) {
  const need = K64_CANDIDATE_REQUIREMENTS;
  const missing = [];
  if (!evidence || typeof evidence !== "object")
    return Object.freeze({
      regime: "k62",
      missing: ["ratification5-evidence"],
    });
  // D-1: only the evidence admission.mjs collected from git and sealed; a
  // receipt's record or a hand-written `ancestor: true` is self-reported.
  if (!isCollectedFacts(evidence) || evidence.kind !== "ratification5")
    return Object.freeze({
      regime: "k62",
      missing: ["ratification5-not-collected"],
    });
  // P2-2: test-sealed evidence counts only inside a node test run that
  // claimed the test sealer; anywhere else it is K6/2.
  if (evidence.testOnly === true && !isTestEvidenceAllowed())
    return Object.freeze({
      regime: "k62",
      missing: ["ratification5-test-only-outside-tests"],
    });
  // E-3: the evidence is the measured candidate's.
  if (typeof candidateHead !== "string")
    missing.push("ratification5-candidate-head-not-given");
  else if (evidence.candidateHead !== candidateHead)
    missing.push("ratification5-other-candidate");
  if (
    evidence.dPrime?.commit !== need.dPrimeCommit ||
    evidence.dPrime?.ancestor !== true
  )
    missing.push("a:d-prime");
  const hook = evidence.rsJoinHook;
  const hookOk =
    // E-1 / S1f: the candidate-test path is the keep test the collector ran
    // itself on the candidate's clean worktree (admission.mjs, keep-test.mjs):
    // the run's head is the candidate, the test file's digest and the run's
    // digest are recorded and at least one test passed. Test-sealed evidence
    // (`testOnly`) keeps its own path for the summaries' tests only;
    // validateCp4Receipt refuses it.
    (hook?.evidence === "candidate-test" &&
      hook.testFile === need.rsJoinKeepTest &&
      hook.passed === true &&
      (evidence.testOnly === true ||
        (hook.head === evidence.candidateHead &&
          SHA256_HEX.test(hook.testFileSha256 ?? "") &&
          SHA256_HEX.test(hook.runDigest ?? "") &&
          Number.isInteger(hook.tests) &&
          hook.tests > 0 &&
          // P2-4 (a): the run used the candidate's locked install.
          SHA256_HEX.test(hook.dependencies?.lockfileSha256 ?? "") &&
          hook.dependencies.installedLockSha256 ===
            hook.dependencies.lockfileSha256 &&
          typeof hook.dependencies.vitestVersion === "string" &&
          hook.dependencies.vitestVersion ===
            hook.dependencies.lockedVitestVersion))) ||
    (hook?.evidence === "ancestor" &&
      hook.commit === need.rsJoinHookCommit &&
      hook.ancestor === true);
  if (!hookOk) missing.push("b:rs-join-hook");
  if (
    evidence.wfWindow?.commit !== need.wfWindowCommit ||
    evidence.wfWindow?.ancestor !== true
  )
    missing.push("c:w-f-window");
  return Object.freeze({
    regime: missing.length === 0 ? "k64" : "k62",
    missing: Object.freeze(missing),
    ...(evidence.testOnly === true ? { testOnly: true } : {}),
  });
}

/**
 * The regime of a set of classified queries: the candidate's evidence, then
 * the records — any 批准 12 violation (N30) or a `graph-ready` refresh that
 * switched the list to loading ((b-3)) means K6/4 is not applied.
 */
export function recordRegime(candidate, results, candidateHead) {
  const assessed = assessCandidateRegime(candidate, candidateHead);
  const notApplied = [...assessed.missing];
  for (const result of results) {
    for (const issue of result.ratification12)
      notApplied.push(`ratification-12:${issue}`);
    if (result.loadingSwitched) notApplied.push("b-3:loading-on-graph-ready");
  }
  const unique = [...new Set(notApplied)];
  return { regime: unique.length === 0 ? "k64" : "k62", notApplied: unique };
}
