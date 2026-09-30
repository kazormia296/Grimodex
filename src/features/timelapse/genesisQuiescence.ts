import {
  prepareQuiescenceLease,
  type QuiescenceLease,
  type QuiescenceLeaseReason,
} from "@/application/lifecycle/quiescenceLease";
import type { LifecycleTransitionInput } from "@/application/lifecycle/lifecycleTrace";
import { settleCurrentTimelapseGenesisBeforeQuiescence } from "./genesisBarrier";

/**
 * Canonical production lease entry. It blocks new renderer mutations first,
 * lets the current genesis read settle while Native reads remain open, then
 * atomically replaces that prelude with the requested lifecycle lease.
 */
export function acquireQuiescenceLeaseAfterTimelapseGenesis(
  reason: QuiescenceLeaseReason,
  options?: {
    transition?: LifecycleTransitionInput;
    signal?: AbortSignal;
  },
): Promise<QuiescenceLease> {
  const preparation = prepareQuiescenceLease(reason);
  return (async () => {
    try {
      if (options?.signal?.aborted) {
        throw new DOMException(
          `${reason} preparation was cancelled`,
          "AbortError",
        );
      }
      const settle = settleCurrentTimelapseGenesisBeforeQuiescence();
      if (options?.signal) {
        const { signal } = options;
        await new Promise<void>((resolve, reject) => {
          const abort = () => {
            reject(
              new DOMException(
                `${reason} preparation was cancelled`,
                "AbortError",
              ),
            );
          };
          signal.addEventListener("abort", abort, { once: true });
          void settle.then(resolve, reject).finally(() => {
            signal.removeEventListener("abort", abort);
          });
        });
      } else {
        await settle;
      }
      if (options?.signal?.aborted) {
        throw new DOMException(
          `${reason} preparation was cancelled`,
          "AbortError",
        );
      }
      return preparation.acquire(
        options?.transition ? { transition: options.transition } : undefined,
      );
    } catch (error) {
      preparation.cancel();
      throw error;
    }
  })();
}
