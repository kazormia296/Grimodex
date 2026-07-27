import { useRef, useState } from "react";
import type {
  DragEndEvent,
  DragOverEvent,
  DragStartEvent,
} from "@dnd-kit/core";
import type { TreeNodeData } from "@/features/tree/treeStore";
import { cmpKeys } from "@/features/tree/fractionalIndex";
import { useGridStore } from "./gridStore";
import { moveScenesToChapter } from "./bulkSceneOps";
import {
  activeDragKind,
  computeSceneDropTarget,
  computeColumnDropTarget,
  computeSceneDropIndicator,
  computeColumnDropIndicator,
  computeSceneAxisLockTarget,
  computeColumnAxisLockTarget,
  findFolderBlockLastVisibleId,
} from "./gridDndUtils";
import type { DropIndicator, ColumnDropIndicator } from "./gridDndUtils";
import {
  glog,
  gperfStart,
  gperfMark,
  gperfMarkAsync,
  gperfFlush,
} from "./gridDndLog";
import { useGridAxisLockController } from "./useGridAxisLockController";

interface GridDragControllerOptions {
  nodes: TreeNodeData[];
  orderedScenes: Array<{ id: string; parentId: string | null }>;
  flatOrder: string[];
  containerId: string | null;
  selectedSceneIds: Set<string>;
  moveNode: (
    nodeId: string,
    newParentId: string | null,
    afterId?: string | null,
  ) => Promise<unknown>;
}

function findScrollableParent(el: HTMLElement): HTMLElement | null {
  let cur: HTMLElement | null = el.parentElement;
  while (cur) {
    const style = window.getComputedStyle(cur);
    if (
      (style.overflowY === "auto" || style.overflowY === "scroll") &&
      cur.scrollHeight > cur.clientHeight
    ) {
      return cur;
    }
    cur = cur.parentElement;
  }
  return null;
}

function findHorizontallyScrollableParent(el: HTMLElement): HTMLElement | null {
  let cur: HTMLElement | null = el.parentElement;
  while (cur) {
    const style = window.getComputedStyle(cur);
    if (
      (style.overflowX === "auto" || style.overflowX === "scroll") &&
      cur.scrollWidth > cur.clientWidth
    ) {
      return cur;
    }
    cur = cur.parentElement;
  }
  return null;
}

