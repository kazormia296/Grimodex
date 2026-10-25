import { createNir1RelatedScenesDeadline } from "./nir1RelatedScenesDeadline";
import type {
  Nir1InitialUsabilitySnapshot,
  Nir1RelatedScenesCompletion,
} from "./nir1RelatedScenesDeadline";
import { fuseNir1RelatedScenes } from "./nir1RelatedScenesFusion";
import type {
  Nir1RelatedScenesIr,
  Nir1RelatedScenesResult,
} from "./nir1RelatedScenesResult";
import type { Nir1RelatedScenesSession } from "./nir1RelatedScenesSession";
import type { RelatedSceneSelection } from "./selectRelatedScenes";
import { RELATED_SCENES_IR_EXTRA_WAIT_MS } from "./relatedScenesConfig";

/** The closed Native Graph reasons (CP-1 allowlist, DSN §1.5). */
export const NIR1_GRAPH_UNAVAILABLE_REASONS = [
  "not-requested",
  "not-activated",
  "profile-not-restricted",
  "warming",
  "stale",
  "busy",
  "limit",
  "timeout",
  "registration-unavailable",
  "invalidated",
  "cancelled",
  "restart-required",
  "worker-unavailable",
  "failed",
] as const;

export type Nir1GraphUnavailableReason =
  (typeof NIR1_GRAPH_UNAVAILABLE_REASONS)[number];

export type Nir1GraphArrival<G> =
  | { readonly status: "available"; readonly graph: G }
  | { readonly status: "unavailable"; readonly reason: string };

export type Nir1GraphJoinOutcome =
  | "graph-ready"
  | "graph-late"
  | `graph-unavailable:${Nir1GraphUnavailableReason | "ir-not-ready"}`;

export type Nir1GraphTicketUse = "used" | "unused" | "cancelled";

export interface Nir1GraphJoinResult<G> {
  readonly status: "completed" | "cancelled" | "invalidated";
  /** R or R+IR fusion only; the Graph fusion belongs to CP-3b. */
  readonly result: Nir1RelatedScenesResult;
  /** The IR outcome, decided at the IR arrival time. */
  readonly completion: Nir1RelatedScenesCompletion;
  readonly graphOutcome: Nir1GraphJoinOutcome;
  /** Set only for graph-ready. */
  readonly graph: G | null;
  readonly publishedAtMs: number;
  /** 合流に使った Graph の成分の窓（Raw-ready からの ms）。評価でだけ読む。 */
  readonly graphWindowMs: number;
}

type NormalizedGraphArrival<G> =
  | { readonly status: "available"; readonly graph: G }
  | {
      readonly status: "unavailable";
      readonly reason: Nir1GraphUnavailableReason;
    };

function normalizeGraphReason(reason: string): Nir1GraphUnavailableReason {
  return (NIR1_GRAPH_UNAVAILABLE_REASONS as readonly string[]).includes(reason)
    ? (reason as Nir1GraphUnavailableReason)
    : "failed";
}

/**
 * Joins the exact R/IR result with one Native Graph ticket. The IR deadline is
 * always Raw-ready + D. The Graph window is Raw-ready + `graphWindowMs`: D by
 * default, W_f only for a `graph-ready` refresh (K6/4 批准 12、DR-WF-2). Neither
 * is extended: a Graph that arrives after its window is not mixed in and is
 * reported as graph-late. The join publishes, and the ticket is settled,
 * exactly once; a ready IR does not publish before the Graph or its window.
 */
