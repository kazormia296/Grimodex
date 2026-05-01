/**
 * Pure drag-end helpers for the Grid panel.
 * No React dependencies — easy to unit-test.
 */

export type DragKind = "scene" | "column";

export interface DropTarget {
  /** New parent for the dragged item */
  targetParentId: string | null;
  /** Insert after this id (null = prepend) */
  afterId: string | null;
}

/**
 * Parse the kind and raw id from a dnd-kit active/over id string.
 * Format: "scene-{id}", "column-{id}", "scene-drop-{id}", "column-slot-{id}",
 *         "column-end-{folderId}", "column-empty-{folderId}",
 *         "column-empty-loose"
 */
export function parseId(id: string): {
  kind: DragKind | "drop" | "slot" | "end" | "empty";
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
 * @param pointerY - Current pointer Y in viewport coordinates
 * @param overRect - Bounding rect of the over element
 * @param scenes - All scene infos in the target column (sorted by sortOrder)
 * @param containerId - The grid root container (used when dropping to loose)
 */
export function computeSceneDropTarget(
  activeSceneId: string,
  overId: string,
  pointerY: number,
  overRect: { top: number; height: number },
  sceneParentMap: Record<string, string | null>,
  containerId: string | null,
): DropTarget | null {
  if (!overId) return null;
  const { kind, rawId } = parseId(overId);

  // Dropped on a scene-drop zone: insert before or after based on pointer position
  if (kind === "drop") {
    const targetSceneId = rawId;
    if (targetSceneId === activeSceneId) return null;
    const targetParentId = sceneParentMap[targetSceneId] ?? null;
    const midY = overRect.top + overRect.height / 2;
    if (pointerY <= midY) {
      // Insert before target → afterId = predecessor of target
      return { targetParentId, afterId: null }; // simplified: caller resolves predecessor
    }
    return { targetParentId, afterId: targetSceneId };
  }

  // Dropped at the end of a column
  if (kind === "end") {
    return {
      targetParentId: rawId === "loose" ? containerId : rawId,
      afterId: null,
    };
  }

  // Dropped on empty column
  if (kind === "empty") {
    return {
      targetParentId: rawId === "loose" ? containerId : rawId,
      afterId: null,
    };
  }

  return null;
}

/**
 * Compute where to drop a column (folder reorder).
 *
 * @param activeFolderId - The folder being dragged
 * @param overId - The dnd-kit `over.id` string
 * @param folderParentMap - Maps folderId → parentId
 */
export function computeColumnDropTarget(
  activeFolderId: string,
  overId: string,
  folderParentMap: Record<string, string | null>,
): DropTarget | null {
  if (!overId) return null;
  const { kind, rawId } = parseId(overId);

  if (kind === "slot") {
    if (rawId === activeFolderId) return null;
    const targetParentId = folderParentMap[rawId] ?? null;
    return { targetParentId, afterId: rawId };
  }

  return null;
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
export function sceneDraggableId(sceneId: string) {
  return `scene-${sceneId}`;
}
export function columnDraggableId(folderId: string) {
  return `column-${folderId}`;
}
