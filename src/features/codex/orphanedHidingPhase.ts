import {
  listOrphanedHidingPhases,
  type OrphanedHidingPhase,
} from "@/../electron/shared/readDomain/features/codex/context/codexAiVisibility";
import { isCodexContextModeHiddenFromAi } from "@/../electron/shared/readDomain/features/codex/context/codexVisibilityPolicy";
import type { SceneTimeIndex } from "./context/sceneTimeIndex";
import type { CodexEntryPhase } from "./phaseApi";

export type { OrphanedHidingPhase };

export interface OrphanedHidingPhaseDisplay {
  /**
   * False while the scene order cannot be resolved (the index is empty: the tree
   * is not loaded yet, or the project has no scene). Nothing is claimed then: the
   * state is temporary, and every Phase would look orphaned.
   */
  readonly sceneResolvable: boolean;
  /** Every orphaned hiding Phase of the entry (`listOrphanedHidingPhases`). */
  readonly orphaned: readonly OrphanedHidingPhase[];
  /**
   * The Phases the warning names. Empty unless the scene order is resolvable and
   * the entry is not already hidden from the AI at base: then the Phase is not the
   * reason, and "a Phase hides it" would mislead.
   */
  readonly warned: readonly OrphanedHidingPhase[];
}

/**
 * What the Codex screens say about a hiding Phase that lost its anchor scene
 * (DR-MP4-46, Q-G3). Derived only from `listOrphanedHidingPhases`, the same
 * function that closes the entry for the AI, so a screen and the exclusion cannot
 * drift apart. Renderer-local: nothing is sent anywhere.
 */
export function getOrphanedHidingPhaseDisplay(input: {
  readonly entryContextMode: string;
  readonly phases: readonly Pick<
    CodexEntryPhase,
    "id" | "label" | "anchorNodeId" | "contextModeOverride"
  >[];
  readonly index: SceneTimeIndex;
}): OrphanedHidingPhaseDisplay {
  const orphaned = listOrphanedHidingPhases(input.phases, input.index);
  const sceneResolvable = input.index.readingOrder.size > 0;
  const baseAlreadyHidden = isCodexContextModeHiddenFromAi(
    input.entryContextMode,
  );
  return {
    sceneResolvable,
    orphaned,
    warned: sceneResolvable && !baseAlreadyHidden ? orphaned : [],
  };
}
