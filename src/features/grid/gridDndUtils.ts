/**
 * Pure drag-end helpers for the Grid panel.
 * No React dependencies — easy to unit-test.
 */

export type DragKind = "scene" | "column";

export interface DropIndicator {
  /** The scene card whose padding should open up */
  targetId: string;
  /** Open gap above or below the target card */
  position: "before" | "after";
}

export interface ColumnDropIndicator {
  /** The chapter column whose padding should open up, or the folder card to nest into */
  targetId: string;
  /**
   * "before" / "after" — open gap to the left/right of the target column for sibling reorder.
   * "nest" — drop INTO the target (becomes a child of targetId).
   */
  position: "before" | "after" | "nest";
}

/**
 * Compute which card should show a drop-indicator gap during drag-over.
 * Only handles scene-drop zones (between cards); column-level zones don't
 * produce a per-card indicator.
 */
export function computeSceneDropIndicator(
  activeSceneId: string,
  overId: string,
  pointerY: number,
  overRect: { top: number; height: number },
): DropIndicator | null {
  if (!overId) return null;
  const { kind, rawId } = parseId(overId);
  if (kind !== "drop") return null;
  const targetSceneId = rawId;
  if (targetSceneId === activeSceneId) return null;
  const midY = overRect.top + overRect.height / 2;
  return {
    targetId: targetSceneId,
    position: pointerY <= midY ? "before" : "after",
  };
}

export interface DropTarget {
  /** New parent for the dragged item */
  targetParentId: string | null;
  /**
   * Insert after this sibling id.
   * null      = prepend (before first child)
   * undefined = append  (after last child)
   * string    = insert after that sibling
   */
  afterId: string | null | undefined;
}

/**
 * Parse the kind and raw id from a dnd-kit active/over id string.
 * Format: "scene-{id}", "column-{id}", "scene-drop-{id}", "column-slot-{id}",
 *         "column-end-{folderId}", "column-empty-{folderId}",
 *         "column-nest-{folderId}", "column-empty-loose"
 */
export function parseId(id: string): {
  kind: DragKind | "drop" | "slot" | "end" | "empty" | "nest";
  rawId: string;
} {
  if (id.startsWith("scene-drop-"))
    return { kind: "drop", rawId: id.slice("scene-drop-".length) };
  if (id.startsWith("column-slot-"))
    return { kind: "slot", rawId: id.slice("column-slot-".length) };
  if (id.startsWith("column-end-"))
    return { kind: "end", rawId: id.slice("column-end-".length) };
  if (id.startsWith("column-empty-"))
    return { kind: "empty", rawId: id.slice("column-empty-".length) };
  if (id.startsWith("column-nest-"))
    return { kind: "nest", rawId: id.slice("column-nest-".length) };
  if (id.startsWith("scene-"))
    return { kind: "scene", rawId: id.slice("scene-".length) };
  if (id.startsWith("column-"))
    return { kind: "column", rawId: id.slice("column-".length) };
  return { kind: "scene", rawId: id };
}

/**
 * Compute where to drop a scene card.
 *
 * @param activeSceneId - The scene being dragged
 * @param overId - The dnd-kit `over.id` string
 * @param pointerY - Current pointer Y in viewport coordinates (e.g. from pointermove clientY)
 * @param overRect - Bounding rect of the over element
 * @param orderedScenes - All scenes sorted by sortOrder (used to resolve predecessors)
 * @param containerId - The grid root container (used when dropping to loose)
 */
export function computeSceneDropTarget(
  activeSceneId: string,
  overId: string,
  pointerY: number,
  overRect: { top: number; height: number },
  orderedScenes: Array<{ id: string; parentId: string | null }>,
  containerId: string | null,
): DropTarget | null {
  if (!overId) return null;
  const { kind, rawId } = parseId(overId);

  // Dropped on a scene-drop zone: insert before or after based on pointer position
  if (kind === "drop") {
    const targetSceneId = rawId;
    if (targetSceneId === activeSceneId) return null;
    const targetScene = orderedScenes.find((s) => s.id === targetSceneId);
    const targetParentId = targetScene?.parentId ?? null;
    const midY = overRect.top + overRect.height / 2;
    if (pointerY <= midY) {
      // Insert before target: find predecessor in the same parent (excluding active)
      const siblings = orderedScenes.filter(
        (s) => s.parentId === targetParentId && s.id !== activeSceneId,
      );
      const targetIdx = siblings.findIndex((s) => s.id === targetSceneId);
      const predecessor =
        targetIdx > 0 ? (siblings[targetIdx - 1]?.id ?? null) : null;
      return { targetParentId, afterId: predecessor };
    }
    return { targetParentId, afterId: targetSceneId };
  }

  // Dropped on column-slot: the full-column droppable wins collision detection
  // over scene-drop zones when hovering a non-empty column — treat as append.
  if (kind === "slot") {
    return { targetParentId: rawId, afterId: undefined };
  }

  // Dropped at the end of a column → append after last sibling
  if (kind === "end") {
    return {
      targetParentId: rawId === "loose" ? containerId : rawId,
      afterId: undefined,
    };
  }

  // Dropped on empty column → first (and only) child
  if (kind === "empty") {
    return {
      targetParentId: rawId === "loose" ? containerId : rawId,
      afterId: null,
    };
  }

  return null;
}

