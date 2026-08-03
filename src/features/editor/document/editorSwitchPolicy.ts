import type { GroupIndex } from "@/features/editor/tabStore";

interface PreSwitchFlushFailureInput {
  loadStarted: boolean;
  previousId: string;
  currentId: string;
  groupIndex: GroupIndex;
  restorePrimary: (id: string) => void;
  restoreSecondary: (id: string) => void;
  /** Restore a same-id projection (for example, a Codex Phase tab). */
  restoreDocumentProjection?: () => void;
}

/**
 * Decide whether a switch failure happened before the old binding was
 * invalidated. The caller can then restore the previous tab without calling
 * mutationGate.failLoad().
 */
export function handlePreSwitchFlushFailure(
  input: PreSwitchFlushFailureInput,
): boolean {
  if (input.loadStarted) return false;
  if (input.previousId !== input.currentId) {
    if (input.groupIndex === 0) input.restorePrimary(input.previousId);
    else input.restoreSecondary(input.previousId);
  }
  input.restoreDocumentProjection?.();
  return true;
}
