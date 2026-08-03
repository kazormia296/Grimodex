export interface LinearVirtualRange {
  startIndex: number;
  endIndex: number;
  overscan: number;
  count: number;
}

/**
 * Default visible+overscan range plus editor rows that must stay mounted
 * (active neighbours and dirty/conflicted drafts).
 */
export function extractLinearVirtualIndexes(
  range: LinearVirtualRange,
  pinnedIndexes: ReadonlySet<number>,
): number[] {
  const start = Math.max(0, range.startIndex - range.overscan);
  const end = Math.min(range.count - 1, range.endIndex + range.overscan);
  const indexes = new Set<number>();
  for (let index = start; index <= end; index += 1) indexes.add(index);
  for (const index of pinnedIndexes) {
    if (index >= 0 && index < range.count) indexes.add(index);
  }
  return [...indexes].sort((a, b) => a - b);
}

export function buildLinearPinnedIndexes(
  sceneIds: readonly string[],
  activeSceneId: string | null,
  dirtySceneIds: ReadonlySet<string>,
  conflictedSceneIds: ReadonlySet<string>,
  activeRadius = 2,
): ReadonlySet<number> {
  const indexById = new Map(sceneIds.map((id, index) => [id, index]));
  const indexes = new Set<number>();
  const activeIndex =
    activeSceneId === null ? undefined : indexById.get(activeSceneId);
  if (activeIndex !== undefined) {
    for (
      let index = activeIndex - activeRadius;
      index <= activeIndex + activeRadius;
      index += 1
    ) {
      if (index >= 0 && index < sceneIds.length) indexes.add(index);
    }
  }
  for (const id of dirtySceneIds) {
    const index = indexById.get(id);
    if (index !== undefined) indexes.add(index);
  }
  for (const id of conflictedSceneIds) {
    const index = indexById.get(id);
    if (index !== undefined) indexes.add(index);
  }
  return indexes;
}