/**
 * Resolve any over.id (slot / drop / end / empty) to the enclosing chapter column.
 * Used during column drag-over so the indicator still appears when the cursor
 * lands on a scene card or end zone inside a target column.
 *
 * @returns folder id of the enclosing column, or null if not resolvable
 */
export function resolveEnclosingFolderId(
  overId: string,
  sceneParentMap: Record<string, string | null>,
): string | null {
  if (!overId) return null;
  const { kind, rawId } = parseId(overId);
  if (kind === "slot" || kind === "end" || kind === "empty") {
    return rawId === "loose" ? null : rawId;
  }
  if (kind === "drop") {
    return sceneParentMap[rawId] ?? null;
  }
  return null;
}

/**
 * Returns true when `candidateId` is `ancestorId` itself or a descendant of it.
 * Walks parent links via `folderParentMap`. Visited-set guards against existing cycles.
 */
function isSelfOrDescendant(
  candidateId: string | null,
  ancestorId: string,
  folderParentMap: Record<string, string | null>,
): boolean {
  let cur: string | null = candidateId;
  const visited = new Set<string>();
  while (cur && !visited.has(cur)) {
    if (cur === ancestorId) return true;
    visited.add(cur);
    cur = folderParentMap[cur] ?? null;
  }
  return false;
}

/**
 * Determine if moving `activeFolderId` to be `position` of `targetId` would be a no-op
 * (target is adjacent to active in the same parent).
 */
function isAdjacentColumnNoOp(
  activeFolderId: string,
  targetId: string,
  position: "before" | "after",
  folderParentMap: Record<string, string | null>,
  orderedFolders: Array<{ id: string; parentId: string | null }>,
): boolean {
  const activeParentId = folderParentMap[activeFolderId] ?? null;
  const targetParentId = folderParentMap[targetId] ?? null;
  if (targetParentId !== activeParentId) return false;
  const siblings = orderedFolders
    .filter((f) => f.parentId === activeParentId)
    .map((f) => f.id);
  const activeIdx = siblings.indexOf(activeFolderId);
  const targetIdx = siblings.indexOf(targetId);
  if (activeIdx < 0 || targetIdx < 0) return false;
  // "before target" with target == active+1 → A would land back in its own slot
  if (position === "before" && targetIdx === activeIdx + 1) return true;
  // "after target" with target == active-1 → ditto
  if (position === "after" && targetIdx === activeIdx - 1) return true;
  return false;
}

/**
 * Resolve the meaningful drop position for a column drag using a 3-zone scheme:
 *   left 30% → "before", right 30% → "after", center 40% → "nest".
 *
 * For "before"/"after", flip to the opposite side when the cursor lands on
 * the half that would put the column back where it is (existing behavior).
 * For "nest", returns null when active is already a direct child of target.
 */
function resolveColumnDropPosition(
  activeFolderId: string,
  targetId: string,
  pointerX: number,
  overRect: { left: number; width: number },
  folderParentMap: Record<string, string | null>,
  orderedFolders: Array<{ id: string; parentId: string | null }>,
): "before" | "after" | "nest" | null {
  const leftZone = overRect.left + overRect.width * 0.3;
  const rightZone = overRect.left + overRect.width * 0.7;

  let initial: "before" | "after" | "nest";
  if (pointerX < leftZone) initial = "before";
  else if (pointerX > rightZone) initial = "after";
  else initial = "nest";

  if (initial === "nest") {
    // No-op when active is already a direct child of target
    if ((folderParentMap[activeFolderId] ?? null) === targetId) return null;
    return "nest";
  }

  if (
    !isAdjacentColumnNoOp(
      activeFolderId,
      targetId,
      initial,
      folderParentMap,
      orderedFolders,
    )
  ) {
    return initial;
  }
  // Initial side is no-op → try the opposite side.
  const flipped: "before" | "after" = initial === "before" ? "after" : "before";
  if (
    isAdjacentColumnNoOp(
      activeFolderId,
      targetId,
      flipped,
      folderParentMap,
      orderedFolders,
    )
  ) {
    return null;
  }
  return flipped;
}

/**
 * Compute which column should show the left/right/nest drop-indicator during a column drag.
 * Returns null when the move would be a no-op.
 *
 * @param containerId - The current Grid container; rejects drops onto its own loose area.
 */
