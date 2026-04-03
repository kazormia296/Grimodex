import type { SceneStatus } from "@/features/tree/treeStore";

const SYNOPSIS_TRIGGER_STATUSES: SceneStatus[] = [
  "complete",
  "revision",
  "final",
];

/**
 * Returns true when the user should be prompted to add a synopsis:
 * - Status just changed (prevStatus !== newStatus)
 * - New status is one that implies the scene is "done enough"
 * - Synopsis is currently empty
 * - This is not an initial load (prevStatus must be non-null)
 */
export function shouldPromptSynopsis(
  prevStatus: SceneStatus | null,
  newStatus: SceneStatus | null,
  synopsis: string | null | undefined,
): boolean {
  if (!prevStatus || !newStatus) return false;
  if (prevStatus === newStatus) return false;
  if (!SYNOPSIS_TRIGGER_STATUSES.includes(newStatus)) return false;
  return !synopsis;
}
