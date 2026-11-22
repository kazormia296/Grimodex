// CP-4 Graph window primitives shared by the K6/2 summaries
// (availability.mjs) and the K6/4 follow-up classifier (followup.mjs):
// K6/2 `graph-eval-procedure` steps 3 and 5, "(b) の判定の規則" 3.
//
// Pure module. Only renderer `performance.now()` ms enter the window; D and
// the boundary tolerance come from constants.mjs.

import { BOUNDARY_TOLERANCE_MS, GRAPH_EVAL_D_MS } from "./constants.mjs";

export const USER_OPERATION = "user-operation";
export const SETUP_DEFECT_REASONS = new Set([
  "not-requested",
  "not-activated",
  "profile-not-restricted",
]);
export const FRESHNESS_REASONS = new Set(["stale", "warming"]);
export const BOUNDARY_DISAGREEMENTS = Object.freeze({
  notJoinedInTime: "not-joined-in-time",
  joinedLateWithinTolerance: "joined-late-within-tolerance",
});

export function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Join classification of one sample (K6/2 step 5 and the integrator's
 * boundary decision). In window = the product joined the result AND its
 * arrival is at or before `t_raw_ready + D`. Two disagreements are kept:
 * not joined although in time (a plain window-out, disclosed), and joined
 * although late within the 10 µs tolerance (conservatively window-out,
 * disclosed). Joined and later than the tolerance stops with `[precheck]`
 * as a suspected product N-7 violation. An arrival before the query was
 * issued (`t_fetch`) cannot be this query's answer and stops as an artifact.
 */
export function classifyJoin(sample, ...extra) {
  if (extra.length > 0)
    throw new Error(
      "[precheck] classifyJoin takes only the sample (D is frozen)",
    );
  if (!finite(sample?.tFetch) || !finite(sample?.tRawReady))
    throw new Error("[artifact] sample lacks t_fetch / t_raw_ready");
  if (!finite(sample.tReturn))
    throw new Error("[artifact] sample lacks t_return");
  if (
    !(sample.tFetch <= sample.tRawReady && sample.tRawReady <= sample.tReturn)
  )
    throw new Error("[artifact] sample timestamps are not monotonic");
  const graph = sample.graph;
  if (!graph || typeof graph.joined !== "boolean")
    throw new Error("[artifact] sample lacks the Graph join record");
  if (finite(graph.arrivedAt) && graph.arrivedAt < sample.tFetch)
    throw new Error(
      "[artifact] the Graph arrival precedes t_fetch; it is not this query's answer",
    );
  const deadline = sample.tRawReady + GRAPH_EVAL_D_MS;
  if (!graph.joined) {
    const inTime = finite(graph.arrivedAt) && graph.arrivedAt <= deadline;
    return {
      joined: false,
      inWindow: false,
      disagreement: inTime ? BOUNDARY_DISAGREEMENTS.notJoinedInTime : null,
    };
  }
  if (graph.revalidation !== "passed")
    throw new Error(
      "[artifact] a Graph result that did not pass return-time revalidation was joined",
    );
  if (!finite(graph.arrivedAt))
    throw new Error("[artifact] joined Graph result lacks its arrival time");
  if (graph.arrivedAt <= deadline)
    return { joined: true, inWindow: true, disagreement: null };
  if (graph.arrivedAt <= deadline + BOUNDARY_TOLERANCE_MS)
    return {
      joined: true,
      inWindow: false,
      disagreement: BOUNDARY_DISAGREEMENTS.joinedLateWithinTolerance,
    };
  throw new Error(
    "[precheck] the product joined a Graph result later than t_raw_ready + D beyond the boundary tolerance (suspected N-7)",
  );
}

export function joinedWithinWindow(sample) {
  return classifyJoin(sample).inWindow;
}

/**
 * K6/2's literal reading of "in the window" for a steady-state first render
 * (K6/2 step 3): only a worker result of this query's ticket, started on a new
 * READY. K6/7 (変える点 4、緩和 R-12) drops the freshness-stamp clause: the
 * stamp no longer exists (DR-DBC-7), and under R1 the set does not move
 * because `startSlot.readyFresh === true` is still required. Under K6/4's R1
 * this is structurally false (D′ never publishes READY), so K6/6 (変える点
 * 3、H1) no longer uses it to decide a first render: followup.mjs
 * `firstRenderOf` is the function. This one stays for the disclosure of
 * the K6/2 reading (変える点 5: `notReadyAtStart`) and for the K6/2-era
 * (candidate-less) summaries.
 */
export function k62SteadyStateInWindow(sample) {
  return (
    classifyJoin(sample).inWindow &&
    sample.graph.source === "worker" &&
    sample.startSlot?.readyFresh === true
  );
}

/**
 * The single lapse kind of one counted query (rule 3; each query counted
 * once, in the order (i) B seal, (i) Chronicle stop, (ii), (iii), (iv)).
 */
export function lapseKind(query, inWindow) {
  if (
    query.snapshot.usable !== true ||
    query.graph.reason === "registration-unavailable"
  )
    return "i-b-seal";
  if (query.irOutcome === "index-unavailable") return "i-chronicle-stop";
  if (query.a3AtStart.eligible !== true) return "ii-a3-ineligible-at-start";
  if (
    query.graph.revalidation === "invalidated" ||
    query.graph.reason === "invalidated"
  )
    return "iii-invalidated";
  if (inWindow && query.graph.edgeCount === 0) return "iv-empty-contribution";
  return null;
}