export function useGridDragController({
  nodes,
  orderedScenes,
  flatOrder,
  containerId,
  selectedSceneIds,
  moveNode,
}: GridDragControllerOptions) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [dropIndicator, setDropIndicator] = useState<DropIndicator | null>(
    null,
  );
  const [columnDropIndicator, setColumnDropIndicator] =
    useState<ColumnDropIndicator | null>(null);
  const lastDragOverKeyRef = useRef("");
  const {
    pointerXRef,
    pointerYRef,
    axisLockSessionRef,
    columnAxisLockSessionRef,
    axisLockScrollListenerRef,
    columnAxisLockScrollListenerRef,
    axisLockOffsets,
    setAxisLockOffsets,
    columnAxisLockOffsets,
    setColumnAxisLockOffsets,
    axisLockActive,
    setAxisLockActive,
    columnAxisLockActive,
    setColumnAxisLockActive,
    recomputeAxisLock,
    recomputeColumnAxisLock,
    detachAxisLockScrollListener,
    detachColumnAxisLockScrollListener,
  } = useGridAxisLockController();

  function handleDragStart(e: DragStartEvent) {
    gperfStart();
    gperfMark("DragStart", () => handleDragStartInner(e));
  }

  function handleDragStartInner(e: DragStartEvent) {
    const id = String(e.active.id);
    const kind = activeDragKind(id);
    glog("DragStart", "active", {
      id,
      kind,
      pointer: { x: pointerXRef.current, y: pointerYRef.current },
    });
    lastDragOverKeyRef.current = "";
    setActiveId(id);
    setDropIndicator(null);
    setColumnDropIndicator(null);
    axisLockSessionRef.current = null;
    setAxisLockOffsets((prev) => (prev.size === 0 ? prev : new Map()));
    columnAxisLockSessionRef.current = null;
    setColumnAxisLockOffsets((prev) => (prev.size === 0 ? prev : new Map()));

    if (kind === "scene") {
      const sceneId = id.replace(/^scene-/, "");
      const sceneNode = nodes.find((n) => n.id === sceneId);
      if (!sceneNode) return;
      const siblings = nodes
        .filter(
          (n) =>
            n.parentId === sceneNode.parentId &&
            (n.nodeType === "scene" || n.nodeType === "folder"),
        )
        .sort((a, b) => cmpKeys(a.sortOrder, b.sortOrder));
      if (siblings.length <= 1) return;
      const collapsedFolderIds = useGridStore.getState().collapsedFolderIds;
      const siblingRects: Record<string, { top: number; bottom: number }> = {};
      for (const sibling of siblings) {
        const attr =
          sibling.nodeType === "folder"
            ? "data-grid-folder-id"
            : "data-grid-scene-id";
        const el = document.querySelector(`[${attr}="${sibling.id}"]`);
        if (!(el instanceof HTMLElement)) continue;
        const rect = el.getBoundingClientRect();
        let bottom = rect.bottom;
        if (sibling.nodeType === "folder") {
          const lastId = findFolderBlockLastVisibleId(
            sibling.id,
            nodes,
            collapsedFolderIds,
          );
          if (lastId) {
            const lastNode = nodes.find((n) => n.id === lastId);
            const lastAttr =
              lastNode?.nodeType === "folder"
                ? "data-grid-folder-id"
                : "data-grid-scene-id";
            const lastEl = document.querySelector(`[${lastAttr}="${lastId}"]`);
            if (lastEl instanceof HTMLElement) {
              bottom = lastEl.getBoundingClientRect().bottom;
            }
          }
        }
        siblingRects[sibling.id] = { top: rect.top, bottom };
      }
      // A virtualized column intentionally mounts only its visible cards.
      // Axis-lock math needs every sibling rect; using a partial set maps the
      // pointer to the wrong predecessor. Fall back to regular DnD whenever
      // the complete sibling set is not currently measurable.
      if (
        !siblingRects[sceneId] ||
        Object.keys(siblingRects).length !== siblings.length
      ) {
        return;
      }
      const activeEl = document.querySelector(
        `[data-grid-scene-id="${sceneId}"]`,
      );
      const scrollEl =
        activeEl instanceof HTMLElement ? findScrollableParent(activeEl) : null;
      axisLockSessionRef.current = {
        mode: "axis-locked",
        startX: pointerXRef.current,
        activeSceneId: sceneId,
        siblingRects,
        orderedSiblings: siblings.map((sibling) => ({
          id: sibling.id,
          parentId: sibling.parentId,
        })),
        scrollEl,
        initialScrollTop: scrollEl?.scrollTop ?? 0,
      };
      if (scrollEl) {
        const onScroll = () => recomputeAxisLock.current();
        scrollEl.addEventListener("scroll", onScroll, { passive: true });
        axisLockScrollListenerRef.current = { el: scrollEl, fn: onScroll };
      }
      setAxisLockActive(true);
    }

    if (kind === "column") {
      const folderId = id.replace(/^column-/, "");
      const folderNode = nodes.find((n) => n.id === folderId);
      if (!folderNode) return;
      const siblings = nodes
        .filter(
          (n) => n.parentId === folderNode.parentId && n.nodeType === "folder",
        )
        .sort((a, b) => cmpKeys(a.sortOrder, b.sortOrder));
      if (siblings.length <= 1) return;
      const siblingRects: Record<string, { left: number; right: number }> = {};
      for (const sibling of siblings) {
        const el = document.querySelector(
          `[data-grid-folder-id="${sibling.id}"]`,
        );
        if (!(el instanceof HTMLElement)) continue;
        const rect = el.getBoundingClientRect();
        siblingRects[sibling.id] = { left: rect.left, right: rect.right };
      }
      if (
        !siblingRects[folderId] ||
        Object.keys(siblingRects).length !== siblings.length
      ) {
        return;
      }
      const activeEl = document.querySelector(
        `[data-grid-folder-id="${folderId}"]`,
      );
      const scrollEl =
        activeEl instanceof HTMLElement
          ? findHorizontallyScrollableParent(activeEl)
          : null;
      columnAxisLockSessionRef.current = {
        mode: "axis-locked",
        startY: pointerYRef.current,
        activeFolderId: folderId,
        siblingRects,
        orderedSiblings: siblings.map((sibling) => ({
          id: sibling.id,
          parentId: sibling.parentId,
        })),
        scrollEl,
        initialScrollLeft: scrollEl?.scrollLeft ?? 0,
      };
      if (scrollEl) {
        const onScroll = () => recomputeColumnAxisLock.current();
        scrollEl.addEventListener("scroll", onScroll, { passive: true });
        columnAxisLockScrollListenerRef.current = {
          el: scrollEl,
          fn: onScroll,
        };
      }
      setColumnAxisLockActive(true);
    }
  }

  function handleDragOver(e: DragOverEvent) {
    const activeIdStr = String(e.active.id);
    const kind = activeDragKind(activeIdStr);
    const overId = e.over ? String(e.over.id) : "";
    if (kind === "scene") {
      gperfMark("DragOver.scene", () => {
        if (axisLockSessionRef.current?.mode === "axis-locked") {
          setDropIndicator(null);
          setColumnDropIndicator(null);
          return;
        }
        const rect = e.over?.rect ?? { top: 0, height: 60 };
        const indicator = computeSceneDropIndicator(
          activeIdStr.replace(/^scene-/, ""),
          overId,
          pointerYRef.current,
          { top: rect.top, height: rect.height },
        );
        const key = `scene|${overId}|${indicator?.targetId ?? ""}|${indicator?.position ?? ""}`;
        if (key !== lastDragOverKeyRef.current) {
          lastDragOverKeyRef.current = key;
          glog("DragOver(scene)", "state change", {
            activeId: activeIdStr,
            overId,
            pointer: { x: pointerXRef.current, y: pointerYRef.current },
            rect,
            indicator,
          });
        }
        setDropIndicator(indicator);
        setColumnDropIndicator(null);
      });
      return;
    }
    if (kind !== "column") return;
    gperfMark("DragOver.column", () => {
      if (columnAxisLockSessionRef.current?.mode === "axis-locked") {
        setDropIndicator(null);
        setColumnDropIndicator(null);
        return;
      }
      const folderId = activeIdStr.replace(/^column-/, "");
      const activeParent =
        nodes.find((n) => n.id === folderId)?.parentId ?? null;
      if (overId.startsWith("scene-drop-")) {
        const sceneId = overId.slice("scene-drop-".length);
        const sceneNode = nodes.find((n) => n.id === sceneId);
        if (sceneNode && sceneNode.parentId === activeParent) {
          const rect = e.over?.rect ?? { top: 0, height: 60 };
          const position: "before" | "after" =
            pointerYRef.current <= rect.top + rect.height / 2
              ? "before"
              : "after";
          const key = `col-as-scene|${overId}|${sceneId}|${position}`;
          if (key !== lastDragOverKeyRef.current) {
            lastDragOverKeyRef.current = key;
            glog("DragOver(column)", "sibling-scene path", {
              activeFolderId: folderId,
              targetSceneId: sceneId,
              activeParent,
              position,
            });
          }
          setDropIndicator({ targetId: sceneId, position });
          setColumnDropIndicator(null);
          return;
        }
      }
      const { folderParentMap, sceneParentMap, orderedSiblings } =
        buildColumnMaps(nodes);
      const rect = e.over?.rect ?? {
        left: 0,
        width: 200,
        top: 0,
        height: 0,
      };
      const indicator = computeColumnDropIndicator(
        folderId,
        overId,
        pointerXRef.current,
        pointerYRef.current,
        {
          left: rect.left,
          width: rect.width,
          top: rect.top,
          height: rect.height,
        },
        sceneParentMap,
        folderParentMap,
        orderedSiblings,
        containerId,
      );
      const key = `col|${overId}|${indicator?.targetId ?? ""}|${indicator?.position ?? ""}`;
      if (key !== lastDragOverKeyRef.current) {
        lastDragOverKeyRef.current = key;
        glog("DragOver(column)", "state change", {
          activeFolderId: folderId,
          overId,
          pointer: { x: pointerXRef.current, y: pointerYRef.current },
          rect,
          indicator,
        });
      }
      setColumnDropIndicator(indicator);
      setDropIndicator(null);
    });
  }

  function handleDragEnd(e: DragEndEvent) {
    gperfMark("DragEnd", () => handleDragEndInner(e));
    gperfFlush({
      activeId: String(e.active.id),
      overId: e.over ? String(e.over.id) : "",
      nodeCount: nodes.length,
    });
  }

  function handleDragEndInner(e: DragEndEvent) {
    setActiveId(null);
    setDropIndicator(null);
    setColumnDropIndicator(null);
    const activeIdStr = String(e.active.id);
    const overIdStr = e.over ? String(e.over.id) : "";
    const kind = activeDragKind(activeIdStr);
    glog("DragEnd", "entry", {
      activeId: activeIdStr,
      overId: overIdStr,
      kind,
      pointer: { x: pointerXRef.current, y: pointerYRef.current },
    });

    const session = axisLockSessionRef.current;
    axisLockSessionRef.current = null;
    detachAxisLockScrollListener();
    setAxisLockActive(false);
    setAxisLockOffsets((prev) => (prev.size === 0 ? prev : new Map()));
    const columnSession = columnAxisLockSessionRef.current;
    columnAxisLockSessionRef.current = null;
    detachColumnAxisLockScrollListener();
    setColumnAxisLockActive(false);
    setColumnAxisLockOffsets((prev) => (prev.size === 0 ? prev : new Map()));

    if (kind === "column" && columnSession?.mode === "axis-locked") {
      const folderId = activeIdStr.replace(/^column-/, "");
      const scrollDelta = columnSession.scrollEl
        ? columnSession.scrollEl.scrollLeft - columnSession.initialScrollLeft
        : 0;
      const target = computeColumnAxisLockTarget(
        folderId,
        pointerXRef.current + scrollDelta,
        columnSession.orderedSiblings,
        columnSession.siblingRects,
      );
      if (target) {
        void gperfMarkAsync(
          "moveNode(column, axis-lock)",
          moveNode(folderId, target.targetParentId, target.afterId),
        );
      }
      return;
    }

    if (kind === "scene" && session?.mode === "axis-locked") {
      const sceneId = activeIdStr.replace(/^scene-/, "");
      const scrollDelta = session.scrollEl
        ? session.scrollEl.scrollTop - session.initialScrollTop
        : 0;
      const target = computeSceneAxisLockTarget(
        sceneId,
        pointerYRef.current + scrollDelta,
        session.orderedSiblings,
        session.siblingRects,
      );
      if (target) {
        if (selectedSceneIds.has(sceneId) && selectedSceneIds.size > 1) {
          const orderedSelected = flatOrder.filter((id) =>
            selectedSceneIds.has(id),
          );
          void gperfMarkAsync(
            "moveScenesToChapter(axis-lock multi-select)",
            moveScenesToChapter(orderedSelected, target.targetParentId),
          );
        } else {
          void gperfMarkAsync(
            "moveNode(scene, axis-lock)",
            moveNode(sceneId, target.targetParentId, target.afterId),
          );
        }
      }
      return;
    }

    if (!overIdStr) return;
    if (kind === "scene") {
      const sceneId = activeIdStr.replace(/^scene-/, "");
      const target = computeSceneDropTarget(
        sceneId,
        overIdStr,
        pointerYRef.current,
        e.over?.rect ?? { top: 0, height: 60 },
        orderedScenes,
        containerId,
      );
      if (!target) return;
      if (selectedSceneIds.has(sceneId) && selectedSceneIds.size > 1) {
        const orderedSelected = flatOrder.filter((id) =>
          selectedSceneIds.has(id),
        );
        void gperfMarkAsync(
          "moveScenesToChapter(free multi-select)",
          moveScenesToChapter(orderedSelected, target.targetParentId),
        );
      } else {
        void gperfMarkAsync(
          "moveNode(scene, free)",
          moveNode(sceneId, target.targetParentId, target.afterId),
        );
      }
      return;
    }

    if (kind !== "column") return;
    const folderId = activeIdStr.replace(/^column-/, "");
    const activeParent = nodes.find((n) => n.id === folderId)?.parentId ?? null;
    if (overIdStr.startsWith("scene-drop-")) {
      const sceneId = overIdStr.slice("scene-drop-".length);
      const sceneNode = nodes.find((n) => n.id === sceneId);
      if (sceneNode && sceneNode.parentId === activeParent) {
        const rect = e.over?.rect ?? { top: 0, height: 60 };
        const insertBefore = pointerYRef.current <= rect.top + rect.height / 2;
        const siblings = nodes
          .filter((n) => n.parentId === activeParent && n.id !== folderId)
          .sort((a, b) => cmpKeys(a.sortOrder, b.sortOrder));
        const idx = siblings.findIndex((sibling) => sibling.id === sceneId);
        const afterId = insertBefore
          ? idx > 0
            ? (siblings[idx - 1]?.id ?? null)
            : null
          : sceneId;
        void gperfMarkAsync(
          "moveNode(column, sibling-scene)",
          moveNode(folderId, activeParent, afterId),
        );
        return;
      }
    }
    const { folderParentMap, sceneParentMap, orderedSiblings } =
      buildColumnMaps(nodes);
    const rect = e.over?.rect ?? {
      left: 0,
      width: 200,
      top: 0,
      height: 0,
    };
    const target = computeColumnDropTarget(
      folderId,
      overIdStr,
      pointerXRef.current,
      pointerYRef.current,
      {
        left: rect.left,
        width: rect.width,
        top: rect.top,
        height: rect.height,
      },
      folderParentMap,
      orderedSiblings,
      sceneParentMap,
      containerId,
    );
    if (target) {
      void gperfMarkAsync(
        "moveNode(column, free)",
        moveNode(folderId, target.targetParentId, target.afterId),
      );
    }
  }

  function handleDragCancel() {
    setActiveId(null);
    setDropIndicator(null);
    setColumnDropIndicator(null);
    axisLockSessionRef.current = null;
    detachAxisLockScrollListener();
    setAxisLockActive(false);
    setAxisLockOffsets((prev) => (prev.size === 0 ? prev : new Map()));
    columnAxisLockSessionRef.current = null;
    detachColumnAxisLockScrollListener();
    setColumnAxisLockActive(false);
    setColumnAxisLockOffsets((prev) => (prev.size === 0 ? prev : new Map()));
    gperfFlush({ reason: "cancel" });
  }

  const activeDragNode: TreeNodeData | null = activeId
    ? (nodes.find((n) => n.id === activeId.replace(/^(scene|column)-/, "")) ??
      null)
    : null;
  const activeDragIsMultiSelect =
    activeId !== null &&
    activeDragKind(activeId) === "scene" &&
    selectedSceneIds.has(activeId.replace(/^scene-/, "")) &&
    selectedSceneIds.size > 1;

  return {
    activeId,
    activeDragNode,
    activeDragIsMultiSelect,
    dropIndicator,
    columnDropIndicator,
    axisLockOffsets,
    columnAxisLockOffsets,
    axisLockActive,
    columnAxisLockActive,
    pointerXRef,
    pointerYRef,
    handleDragStart,
    handleDragOver,
    handleDragEnd,
    handleDragCancel,
  };
}

function buildColumnMaps(nodes: TreeNodeData[]) {
  const folderParentMap: Record<string, string | null> = {};
  const sceneParentMap: Record<string, string | null> = {};
  const orderedSiblings: Array<{ id: string; parentId: string | null }> = [];
  for (const node of [...nodes].sort((a, b) =>
    cmpKeys(a.sortOrder, b.sortOrder),
  )) {
    if (node.nodeType === "folder") folderParentMap[node.id] = node.parentId;
    if (node.nodeType === "scene") sceneParentMap[node.id] = node.parentId;
    if (node.nodeType === "folder" || node.nodeType === "scene") {
      orderedSiblings.push({ id: node.id, parentId: node.parentId });
    }
  }
  return { folderParentMap, sceneParentMap, orderedSiblings };
}
