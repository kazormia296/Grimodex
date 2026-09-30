import { createNir1RelatedScenesDeadline } from "./nir1RelatedScenesDeadline";
import type { Nir1InitialUsabilitySnapshot } from "./nir1RelatedScenesDeadline";
import type { Nir1RelatedScenesFetchResult } from "./nir1RelatedScenesFetchTypes";
import { fuseNir1RelatedScenes } from "./nir1RelatedScenesFusion";
import type { Nir1RelatedScenesIr } from "./nir1RelatedScenesResult";
import type { Nir1RelatedScenesSession } from "./nir1RelatedScenesSession";
import type { RelatedSceneSelection } from "./selectRelatedScenes";
import { RELATED_SCENES_IR_EXTRA_WAIT_MS } from "./relatedScenesConfig";

type Completion = Pick<
  Nir1RelatedScenesFetchResult,
  "result" | "completion" | "status"
>;

/** One final safe result; delayed timers and late IR share the same deadline. */
export function awaitNir1RelatedScenes(input: {
  raw: RelatedSceneSelection;
  rawReadyAtMs: number;
  snapshot: Nir1InitialUsabilitySnapshot;
  ir: Promise<Nir1RelatedScenesIr>;
  session: Nir1RelatedScenesSession;
  isCurrent: () => boolean;
}): Promise<Completion> {
  const deadline = createNir1RelatedScenesDeadline({
    rawReadyAtMs: input.rawReadyAtMs,
    additionalWaitMs: RELATED_SCENES_IR_EXTRA_WAIT_MS,
    snapshot: input.snapshot,
  });
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let unobserve = () => {};
    const cleanup = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      unobserve();
    };

    function finish(ir: Nir1RelatedScenesIr, timedOut = false): void {
      if (deadline.completion) return;
      // Construct the safe result before the final time/authority checks. The
      // transport arrival time alone does not bound admission/projection/fusion.
      let result = fuseNir1RelatedScenes(input.raw, ir);
      const cancelled =
        !input.isCurrent() || input.session.stopReason === "cancelled";
      const invalidated =
        !cancelled &&
        (!input.session.isActive() ||
          (ir.status === "unavailable" && ir.reason === "invalidated"));
      const now = performance.now();
      const completion =
        cancelled || invalidated
          ? deadline.stop(cancelled ? "cancelled" : "invalidated", now)
          : timedOut
            ? deadline.expire(now)
            : ir.status === "available"
              ? deadline.completeIr(now)
              : deadline.stop(
                  ir.reason === "failed" ? "failed" : "ir-unavailable",
                  now,
                );
      if (!completion) return;
      if (cancelled || invalidated) {
        result = fuseNir1RelatedScenes(input.raw, {
          status: "unavailable",
          reason:
            completion.outcome === "cancelled" ? "cancelled" : "invalidated",
        });
      } else if (completion.deadlineExceeded) {
        result = fuseNir1RelatedScenes(input.raw, {
          status: "unavailable",
          reason: "timeout",
        });
      }
      cleanup();
      resolve({
        result,
        completion,
        status: cancelled
          ? "cancelled"
          : invalidated
            ? "invalidated"
            : "completed",
      });
    }

    function arm(): void {
      if (deadline.completion) return;
      timer = setTimeout(
        () => {
          timer = null;
          if (performance.now() < deadline.deadlineAtMs) {
            arm();
            return;
          }
          finish({ status: "unavailable", reason: "timeout" }, true);
        },
        Math.max(1, deadline.remainingMs(performance.now())),
      );
    }

    unobserve = input.session.subscribeInvalidation(() => {
      finish({ status: "unavailable", reason: "invalidated" });
    });
    arm();
    void input.ir.then(
      (ir) => finish(ir),
      () => finish({ status: "unavailable", reason: "failed" }),
    );
  });
}
