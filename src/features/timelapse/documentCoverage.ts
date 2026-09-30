/**
 * Public document coverage/fence surface.
 *
 * The recorder owns the queue and its opaque capabilities. Keeping this
 * module as the feature boundary avoids callers reaching into recorder state
 * while allowing editor surfaces and body writers to share one contract.
 */
export {
  acquireTimelapseReplacementFence,
  breakTimelapseDocumentCapture,
  isTimelapseReplacementFenceActive,
  isTimelapseReplacementFenceActiveForDocument,
  subscribeTimelapseReplacementFence,
} from "./recorder";

export type {
  TimelapseAcceptedEnqueueReceipt,
  TimelapseCoverageProof,
  TimelapseDocStepCaptureReceipt,
  TimelapseDocStepCoverageClaim,
  TimelapseDocumentIdentity,
  TimelapseDocumentRef,
  TimelapseReplacementFence,
} from "./recorder";

import {
  breakTimelapseDocumentCapture,
  type TimelapseAcceptedEnqueueReceipt,
  type TimelapseDocumentIdentity,
  type TimelapseDocumentRef,
} from "./recorder";

/**
 * Mutable capture hand-off used by editor surfaces. A rejected, malformed, or
 * lifecycle-blocked capture marks the epoch broken instead of silently
 * retaining an older capability for a later body write.
 */
export interface TimelapseDocumentCaptureAccumulator {
  readonly identity: TimelapseDocumentIdentity;
  readonly document: TimelapseDocumentRef | undefined;
  readonly broken: boolean;
  accept: (receipt: TimelapseAcceptedEnqueueReceipt | null | undefined) => void;
  markBroken: () => void;
  reset: () => void;
}

export function createTimelapseDocumentCaptureAccumulator(
  identity: TimelapseDocumentIdentity,
): TimelapseDocumentCaptureAccumulator {
  let document: TimelapseDocumentRef | undefined;
  let broken = false;
  const markBroken = (): void => {
    broken = true;
    // Never leave a previously accepted capability usable after a rejected
    // capture. The capability covers only the old sealed prefix; once this
    // epoch is broken, body writers must fall back to a structural replacement
    // fence (or fail closed) instead of authorizing a stale snapshot.
    document = undefined;
    breakTimelapseDocumentCapture(identity);
  };
  return {
    identity,
    get document() {
      return document;
    },
    get broken() {
      return broken;
    },
    accept(receipt) {
      if (broken || !receipt?.document) {
        markBroken();
        return;
      }
      document = receipt.document;
    },
    markBroken,
    reset() {
      document = undefined;
      broken = false;
    },
  };
}
