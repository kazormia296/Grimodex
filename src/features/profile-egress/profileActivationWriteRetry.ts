import { useEffect, useRef } from "react";
import { toast } from "sonner";
import i18next from "@/lib/i18n";
import { debugLog } from "@/lib/debugLog";
// Imported for its chunk, not its exports (DR-DA2B-R8). The coordinator and
// the lease below live in startup chunks shared with `projectStore`. A lazy
// chunk that reaches only some modules of a startup chunk splits them out of
// it (a new chunk, its preload link and rewritten imports in every importer:
// +916 raw for `quiescenceProviders` alone). Reaching the chunk's root
// reaches all of them, and the startup graph stays byte for byte the same.
import "@/features/project/projectStore";
import { flushStrictQuiescence } from "@/application/lifecycle/quiescenceCoordinator";
import { canScheduleQuiescenceMutation } from "@/application/lifecycle/quiescenceLease";
import type { ProfileEgressStatusSnapshot } from "./useProfileEgressStatus";

/**
 * The waits before each attempt, in ms (DR-DA2B-R8). Four attempts in about
 * 22.5 s. Main sends `restricted` at stage 6 and a caller registers again on
 * its next invoke (stage 7), so the first attempt normally succeeds; the later
 * ones cover a slow stage 7 and a write that is still settling.
 */
export const ACTIVATION_WRITE_RETRY_DELAYS_MS: readonly number[] = [
  500, 2_000, 5_000, 15_000,
];

export interface ActivationWriteRetryDependencies {
  /** Writes every pending draft and queue; rejects while any write fails. */
  readonly flush: () => Promise<void>;
  /** False while a lifecycle lease owns the flush (and its failure dialog). */
  readonly canFlush: () => boolean;
  readonly wait: (ms: number) => Promise<void>;
  /** The user-visible failure after the last attempt. */
  readonly notifyFailure: () => void;
}

const defaultDependencies: ActivationWriteRetryDependencies = {
  flush: () => flushStrictQuiescence(),
  canFlush: () => canScheduleQuiescenceMutation(),
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  notifyFailure: () => {
    toast.error(i18next.t("profileEgress.writeRetry.failed"));
  },
};

/**
 * W-1 (K3/2): from stage 4 to stage 7 of the activation the generic DB writes
 * are refused (no caller is registered). The drafts keep the refused edits
 * (a sticky stays dirty, a Map write stays queued as failed, autosave keeps
 * its pending body); this writes them once the activation has completed.
 *
 * A bounded number of attempts of the strict flush that the lifecycle uses
 * before a close or a switch. A failed attempt changes nothing (each surface
 * keeps its draft, as on any failed save) and the next one tries again. After
 * the last failure it stops and shows a toast; the drafts stay for the next
 * save and for the strict flush of a close, whose failure opens its dialog.
 * An attempt during a lifecycle lease is skipped: that lifecycle flushes the
 * same drafts and reports its own failure.
 *
 * Resolves `true` once a flush succeeded, `false` when it gave up.
 */
export async function retryWritesAfterActivation(
  dependencies: ActivationWriteRetryDependencies = defaultDependencies,
): Promise<boolean> {
  let failed = false;
  for (const delay of ACTIVATION_WRITE_RETRY_DELAYS_MS) {
    await dependencies.wait(delay);
    if (!dependencies.canFlush()) continue;
    try {
      await dependencies.flush();
      return true;
    } catch {
      failed = true;
    }
  }
  if (failed) {
    // A fixed message only: the failures may carry SQL and parameters.
    debugLog.warn("profile-egress", "writes after activation still failing");
    dependencies.notifyFailure();
  }
  return false;
}

let started = false;

/**
 * Starts the retry once per renderer process: the state only moves forward
 * and there is no second activation in a process.
 */
export function startWritesRetryAfterActivation(
  dependencies?: ActivationWriteRetryDependencies,
): Promise<boolean> | null {
  if (started) return null;
  started = true;
  return retryWritesAfterActivation(dependencies);
}

/**
 * Starts the retry when this renderer sees the activation complete: a known
 * `restricted` after a known `unrestricted` or `activating`. A process that
 * starts restricted (or a window opened afterwards) had no refused write, so
 * it does not retry. `unavailable` is not a completion.
 *
 * Import only from a lazy chunk behind `PROFILE_ACTIVATION_UI_ENABLED`.
 */
export function useWritesRetryAfterActivation(
  snapshot: ProfileEgressStatusSnapshot,
): void {
  const sawBefore = useRef(false);
  const state = snapshot.kind === "known" ? snapshot.view.state : null;
  useEffect(() => {
    if (state === "unrestricted" || state === "activating") {
      sawBefore.current = true;
    } else if (state === "restricted" && sawBefore.current) {
      void startWritesRetryAfterActivation();
    }
  }, [state]);
}

export function _resetWritesRetryAfterActivationForTests(): void {
  started = false;
}