export function awaitNir1RelatedScenesWithGraph<G>(input: {
  raw: RelatedSceneSelection;
  rawReadyAtMs: number;
  snapshot: Nir1InitialUsabilitySnapshot;
  ir: Promise<Nir1RelatedScenesIr>;
  graph: Promise<Nir1GraphArrival<G>>;
  session: Pick<
    Nir1RelatedScenesSession,
    "stopReason" | "isActive" | "subscribeInvalidation"
  >;
  isCurrent: () => boolean;
  /** fetchNir1RelatedScenesGraph connects this to the Native ticket finish. */
  onGraphSettled: (use: Nir1GraphTicketUse) => void;
  /**
   * Graph の成分の窓（Raw-ready からの ms）。省略時は D。D より短い窓や有限でない
   * 値は受け付けない（IR の deadline は常に D）。
   */
  graphWindowMs?: number;
}): Promise<Nir1GraphJoinResult<G>> {
  const graphWindowMs = input.graphWindowMs ?? RELATED_SCENES_IR_EXTRA_WAIT_MS;
  if (
    !Number.isFinite(graphWindowMs) ||
    graphWindowMs < RELATED_SCENES_IR_EXTRA_WAIT_MS
  )
    throw new Error("Invalid NIR1 Graph window");
  const deadline = createNir1RelatedScenesDeadline({
    rawReadyAtMs: input.rawReadyAtMs,
    additionalWaitMs: RELATED_SCENES_IR_EXTRA_WAIT_MS,
    snapshot: input.snapshot,
  });
  const graphDeadlineAtMs = input.rawReadyAtMs + graphWindowMs;
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let unobserve = () => {};
    let published = false;
    let irArrived: Nir1RelatedScenesIr | null = null;
    let invalidatedSeen = false;
    let graphArrival: NormalizedGraphArrival<G> | null = null;

    const cleanup = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      unobserve();
    };

    const isCancelled = () =>
      !input.isCurrent() || input.session.stopReason === "cancelled";

    function publish(nowMs: number): void {
      if (published) return;
      published = true;
      cleanup();
      const completion = deadline.completion ?? deadline.stop("failed", nowMs);
      if (!completion) throw new Error("NIR1 joined completion is missing");
      const irForInvalidation = irArrived;
      const cancelled = isCancelled();
      const invalidated =
        !cancelled &&
        (invalidatedSeen ||
          !input.session.isActive() ||
          (irForInvalidation?.status === "unavailable" &&
            irForInvalidation.reason === "invalidated"));
      const ir: Nir1RelatedScenesIr = irArrived ?? {
        status: "unavailable",
        reason: "timeout",
      };
      const result: Nir1RelatedScenesResult = cancelled
        ? fuseNir1RelatedScenes(input.raw, {
            status: "unavailable",
            reason: "cancelled",
          })
        : invalidated
          ? fuseNir1RelatedScenes(input.raw, {
              status: "unavailable",
              reason: "invalidated",
            })
          : completion.deadlineExceeded
            ? fuseNir1RelatedScenes(input.raw, {
                status: "unavailable",
                reason: "timeout",
              })
            : fuseNir1RelatedScenes(input.raw, ir);
      const stopped =
        cancelled ||
        invalidated ||
        completion.outcome === "cancelled" ||
        completion.outcome === "invalidated" ||
        completion.outcome === "ir-unavailable" ||
        completion.outcome === "failed";

      let graphOutcome: Nir1GraphJoinOutcome;
      let use: Nir1GraphTicketUse;
      let graph: G | null = null;
      if (stopped) {
        graphOutcome = "graph-unavailable:cancelled";
        use = "cancelled";
      } else if (completion.outcome === "ir-ready") {
        if (graphArrival === null) {
          graphOutcome = "graph-late";
          use = "unused";
        } else if (graphArrival.status === "available") {
          graphOutcome = "graph-ready";
          graph = graphArrival.graph;
          use = "used";
        } else {
          graphOutcome = `graph-unavailable:${graphArrival.reason}`;
          use = "used";
        }
      } else {
        // Graph is used only with a ready IR; a timed-out IR keeps exact R.
        graphOutcome =
          graphArrival === null
            ? "graph-late"
            : "graph-unavailable:ir-not-ready";
        use = "unused";
      }

      const outcome: Nir1GraphJoinResult<G> = {
        status: cancelled
          ? "cancelled"
          : invalidated
            ? "invalidated"
            : "completed",
        result,
        completion,
        graphOutcome,
        graph,
        publishedAtMs: nowMs,
        graphWindowMs,
      };
      // The caller always gets its result. A declaration that throws is
      // dropped here: rethrowing would only surface as an unhandled rejection
      // of the arrival handler, and the ticket's TTL bounds a lost declaration.
      try {
        input.onGraphSettled(use);
      } catch {
        // Intentionally ignored (see above).
      }
      resolve(outcome);
    }

    // timer の的：IR が未着なら IR の deadline（D）、IR が ready なら Graph の窓の
    // 終わり。IR が ready でない合流は onIr で公開済みなので、ここに来ない。
    const timerTargetAtMs = () =>
      irArrived === null ? deadline.deadlineAtMs : graphDeadlineAtMs;

    function arm(): void {
      if (published) return;
      timer = setTimeout(
        () => {
          timer = null;
          if (published) return;
          const now = performance.now();
          if (now < timerTargetAtMs()) {
            arm();
            return;
          }
          // An IR that is still pending at the deadline is an IR timeout.
          if (irArrived === null) deadline.expire(now);
          publish(now);
        },
        Math.max(1, timerTargetAtMs() - performance.now()),
      );
    }

    function onIr(ir: Nir1RelatedScenesIr): void {
      if (published) return;
      irArrived = ir;
      const now = performance.now();
      // An inactive session (released or stopped) settles as invalidated at once.
      if (
        isCancelled() ||
        !input.session.isActive() ||
        (ir.status === "unavailable" && ir.reason === "invalidated")
      ) {
        deadline.stop(isCancelled() ? "cancelled" : "invalidated", now);
        publish(now);
        return;
      }
      if (ir.status !== "available") {
        deadline.stop(
          ir.reason === "failed" ? "failed" : "ir-unavailable",
          now,
        );
        publish(now);
        return;
      }
      const completion = deadline.completeIr(now);
      if (completion?.outcome === "timeout" || graphArrival !== null) {
        publish(now);
      }
    }

    function onGraph(arrival: Nir1GraphArrival<G>): void {
      if (published) return;
      const now = performance.now();
      // A Graph arriving at or after its window is never mixed in.
      if (now >= graphDeadlineAtMs) return;
      graphArrival =
        arrival.status === "available"
          ? { status: "available", graph: arrival.graph }
          : {
              status: "unavailable",
              reason: normalizeGraphReason(arrival.reason),
            };
      if (deadline.completion !== null) publish(now);
    }

    unobserve = input.session.subscribeInvalidation(() => {
      if (published) return;
      invalidatedSeen = true;
      const now = performance.now();
      // A cancelled session keeps its reason; other stops are invalidations.
      deadline.stop(isCancelled() ? "cancelled" : "invalidated", now);
      publish(now);
    });
    arm();
    void input.ir.then(onIr, () =>
      onIr({ status: "unavailable", reason: "failed" }),
    );
    void input.graph.then(onGraph, () =>
      onGraph({ status: "unavailable", reason: "failed" }),
    );
  });
}