export function computeColumnDropIndicator(
  activeFolderId: string,
  overId: string,
  pointerX: number,
  overRect: { left: number; width: number },
  sceneParentMap: Record<string, string | null>,
  folderParentMap: Record<string, string | null>,
  orderedFolders: Array<{ id: string; parentId: string | null }>,
  containerId: string | null,
): ColumnDropIndicator | null {
  if (!overId) return null;
  const { kind, rawId } = parseId(overId);

  // Explicit nest droppable (e.g. nested folder card)
  if (kind === "nest") {
    if (rawId === activeFolderId) return null;
    if (isSelfOrDescendant(rawId, activeFolderId, folderParentMap)) return null;
    if ((folderParentMap[activeFolderId] ?? null) === rawId) return null;
    return { targetId: rawId, position: "nest" };
  }

  const targetId = resolveEnclosingFolderId(overId, sceneParentMap);
  if (!targetId) return null;
  if (targetId === activeFolderId) return null;
  // Conservative: dropping onto loose scenes (children of containerId) shouldn't
  // bubble up and move the column out of containerId.
  if (targetId === containerId) return null;
  // Cycle prevention: target must not be a descendant of active.
  if (isSelfOrDescendant(targetId, activeFolderId, folderParentMap))
    return null;
  const position = resolveColumnDropPosition(
    activeFolderId,
    targetId,
    pointerX,
    overRect,
    folderParentMap,
    orderedFolders,
  );
  if (!position) return null;
  return { targetId, position };
}

/**
 * Compute where to drop a column (folder reorder or nest).
 *
 * @param activeFolderId - The folder being dragged
 * @param overId - The dnd-kit `over.id` string
 * @param pointerX - Current pointer X (viewport coords)
 * @param overRect - Bounding rect of the over element
 * @param folderParentMap - Maps folderId → parentId
 * @param orderedFolders - All folder nodes sorted by sortOrder (resolves predecessor for "before")
 * @param sceneParentMap - Maps sceneId → parentId (for resolving enclosing column)
 * @param containerId - The current Grid container; rejects drops onto its own loose area.
 */
export function computeColumnDropTarget(
  activeFolderId: string,
  overId: string,
  pointerX: number,
  overRect: { left: number; width: number },
  folderParentMap: Record<string, string | null>,
  orderedFolders: Array<{ id: string; parentId: string | null }>,
  sceneParentMap: Record<string, string | null>,
  containerId: string | null,
): DropTarget | null {
  if (!overId) return null;
  const { kind, rawId } = parseId(overId);

  // Explicit nest droppable (e.g. nested folder card) — append into target.
  if (kind === "nest") {
    if (rawId === activeFolderId) return null;
    if (isSelfOrDescendant(rawId, activeFolderId, folderParentMap)) return null;
    if ((folderParentMap[activeFolderId] ?? null) === rawId) return null;
    return { targetParentId: rawId, afterId: undefined };
  }

  const targetId = resolveEnclosingFolderId(overId, sceneParentMap);
  if (!targetId) return null;
  if (targetId === activeFolderId) return null;
  // Conservative: dropping a Part onto loose scenes (children of containerId)
  // shouldn't bubble up and move the Part out of containerId.
  if (targetId === containerId) return null;
  // Cycle prevention: target must not be a descendant of active.
  if (isSelfOrDescendant(targetId, activeFolderId, folderParentMap))
    return null;
  const position = resolveColumnDropPosition(
    activeFolderId,
    targetId,
    pointerX,
    overRect,
    folderParentMap,
    orderedFolders,
  );
  if (!position) return null;
  if (position === "nest") {
    return { targetParentId: targetId, afterId: undefined };
  }
  const targetParentId = folderParentMap[targetId] ?? null;
  if (position === "before") {
    // Insert before target: predecessor is target's prev sibling in same parent (excluding active)
    const siblings = orderedFolders.filter(
      (f) => f.parentId === targetParentId && f.id !== activeFolderId,
    );
    const idx = siblings.findIndex((f) => f.id === targetId);
    const predecessor = idx > 0 ? (siblings[idx - 1]?.id ?? null) : null;
    return { targetParentId, afterId: predecessor };
  }
  return { targetParentId, afterId: targetId };
}

export function activeDragKind(activeId: string): DragKind | null {
  if (activeId.startsWith("scene-")) return "scene";
  if (activeId.startsWith("column-")) return "column";
  return null;
}

export function sceneDroppableId(sceneId: string) {
  return `scene-drop-${sceneId}`;
}
export function columnSlotId(folderId: string) {
  return `column-slot-${folderId}`;
}
export function columnEndId(folderId: string | "loose") {
  return `column-end-${folderId}`;
}
export function columnEmptyId(folderId: string | "loose") {
  return `column-empty-${folderId}`;
}
export function columnNestId(folderId: string) {
  return `column-nest-${folderId}`;
}
export function sceneDraggableId(sceneId: string) {
  return `scene-${sceneId}`;
}
export function columnDraggableId(folderId: string) {
  return `column-${folderId}`;
}
