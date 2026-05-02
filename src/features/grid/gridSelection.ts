/**
 * Pure functions for computing Grid selection state.
 * Kept separate for testability; integrated into gridStore actions.
 */

export function toggleSceneSelection(
  selectedIds: Set<string>,
  id: string,
): Set<string> {
  const next = new Set(selectedIds);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** Select all scenes between anchorId and targetId (inclusive) in flatOrder. */
export function rangeSelectScenes(
  flatOrder: string[],
  anchorId: string,
  targetId: string,
): Set<string> {
  const anchorIdx = flatOrder.indexOf(anchorId);
  const targetIdx = flatOrder.indexOf(targetId);
  if (anchorIdx === -1 || targetIdx === -1) return new Set([targetId]);
  const start = Math.min(anchorIdx, targetIdx);
  const end = Math.max(anchorIdx, targetIdx);
  return new Set(flatOrder.slice(start, end + 1));
}
