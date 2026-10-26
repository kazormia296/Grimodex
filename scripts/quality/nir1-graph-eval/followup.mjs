// CP-4 K6/4 follow-up availability: one recorded query becomes first-render
// (in the D window), follow-up (F1〜F7 all hold) or not displayed (X1〜X13),
// with the 「遅れた結果を混ぜない」 violations kept apart (FAIL) and the 批准 12
// violations of the candidate (N30) reported for the summary.
//
// Contract: draftRef `nir1-final-request-eval-proposal/4`, contractId
// `graph-eval-procedure`, SHA-256 d205b35f…23c3 (K64_FREEZE), confirmed
// 2026-10-26 (Session B5). Line numbers below are that file's:
//   F1〜F7 :137-145, X1〜X13 :147-161, FAIL :163, 表示の可用性 :165-167,
//   品質 :169-171, R1〜R7 :190-198, 変える点 15 :109, 批准 5 :32, 批准 12 :39.
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

import { isCollectedFacts } from "./admission-facts.mjs";
import {
  BOUNDARY_TOLERANCE_MS,
  GRAPH_EVAL_D_MS,
  K64_CANDIDATE_REQUIREMENTS,
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
  steadyStateInWindow,
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
 * The R7 items a query lacks (K6/4:198; X10 :158). `null` means "did not
 * happen" and is allowed where the event is optional; an absent key or a
 * wrong type is missing. R1 / R2 are required in the steady state only
 * (変える点 15: (b) では R1 と R2 を当てず).
 */
export function missingR7(sample, context) {
  const record = sample?.followUp;
  if (!record || typeof record !== "object") return ["followUp"];
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
      DPRIME_COUNTER_KEYS.every((key) =>
        Number.isInteger(record.dPrimeCounters[key]),
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
  return out;
}

/**
 * One query → its K6/4 classification. `context` is "steady" (定常状態: the
 * first render counts worker results only, K6/2 step 3; R1, R2 and the F2
 * sample counters apply) or "trace" ((b): the first render is K6/2 rule 2,
 * R1/R2 do not apply, F2 is read between the parent's and the child's begin).
 */
export function classifyFollowUp(sample, options) {
  rejectOverrides(options ?? {}, ["context"]);
  const context = options?.context;
  if (!FOLLOW_UP_CONTEXTS.includes(context))
    throw new Error(
      "[precheck] classifyFollowUp needs context steady or trace",
    );
  assertNoRetiredBusy(sample);
  const join = classifyJoin(sample);
  // (b): K6/2 rule 2 read through K6/4:165 — a parent that joined as
  // `Cached` within D is not displayed (D-5, the strict reading).
  const firstRender =
    context === "steady"
      ? steadyStateInWindow(sample)
      : join.inWindow &&
        sample.graph?.source === "worker" &&
        sample.snapshot?.usable === true;
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
  const record = sample.followUp;
  const parent = record.parent;
  const child = record.child;

  // 批准 12 / N30: the parent's window is D, never W_f.
  if (
    parent.graphWindowMs !== null &&
    Math.abs(parent.graphWindowMs - GRAPH_EVAL_D_MS) > BOUNDARY_TOLERANCE_MS
  )
    ratification12.push("parent-window-not-d");
  // :163 / N1: the parent's display never carries a late Graph, and the
  // parent's join publishes once.
  if (parent.lateGraphInDisplay)
    violations.push("N1:late-graph-in-parent-display");
  if (parent.publishCount > 1)
    violations.push("N1:parent-published-more-than-once");
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
      outcome === "graph-ready" ? "parent-joined" : `outcome:${outcome}`,
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
  if (context === "steady") {
    if (
      !(delta.begins === 2 && delta.lateCached === 1 && delta.cacheHits === 1)
    )
      add(
        "child-begin",
        "X4",
        `counters:begins=${delta.begins},lateCached=${delta.lateCached},cacheHits=${delta.cacheHits}`,
      );
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
          hook.tests > 0))) ||
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
