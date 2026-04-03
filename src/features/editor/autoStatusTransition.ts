import type { SceneStatus } from "@/features/tree/treeStore";

/**
 * Returns true if an empty scene with "outline" status should be
 * automatically promoted to "draft" when the user types the first character.
 */
export function shouldAutoDraftTransition(
  charCount: number,
  wasEmpty: boolean,
  status: SceneStatus | null,
): boolean {
  return wasEmpty && charCount > 0 && status === "outline";
}
