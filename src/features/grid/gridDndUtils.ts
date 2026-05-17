/**
 * Pure drag-end helpers for the Grid panel.
 * No React dependencies — easy to unit-test.
 */

import { glog } from "./gridDndLog";

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
  const result: DropIndicator = {
    targetId: targetSceneId,
    position: pointerY <= midY ? "before" : "after",
  };
  glog("computeSceneDropIndicator", "result", {
    activeSceneId,
    overId,
    result,
  });
  return result;
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
  glog("computeSceneDropTarget", "input", {
    activeSceneId,
    overId,
    pointerY,
    overRect,
    containerId,
    sceneCount: orderedScenes.length,
  });
  if (!overId) {
    glog("computeSceneDropTarget", "early-return: empty overId");
    return null;
  }
  const { kind, rawId } = parseId(overId);
  glog("computeSceneDropTarget", "parsed", { kind, rawId });

  // Dropped on a scene-drop zone: insert before or after based on pointer position
  if (kind === "drop") {
    const targetSceneId = rawId;
    if (targetSceneId === activeSceneId) {
      glog("computeSceneDropTarget", "early-return: drop on self");
      return null;
    }
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
      const result = { targetParentId, afterId: predecessor };
      glog("computeSceneDropTarget", "branch: drop/before", result);
      return result;
    }
    const result = { targetParentId, afterId: targetSceneId };
    glog("computeSceneDropTarget", "branch: drop/after", result);
    return result;
  }

  // Dropped on column-slot: the full-column droppable wins collision detection
  // over scene-drop zones when hovering a non-empty column — treat as append.
  if (kind === "slot") {
    const result = { targetParentId: rawId, afterId: undefined };
    glog("computeSceneDropTarget", "branch: slot (append)", result);
    return result;
  }

  // Dropped on a nested folder card → append the scene into that folder.
  // Without this, the folder card's `isNestOver` highlight fires during a
  // scene drag but nothing happens on release — a confusing false positive.
  // Note: scene drag stays at nest-only here. Y-axis 3-zone for folder cards
  // applies to COLUMN drag (computeColumnDropTarget), which is what the user
  // asked to match the Scenes panel behavior for folder-into-folder DnD.
  if (kind === "nest") {
    const result = { targetParentId: rawId, afterId: undefined };
    glog("computeSceneDropTarget", "branch: nest (append into folder)", result);
    return result;
  }

  // Dropped at the end of a column → append after last sibling
  if (kind === "end") {
    const result = {
      targetParentId: rawId === "loose" ? containerId : rawId,
      afterId: undefined,
    };
    glog("computeSceneDropTarget", "branch: end (append)", result);
    return result;
  }

  // Dropped on empty column → first (and only) child
  if (kind === "empty") {
    const result = {
      targetParentId: rawId === "loose" ? containerId : rawId,
      afterId: null,
    };
    glog("computeSceneDropTarget", "branch: empty (first child)", result);
    return result;
  }

  glog("computeSceneDropTarget", "fallthrough: no match for kind", { kind });
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
 * Resolve a folder-row drop into Scenes-panel-style 3-zone Y-axis bands:
 *   top 25%    → "before"  (sibling of target, in target's parent)
 *   middle 50% → "inside"  (nest into target)
 *   bottom 25% → "after"   (sibling of target, in target's parent)
 *
 * Used by the `column-nest` droppable (folder card rendered inside a column).
 * Mirrors the positioning UX of `useScenesDnd` so dragging onto a folder
 * behaves the same way in both panels.
 */
function resolveFolderNestZone(
  pointerY: number,
  overRect: { top: number; height: number },
): "before" | "inside" | "after" {
  const topZone = overRect.top + overRect.height * 0.25;
  const bottomZone = overRect.top + overRect.height * 0.75;
  if (pointerY < topZone) return "before";
  if (pointerY > bottomZone) return "after";
  return "inside";
}

/**
 * Determine if moving `activeFolderId` to be `position` of `targetId` would be a no-op
 * (target is adjacent to active in the same parent). `targetId` may be a folder OR
 * a scene id — target's parent is looked up from `orderedSiblings` (which contains
 * both kinds) rather than `folderParentMap` (folder-only).
 */
function isAdjacentColumnNoOp(
  activeFolderId: string,
  targetId: string,
  position: "before" | "after",
  folderParentMap: Record<string, string | null>,
  orderedSiblings: Array<{ id: string; parentId: string | null }>,
): boolean {
  const activeParentId = folderParentMap[activeFolderId] ?? null;
  const targetEntry = orderedSiblings.find((s) => s.id === targetId);
  const targetParentId = targetEntry?.parentId ?? null;
  if (targetParentId !== activeParentId) return false;
  const siblings = orderedSiblings
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
 *   left 40% → "before", right 40% → "after", center 20% → "nest".
 *
 * No-op detection: when the position would put the column back where it
 * already sits (target is the immediately-adjacent sibling on that side),
 * return null instead of silently flipping to the other side. Returning null
 * gives the user an honest "this drop does nothing" feedback (no indicator,
 * no move). To swap with an adjacent neighbor, the user aims for the FAR
 * side of that neighbor (e.g. swap with right-neighbor B → drop on B's right
 * 40%, which yields "after B").
 */
function resolveColumnDropPosition(
  activeFolderId: string,
  targetId: string,
  pointerX: number,
  overRect: { left: number; width: number },
  folderParentMap: Record<string, string | null>,
  orderedSiblings: Array<{ id: string; parentId: string | null }>,
): "before" | "after" | "nest" | null {
  const leftZone = overRect.left + overRect.width * 0.4;
  const rightZone = overRect.left + overRect.width * 0.6;

  let initial: "before" | "after" | "nest";
  if (pointerX < leftZone) initial = "before";
  else if (pointerX > rightZone) initial = "after";
  else initial = "nest";

  if (initial === "nest") {
    // No-op when active is already a direct child of target
    if ((folderParentMap[activeFolderId] ?? null) === targetId) return null;
    return "nest";
  }

  // No-op when target is the adjacent sibling on the same side as the position
  // (the drop would land active back in its current slot). Return null instead
  // of flipping — silent flips have produced surprising results where dropping
  // on the LEFT of right-neighbor moved active to the RIGHT of that neighbor.
  if (
    isAdjacentColumnNoOp(
      activeFolderId,
      targetId,
      initial,
      folderParentMap,
      orderedSiblings,
    )
  ) {
    return null;
  }
  return initial;
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
  pointerY: number,
  overRect: { left: number; width: number; top: number; height: number },
  sceneParentMap: Record<string, string | null>,
  folderParentMap: Record<string, string | null>,
  orderedSiblings: Array<{ id: string; parentId: string | null }>,
  containerId: string | null,
): ColumnDropIndicator | null {
  if (!overId) return null;
  const { kind, rawId } = parseId(overId);

  // Folder card (nested folder rendered inside a column) → Scenes-panel-style
  // 3-zone Y-axis: top 25% before, middle 50% inside, bottom 25% after. This
  // lets the user specify the insertion position when nesting a folder into
  // another folder; before/after make the dragged folder a sibling of the
  // target in the target's parent.
  if (kind === "nest") {
    if (rawId === activeFolderId) {
      glog("computeColumnDropIndicator", "nest reject: target == active");
      return null;
    }
    if (isSelfOrDescendant(rawId, activeFolderId, folderParentMap)) {
      glog(
        "computeColumnDropIndicator",
        "nest reject: target is descendant of active",
      );
      return null;
    }
    const zone = resolveFolderNestZone(pointerY, overRect);
    if (zone === "inside") {
      if ((folderParentMap[activeFolderId] ?? null) === rawId) {
        glog(
          "computeColumnDropIndicator",
          "nest reject: active already child of target",
        );
        return null;
      }
      const result: ColumnDropIndicator = {
        targetId: rawId,
        position: "nest",
      };
      glog("computeColumnDropIndicator", "result: nest inside", result);
      return result;
    }
    if (
      isAdjacentColumnNoOp(
        activeFolderId,
        rawId,
        zone,
        folderParentMap,
        orderedSiblings,
      )
    ) {
      glog("computeColumnDropIndicator", "nest reject: adjacent no-op", {
        zone,
        rawId,
      });
      return null;
    }
    const result: ColumnDropIndicator = { targetId: rawId, position: zone };
    glog("computeColumnDropIndicator", `result: nest ${zone}`, result);
    return result;
  }

  // Empty-folder drop zone — nest-only. Geometric ambiguity prevents a clean
  // Y-axis 3-zone here (the empty area is a large rect spanning most of the
  // column body), and column-slot already provides X-axis before/after for
  // top-level columns.
  if (kind === "empty" && rawId !== "loose") {
    if (rawId === activeFolderId) {
      glog("computeColumnDropIndicator", "empty reject: target == active");
      return null;
    }
    if (isSelfOrDescendant(rawId, activeFolderId, folderParentMap)) {
      glog(
        "computeColumnDropIndicator",
        "empty reject: target is descendant of active",
      );
      return null;
    }
    if ((folderParentMap[activeFolderId] ?? null) === rawId) {
      glog(
        "computeColumnDropIndicator",
        "empty reject: active already child of target",
      );
      return null;
    }
    const result: ColumnDropIndicator = { targetId: rawId, position: "nest" };
    glog("computeColumnDropIndicator", "result: empty nest", result);
    return result;
  }

  // Scene drop zone (scene card inside a column) → Y-axis 2-zone: column
  // becomes a sibling of the scene in the scene's parent. The indicator
  // targets the SCENE so the scene card itself can render the top/bottom bar.
  // Previously this branch routed through the enclosing folder + X-axis 3-zone
  // which gave column-level positioning, but column-slot already covers that
  // and the per-scene Y feedback matches Scenes-panel ergonomics.
  if (kind === "drop") {
    const sceneId = rawId;
    const targetParentId = sceneParentMap[sceneId] ?? null;
    if (targetParentId === activeFolderId) {
      glog(
        "computeColumnDropIndicator",
        "drop reject: scene's parent == active",
      );
      return null;
    }
    if (
      targetParentId !== null &&
      isSelfOrDescendant(targetParentId, activeFolderId, folderParentMap)
    ) {
      glog(
        "computeColumnDropIndicator",
        "drop reject: scene's parent is descendant of active",
      );
      return null;
    }
    const midY = overRect.top + overRect.height / 2;
    const zone: "before" | "after" = pointerY <= midY ? "before" : "after";
    if (
      isAdjacentColumnNoOp(
        activeFolderId,
        sceneId,
        zone,
        folderParentMap,
        orderedSiblings,
      )
    ) {
      glog("computeColumnDropIndicator", "drop reject: adjacent no-op", {
        zone,
        sceneId,
      });
      return null;
    }
    const result: ColumnDropIndicator = { targetId: sceneId, position: zone };
    glog("computeColumnDropIndicator", `result: drop ${zone}`, result);
    return result;
  }

  const targetId = resolveEnclosingFolderId(overId, sceneParentMap);
  if (!targetId) {
    glog("computeColumnDropIndicator", "no enclosing folder", { overId, kind });
    return null;
  }
  if (targetId === activeFolderId) {
    glog("computeColumnDropIndicator", "reject: target == active");
    return null;
  }
  // Conservative: dropping onto loose scenes (children of containerId) shouldn't
  // bubble up and move the column out of containerId.
  if (targetId === containerId) {
    glog("computeColumnDropIndicator", "reject: target == containerId");
    return null;
  }
  // Cycle prevention: target must not be a descendant of active.
  if (isSelfOrDescendant(targetId, activeFolderId, folderParentMap)) {
    glog(
      "computeColumnDropIndicator",
      "reject: target is descendant of active",
    );
    return null;
  }
  const position = resolveColumnDropPosition(
    activeFolderId,
    targetId,
    pointerX,
    overRect,
    folderParentMap,
    orderedSiblings,
  );
  if (!position) {
    glog("computeColumnDropIndicator", "no-op position (adjacent or same)");
    return null;
  }
  const result: ColumnDropIndicator = { targetId, position };
  glog("computeColumnDropIndicator", "result", result);
  return result;
}

/**
 * Compute where to drop a column (folder reorder or nest).
 *
 * @param activeFolderId - The folder being dragged
 * @param overId - The dnd-kit `over.id` string
 * @param pointerX - Current pointer X (viewport coords)
 * @param pointerY - Current pointer Y (viewport coords) — used by the Y-axis
 *                   3-zone scheme on folder-card nest targets
 * @param overRect - Bounding rect of the over element
 * @param folderParentMap - Maps folderId → parentId
 * @param orderedSiblings - All folder nodes sorted by sortOrder (resolves predecessor for "before")
 * @param sceneParentMap - Maps sceneId → parentId (for resolving enclosing column)
 * @param containerId - The current Grid container; rejects drops onto its own loose area.
 */
export function computeColumnDropTarget(
  activeFolderId: string,
  overId: string,
  pointerX: number,
  pointerY: number,
  overRect: { left: number; width: number; top: number; height: number },
  folderParentMap: Record<string, string | null>,
  orderedSiblings: Array<{ id: string; parentId: string | null }>,
  sceneParentMap: Record<string, string | null>,
  containerId: string | null,
): DropTarget | null {
  glog("computeColumnDropTarget", "input", {
    activeFolderId,
    overId,
    pointerX,
    pointerY,
    overRect,
    containerId,
  });
  if (!overId) {
    glog("computeColumnDropTarget", "early-return: empty overId");
    return null;
  }
  const { kind, rawId } = parseId(overId);
  glog("computeColumnDropTarget", "parsed", { kind, rawId });

  // Folder card (nested folder rendered inside a column) → Scenes-panel-style
  // 3-zone Y-axis: top 25% before, middle 50% inside, bottom 25% after.
  if (kind === "nest") {
    if (rawId === activeFolderId) {
      glog("computeColumnDropTarget", "nest reject: target == active");
      return null;
    }
    if (isSelfOrDescendant(rawId, activeFolderId, folderParentMap)) {
      glog(
        "computeColumnDropTarget",
        "nest reject: target is descendant of active",
      );
      return null;
    }
    const zone = resolveFolderNestZone(pointerY, overRect);
    if (zone === "inside") {
      if ((folderParentMap[activeFolderId] ?? null) === rawId) {
        glog(
          "computeColumnDropTarget",
          "nest reject: active already child of target",
        );
        return null;
      }
      const result = { targetParentId: rawId, afterId: undefined };
      glog("computeColumnDropTarget", "branch: nest inside", result);
      return result;
    }
    if (
      isAdjacentColumnNoOp(
        activeFolderId,
        rawId,
        zone,
        folderParentMap,
        orderedSiblings,
      )
    ) {
      glog("computeColumnDropTarget", "nest reject: adjacent no-op", {
        zone,
        rawId,
      });
      return null;
    }
    const targetParentId = folderParentMap[rawId] ?? null;
    if (zone === "before") {
      const siblings = orderedSiblings.filter(
        (f) => f.parentId === targetParentId && f.id !== activeFolderId,
      );
      const idx = siblings.findIndex((f) => f.id === rawId);
      const predecessor = idx > 0 ? (siblings[idx - 1]?.id ?? null) : null;
      const result = { targetParentId, afterId: predecessor };
      glog("computeColumnDropTarget", "branch: nest before", result);
      return result;
    }
    const result = { targetParentId, afterId: rawId };
    glog("computeColumnDropTarget", "branch: nest after", result);
    return result;
  }

  // Empty-folder drop zone — nest-only. Geometric ambiguity prevents a clean
  // Y-axis 3-zone here (the empty area spans most of the column body), and
  // column-slot already provides X-axis before/after for top-level columns.
  if (kind === "empty" && rawId !== "loose") {
    if (rawId === activeFolderId) {
      glog("computeColumnDropTarget", "empty reject: target == active");
      return null;
    }
    if (isSelfOrDescendant(rawId, activeFolderId, folderParentMap)) {
      glog(
        "computeColumnDropTarget",
        "empty reject: target is descendant of active",
      );
      return null;
    }
    if ((folderParentMap[activeFolderId] ?? null) === rawId) {
      glog(
        "computeColumnDropTarget",
        "empty reject: active already child of target",
      );
      return null;
    }
    const result = { targetParentId: rawId, afterId: undefined };
    glog("computeColumnDropTarget", "branch: empty nest", result);
    return result;
  }

  // Scene drop zone → Y-axis 2-zone: column becomes a sibling of the scene in
  // the scene's parent. Resolved predecessor uses ALL siblings (scenes and
  // folders) since the dragged column gets interleaved among them.
  if (kind === "drop") {
    const sceneId = rawId;
    const targetParentId = sceneParentMap[sceneId] ?? null;
    if (targetParentId === activeFolderId) {
      glog("computeColumnDropTarget", "drop reject: scene's parent == active");
      return null;
    }
    if (
      targetParentId !== null &&
      isSelfOrDescendant(targetParentId, activeFolderId, folderParentMap)
    ) {
      glog(
        "computeColumnDropTarget",
        "drop reject: scene's parent is descendant of active",
      );
      return null;
    }
    const midY = overRect.top + overRect.height / 2;
    const zone: "before" | "after" = pointerY <= midY ? "before" : "after";
    if (
      isAdjacentColumnNoOp(
        activeFolderId,
        sceneId,
        zone,
        folderParentMap,
        orderedSiblings,
      )
    ) {
      glog("computeColumnDropTarget", "drop reject: adjacent no-op", {
        zone,
        sceneId,
      });
      return null;
    }
    if (zone === "before") {
      const siblings = orderedSiblings.filter(
        (s) => s.parentId === targetParentId && s.id !== activeFolderId,
      );
      const idx = siblings.findIndex((s) => s.id === sceneId);
      const predecessor = idx > 0 ? (siblings[idx - 1]?.id ?? null) : null;
      const result = { targetParentId, afterId: predecessor };
      glog("computeColumnDropTarget", "branch: drop before", result);
      return result;
    }
    const result = { targetParentId, afterId: sceneId };
    glog("computeColumnDropTarget", "branch: drop after", result);
    return result;
  }

  const targetId = resolveEnclosingFolderId(overId, sceneParentMap);
  if (!targetId) {
    glog("computeColumnDropTarget", "no enclosing folder", { overId, kind });
    return null;
  }
  if (targetId === activeFolderId) {
    glog("computeColumnDropTarget", "reject: enclosing folder == active");
    return null;
  }
  // Conservative: dropping a Part onto loose scenes (children of containerId)
  // shouldn't bubble up and move the Part out of containerId.
  if (targetId === containerId) {
    glog("computeColumnDropTarget", "reject: enclosing folder == containerId");
    return null;
  }
  // Cycle prevention: target must not be a descendant of active.
  if (isSelfOrDescendant(targetId, activeFolderId, folderParentMap)) {
    glog(
      "computeColumnDropTarget",
      "reject: enclosing folder is descendant of active",
    );
    return null;
  }
  const position = resolveColumnDropPosition(
    activeFolderId,
    targetId,
    pointerX,
    overRect,
    folderParentMap,
    orderedSiblings,
  );
  glog("computeColumnDropTarget", "resolved position", { targetId, position });
  if (!position) {
    glog("computeColumnDropTarget", "no-op (adjacent or same)");
    return null;
  }
  if (position === "nest") {
    const result = { targetParentId: targetId, afterId: undefined };
    glog("computeColumnDropTarget", "branch: implicit nest", result);
    return result;
  }
  const targetParentId = folderParentMap[targetId] ?? null;
  if (position === "before") {
    // Insert before target: predecessor is target's prev sibling in same parent (excluding active)
    const siblings = orderedSiblings.filter(
      (f) => f.parentId === targetParentId && f.id !== activeFolderId,
    );
    const idx = siblings.findIndex((f) => f.id === targetId);
    const predecessor = idx > 0 ? (siblings[idx - 1]?.id ?? null) : null;
    const result = { targetParentId, afterId: predecessor };
    glog("computeColumnDropTarget", "branch: before", result);
    return result;
  }
  const result = { targetParentId, afterId: targetId };
  glog("computeColumnDropTarget", "branch: after", result);
  return result;
}

export type SceneDragMode = "axis-locked" | "free";

/**
 * Decide whether a scene drag is in "axis-locked" reorder mode (Y-only,
 * same-parent swaps) or "free" full-DnD mode (3-zone insertion, column-nest,
 * cross-column reparent).
 *
 * Hysteresis: once free, never reverts. Crossing the threshold even briefly
 * commits to free for the rest of the drag — flipping back mid-gesture would
 * make the visual feedback (sibling slide vs. drop bar) flicker.
 */
export function resolveSceneDragMode(
  currentMode: SceneDragMode,
  deltaX: number,
  thresholdPx: number,
): SceneDragMode {
  if (currentMode === "free") return "free";
  return Math.abs(deltaX) >= thresholdPx ? "free" : "axis-locked";
}

/**
 * Resolve where the dragged scene would land if dropped right now in
 * axis-locked mode. Restricted to same-parent reorder; cross-column drops are
 * only available in free mode.
 *
 * Algorithm: walk siblings (active excluded), determine the target index as
 * the count of upper siblings whose midpoint is above pointerY — i.e. how
 * many siblings the dragged card has passed. Returns the predecessor in the
 * remaining (active-removed) siblings list.
 */
export function computeSceneAxisLockTarget(
  activeSceneId: string,
  pointerY: number,
  orderedScenes: Array<{ id: string; parentId: string | null }>,
  siblingRects: Record<string, { top: number; bottom: number }>,
): DropTarget | null {
  const active = orderedScenes.find((s) => s.id === activeSceneId);
  if (!active) return null;
  const parentId = active.parentId;
  const siblingsAll = orderedScenes.filter((s) => s.parentId === parentId);
  if (siblingsAll.length <= 1) return null;

  const siblingsExcl = siblingsAll.filter((s) => s.id !== activeSceneId);
  // Number of remaining siblings whose midpoint is above pointerY.
  let targetIdx = 0;
  let sawRect = false;
  for (const sib of siblingsExcl) {
    const rect = siblingRects[sib.id];
    if (!rect) continue;
    sawRect = true;
    const mid = (rect.top + rect.bottom) / 2;
    if (pointerY > mid) targetIdx++;
  }
  if (!sawRect) return null;

  const activeIdxFull = siblingsAll.findIndex((s) => s.id === activeSceneId);
  // Map targetIdx (in siblingsExcl) back to siblingsAll space to detect no-op.
  const equivalentFullIdx =
    targetIdx <= activeIdxFull ? targetIdx : targetIdx + 1;
  if (equivalentFullIdx === activeIdxFull) return null;

  const afterId =
    targetIdx > 0 ? (siblingsExcl[targetIdx - 1]?.id ?? null) : null;
  return { targetParentId: parentId, afterId };
}

/**
 * Compute which siblings should visually slide to make room for the dragged
 * card during axis-locked drag. Returns a map of sibling id → shift direction
 * ("up" or "down"). The dragged card itself is never in the map.
 *
 * Direction semantics:
 *   "up"   = sibling shifts toward the column top (active is descending past it)
 *   "down" = sibling shifts toward the column bottom (active is ascending past it)
 */
export function computeSceneAxisLockShifts(
  activeSceneId: string,
  pointerY: number,
  orderedScenes: Array<{ id: string; parentId: string | null }>,
  siblingRects: Record<string, { top: number; bottom: number }>,
): Map<string, "up" | "down"> {
  const result = new Map<string, "up" | "down">();
  const active = orderedScenes.find((s) => s.id === activeSceneId);
  if (!active) return result;
  const parentId = active.parentId;
  const siblingsAll = orderedScenes.filter((s) => s.parentId === parentId);
  const activeIdx = siblingsAll.findIndex((s) => s.id === activeSceneId);
  if (activeIdx < 0) return result;

  for (let i = 0; i < siblingsAll.length; i++) {
    if (i === activeIdx) continue;
    const sib = siblingsAll[i];
    const rect = siblingRects[sib.id];
    if (!rect) continue;
    const mid = (rect.top + rect.bottom) / 2;
    if (i < activeIdx && pointerY < mid) {
      // Active is moving above this upper sibling → upper sibling shifts down
      result.set(sib.id, "down");
    } else if (i > activeIdx && pointerY > mid) {
      // Active is moving below this lower sibling → lower sibling shifts up
      result.set(sib.id, "up");
    }
  }
  return result;
}

/**
 * Compute axis-locked drag translateY pixel offsets, height-aware.
 *
 * Passing siblings each shift by ±(active's slot height) — the size of the
 * vacancy active leaves and that propagates through the swap chain.
 *
 * The active card shifts by the SUM of (slot height) for each sibling it
 * passes — it travels into each passed slot, and those slots can be
 * different sizes than active's own. Using activeSlot * N would drift in
 * variable-height columns and accumulate over multi-sibling passes.
 */
export function computeSceneAxisLockPxOffsets(
  activeSceneId: string,
  pointerY: number,
  orderedScenes: Array<{ id: string; parentId: string | null }>,
  siblingRects: Record<string, { top: number; bottom: number }>,
  gapPx: number,
): Map<string, number> {
  const result = new Map<string, number>();
  const activeRect = siblingRects[activeSceneId];
  if (!activeRect) return result;
  const activeSlot = activeRect.bottom - activeRect.top + gapPx;

  const directions = computeSceneAxisLockShifts(
    activeSceneId,
    pointerY,
    orderedScenes,
    siblingRects,
  );

  let activeOffset = 0;
  for (const [id, dir] of directions) {
    const r = siblingRects[id];
    if (!r) continue;
    const sibSlot = r.bottom - r.top + gapPx;
    if (dir === "up") {
      result.set(id, -activeSlot);
      activeOffset += sibSlot;
    } else {
      result.set(id, activeSlot);
      activeOffset -= sibSlot;
    }
  }
  if (activeOffset !== 0) {
    result.set(activeSceneId, activeOffset);
  }
  return result;
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
