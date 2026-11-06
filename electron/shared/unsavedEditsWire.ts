/**
 * Wire of the unsaved-edits guard (PUB-G required precondition #36,
 * DR-PUBG-36-1 in `docs/plans/nir1-lane-decisions/cp3b-decisions.md`).
 *
 * The renderer owns the unsaved text (the AutoSave closures); Main has no
 * queue of its own. The renderer therefore reports one boolean per window
 * whenever it changes, and Main reads it only when a fatal shutdown failure
 * is about to call `exit(1)`. Nothing here carries text, a path or an id, and
 * Main never writes the text anywhere.
 */

/** Main-processed command: the window's "has unsaved edits" flag. */
export const REPORT_UNSAVED_EDITS_COMMAND = "report_unsaved_edits";

/**
 * Main event sent to a window whose owner chose "go back" in the fatal-exit
 * confirmation: the renderer shows a sticky "copy your text out" notice.
 */
export const UNSAVED_EDITS_RETAINED_EVENT = "app:unsaved-edits-retained";

export interface UnsavedEditsReport {
  readonly hasUnsaved: boolean;
}

/** Exact `{ hasUnsaved: boolean }`; anything else is rejected. */
export function parseUnsavedEditsReport(
  value: unknown,
): UnsavedEditsReport | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== "hasUnsaved") return null;
  const hasUnsaved = (value as { hasUnsaved?: unknown }).hasUnsaved;
  return typeof hasUnsaved === "boolean" ? { hasUnsaved } : null;
}
