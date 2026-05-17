import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  KeyboardSensor,
  pointerWithin,
  rectIntersection,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import type {
  CollisionDetection,
  DragEndEvent,
  DragOverEvent,
  DragStartEvent,
  Modifier,
} from "@dnd-kit/core";
import { getEventCoordinates } from "@dnd-kit/utilities";
import { useTranslation } from "react-i18next";
import { useTreeStore } from "@/features/tree/treeStore";
import { useSceneCodexPinsStore } from "@/features/codex/sceneCodexPinsStore";
import { useEnsureCodexTypeColors } from "@/features/codex/useEnsureCodexTypeColors";
import { cmpKeys } from "@/features/tree/fractionalIndex";
import { useGridStore } from "./gridStore";
import { useGridDerivedData, useGridFlatSceneOrder } from "./gridSelectors";
import { useGridCardVisibility } from "./useGridCardVisibility";
import { GridHeader } from "./GridHeader";
import { GridContainerOutline } from "./GridContainerOutline";
import { GridContainerSceneColumn } from "./GridContainerSceneColumn";
import { GridDisplayToolbar } from "./GridDisplayToolbar";
import { ManageLabelsDialog } from "@/features/labels/ManageLabelsDialog";
import { useLabelStore } from "@/features/labels/labelStore";
import { useForeshadowStore } from "@/features/foreshadow/foreshadowStore";
import { GridColumn } from "./GridColumn";
import { GridLooseColumn } from "./GridLooseColumn";
import { GridStatusBar } from "./GridStatusBar";
import { GridSelectionToolbar } from "./GridSelectionToolbar";
import { StructureTemplatePicker } from "./StructureTemplatePicker";
import { moveScenesToChapter } from "./bulkSceneOps";
import { resolveContainerForScene } from "./gridReveal";
import {
  activeDragKind,
  computeSceneDropTarget,
  computeColumnDropTarget,
  computeSceneDropIndicator,
  computeColumnDropIndicator,
} from "./gridDndUtils";
import type { DropIndicator, ColumnDropIndicator } from "./gridDndUtils";
import { glog } from "./gridDndLog";
import type { TreeNodeData } from "@/features/tree/treeStore";

/**
 * Pointer-based collision wins for nested droppables — when the cursor is on
 * a folder card inside a column, the folder card (smaller, closer to pointer)
 * is picked instead of the enclosing column-slot. Falls back to
 * `rectIntersection` for the gutters between columns where the pointer isn't
 * inside any droppable rect (otherwise drops there yield no target).
 *
 * Default `rectIntersection` ranked targets by overlay-area overlap, which
 * with our snap-to-cursor overlay flips between targets across frames and
 * makes the indicator look like it lights up two places at once.
 */
const gridCollisionDetection: CollisionDetection = (args) => {
  const pointer = pointerWithin(args);
  if (pointer.length > 0) return pointer;
  return rectIntersection(args);
};

/**
 * Pin the DragOverlay's center to the pointer. The actual draggable element
 * for a column drag is the entire chapter column (≈ 320×600 px), but the
 * overlay we render is a small title pill. dnd-kit's default behavior anchors
 * the overlay to the active element's top-left, which leaves the pill far
 * from the cursor — visually disconnected. Snapping center-to-cursor keeps
 * the overlay under the pointer regardless of the active element's size.
 *
 * Inlined from `@dnd-kit/modifiers`'s snapCenterToCursor to avoid pulling in
 * the whole package for a single helper.
 */
const snapOverlayCenterToCursor: Modifier = ({
  activatorEvent,
  draggingNodeRect,
  transform,
}) => {
  if (!draggingNodeRect || !activatorEvent) return transform;
  const coords = getEventCoordinates(activatorEvent);
  if (!coords) return transform;
  return {
    ...transform,
    x:
      transform.x +
      (coords.x - draggingNodeRect.left) -
      draggingNodeRect.width / 2,
    y:
      transform.y +
      (coords.y - draggingNodeRect.top) -
      draggingNodeRect.height / 2,
  };
};

export function GridPanel() {
  const { t } = useTranslation();
  const projectId = useTreeStore((s) => s.projectId);
  const moveNode = useTreeStore((s) => s.moveNode);
  const nodes = useTreeStore((s) => s.nodes);
  const deleteNode = useTreeStore((s) => s.deleteNode);

  const containerId = useGridStore((s) => s.containerId);
  const display = useGridStore((s) => s.display);
  const filter = useGridStore((s) => s.filter);
  const searchQuery = useGridStore((s) => s.searchQuery);
  const setContainerId = useGridStore((s) => s.setContainerId);
  const loadForProject = useGridStore((s) => s.loadForProject);
  const clearSelection = useGridStore((s) => s.clearSelection);
  const selectAll = useGridStore((s) => s.selectAll);
  const selectedSceneIds = useGridStore((s) => s.selectedSceneIds);
  const pendingRevealSceneId = useGridStore((s) => s.pendingRevealSceneId);
  const createNode = useTreeStore((s) => s.createNode);

  async function addChapter() {
    await createNode({ nodeType: "folder", parentId: containerId });
  }

  useEnsureCodexTypeColors();

  const pinsByScene = useSceneCodexPinsStore((s) => s.pinsByScene);

  const { chapters, looseScenes, orderedColumns, totalChapters, totalScenes } =
    useGridDerivedData(containerId);
  const flatOrder = useGridFlatSceneOrder(containerId);

  const toolbarOpen = useGridStore((s) => s.toolbarOpen);
  const setToolbarOpen = useGridStore((s) => s.setToolbarOpen);

  const [manageLabelsOpen, setManageLabelsOpen] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [dropIndicator, setDropIndicator] = useState<DropIndicator | null>(
    null,
  );
  const [columnDropIndicator, setColumnDropIndicator] =
    useState<ColumnDropIndicator | null>(null);
  const [deleteConfirmIds, setDeleteConfirmIds] = useState<string[] | null>(
    null,
  );
  const pointerYRef = useRef(0);
  const pointerXRef = useRef(0);
  const panelRef = useRef<HTMLDivElement>(null);
  // Dedupe key for dragOver logging — handler fires ~60Hz, but the meaningful
  // state ({ overId, indicator }) changes only at zone boundaries.
  const lastDragOverKeyRef = useRef<string>("");

  useEffect(() => {
    void loadForProject(projectId);
    void useLabelStore.getState().load(projectId);
    void useForeshadowStore.getState().load(projectId);
  }, [projectId, loadForProject]);

  useEffect(() => {
    const handler = (e: PointerEvent) => {
      pointerXRef.current = e.clientX;
      pointerYRef.current = e.clientY;
    };
    window.addEventListener("pointermove", handler);
    return () => window.removeEventListener("pointermove", handler);
  }, []);

  // Esc: clear selection
  useEffect(() => {
    function isEditableTarget(): boolean {
      const el = document.activeElement;
      if (!el) return false;
      const tag = el.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT")
        return true;
      return (el as HTMLElement).isContentEditable;
    }
    function handleKey(e: KeyboardEvent) {
      if (isEditableTarget()) return;
      if (e.key === "Escape" && !deleteConfirmIds) {
        clearSelection();
      }
      // Cmd/Ctrl+A: select all visible scenes (only when panel is focused)
      if (
        (e.key === "a" || e.key === "A") &&
        (e.metaKey || e.ctrlKey) &&
        !e.shiftKey
      ) {
        const panel = panelRef.current;
        if (
          panel &&
          (panel.contains(document.activeElement) ||
            panel === document.activeElement)
        ) {
          e.preventDefault();
          selectAll(flatOrder);
        }
      }
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [clearSelection, selectAll, flatOrder, deleteConfirmIds]);

  // Click outside: clear selection
  function handlePanelClick(e: React.MouseEvent<HTMLDivElement>) {
    const target = e.target as HTMLElement;
    // If click landed directly on the panel background (not a card or button), clear selection
    if (
      target === panelRef.current ||
      (target.closest("[data-grid-scene-id]") === null &&
        !target.closest("button") &&
        !target.closest("[role='option']"))
    ) {
      clearSelection();
    }
  }

  // Reveal: respond to pendingRevealSceneId from Matrix → Grid cross-nav
  useEffect(() => {
    if (!pendingRevealSceneId) return;
    useGridStore.getState().clearPendingReveal();

    const nodesById = Object.fromEntries(nodes.map((n) => [n.id, n]));
    const resolution = resolveContainerForScene(
      pendingRevealSceneId,
      nodesById,
    );

    if (resolution.type === "not_found") {
      console.warn("[Grid] reveal: scene not found", pendingRevealSceneId);
      return;
    }

    if (resolution.type === "set") {
      void setContainerId(projectId, resolution.containerId);
    }

    const sceneId = pendingRevealSceneId;
    let attempts = 0;
    function tryScroll() {
      const el = document.querySelector(`[data-grid-scene-id="${sceneId}"]`);
      if (el) {
        el.scrollIntoView({ block: "center", behavior: "smooth" });
        useGridStore.getState().setRevealedSceneId(sceneId);
        useGridStore.getState().selectOnly(sceneId);
        setTimeout(() => {
          useGridStore.getState().clearRevealedSceneId();
        }, 1200);
      } else if (attempts < 15) {
        attempts++;
        requestAnimationFrame(tryScroll);
      }
    }
    requestAnimationFrame(tryScroll);
  }, [pendingRevealSceneId, nodes, projectId, setContainerId]);

  // Bulk delete handler
  const handleDeleteScenes = useCallback(
    (ids: string[]) => {
      const charCounts = useTreeStore.getState().charCounts;
      const anyHasContent = ids.some((id) => {
        const n = nodes.find((node) => node.id === id);
        return n && ((charCounts[id] ?? n.charCount ?? 0) > 0 || !!n.synopsis);
      });
      if (anyHasContent) {
        setDeleteConfirmIds(ids);
      } else {
        clearSelection();
        for (const id of ids) void deleteNode(id);
      }
    },
    [nodes, clearSelection, deleteNode],
  );

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor),
  );

  function handleDragStart(e: DragStartEvent) {
    const id = String(e.active.id);
    glog("DragStart", "active", {
      id,
      kind: activeDragKind(id),
      pointer: { x: pointerXRef.current, y: pointerYRef.current },
    });
    lastDragOverKeyRef.current = "";
    setActiveId(id);
    setDropIndicator(null);
    setColumnDropIndicator(null);
  }

  function handleDragOver(e: DragOverEvent) {
    const activeIdStr = String(e.active.id);
    const kind = activeDragKind(activeIdStr);
    const overId = e.over ? String(e.over.id) : "";

    if (kind === "scene") {
      const sceneId = activeIdStr.replace(/^scene-/, "");
      const rect = e.over?.rect ?? { top: 0, height: 60 };
      const indicator = computeSceneDropIndicator(
        sceneId,
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
      return;
    }

    if (kind === "column") {
      const folderId = activeIdStr.replace(/^column-/, "");
      const activeNode = nodes.find((n) => n.id === folderId);
      const activeParent = activeNode?.parentId ?? null;

      if (overId.startsWith("scene-drop-")) {
        const sceneId = overId.slice("scene-drop-".length);
        const sceneNode = nodes.find((n) => n.id === sceneId);
        if (sceneNode && sceneNode.parentId === activeParent) {
          const rect = e.over?.rect ?? { top: 0, height: 60 };
          const midY = rect.top + rect.height / 2;
          const position: "before" | "after" =
            pointerYRef.current <= midY ? "before" : "after";
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

      const folderParentMap: Record<string, string | null> = {};
      const orderedSiblings: Array<{ id: string; parentId: string | null }> =
        [];
      const sceneParentMap: Record<string, string | null> = {};
      const sortedNodes = [...nodes].sort((a, b) =>
        cmpKeys(a.sortOrder, b.sortOrder),
      );
      for (const n of sortedNodes) {
        if (n.nodeType === "folder") {
          folderParentMap[n.id] = n.parentId;
        }
        if (n.nodeType === "scene") sceneParentMap[n.id] = n.parentId;
        if (n.nodeType === "folder" || n.nodeType === "scene") {
          orderedSiblings.push({ id: n.id, parentId: n.parentId });
        }
      }
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
    }
  }

  function handleDragEnd(e: DragEndEvent) {
    setActiveId(null);
    setDropIndicator(null);
    setColumnDropIndicator(null);
    const activeIdStr = String(e.active.id);
    const overIdStr = e.over ? String(e.over.id) : "";
    glog("DragEnd", "entry", {
      activeId: activeIdStr,
      overId: overIdStr,
      kind: activeDragKind(activeIdStr),
      pointer: { x: pointerXRef.current, y: pointerYRef.current },
    });
    if (!overIdStr) {
      glog("DragEnd", "cancelled: no over target");
      return;
    }

    const kind = activeDragKind(activeIdStr);

    if (kind === "scene") {
      const sceneId = activeIdStr.replace(/^scene-/, "");
      const orderedScenes = [
        ...chapters.flatMap((ch) =>
          ch.descendants
            .filter((d) => d.node.nodeType === "scene")
            .map((d) => ({ id: d.node.id, parentId: d.node.parentId })),
        ),
        ...looseScenes.map((s) => ({ id: s.id, parentId: s.parentId })),
      ];
      const overNode = e.over;
      const rect = overNode?.rect ?? { top: 0, height: 60 };

      const target = computeSceneDropTarget(
        sceneId,
        overIdStr,
        pointerYRef.current,
        { top: rect.top, height: rect.height },
        orderedScenes,
        containerId,
      );
      if (target) {
        // Multi-select D&D: move entire selection if dragged scene is in selection
        if (selectedSceneIds.has(sceneId) && selectedSceneIds.size > 1) {
          const orderedSelected = flatOrder.filter((id) =>
            selectedSceneIds.has(id),
          );
          glog("DragEnd(scene)", "moveScenesToChapter (multi-select)", {
            sceneIds: orderedSelected,
            targetParentId: target.targetParentId,
          });
          void moveScenesToChapter(orderedSelected, target.targetParentId);
        } else {
          glog("DragEnd(scene)", "moveNode (single)", {
            sceneId,
            targetParentId: target.targetParentId,
            afterId: target.afterId,
          });
          void moveNode(sceneId, target.targetParentId, target.afterId);
        }
      } else {
        glog("DragEnd(scene)", "no target → no-op");
      }
      return;
    }

    if (kind === "column") {
      const folderId = activeIdStr.replace(/^column-/, "");
      const activeNode = nodes.find((n) => n.id === folderId);
      const activeParent = activeNode?.parentId ?? null;

      if (overIdStr.startsWith("scene-drop-")) {
        const sceneId = overIdStr.slice("scene-drop-".length);
        const sceneNode = nodes.find((n) => n.id === sceneId);
        if (sceneNode && sceneNode.parentId === activeParent) {
          const rect = e.over?.rect ?? { top: 0, height: 60 };
          const midY = rect.top + rect.height / 2;
          const insertBefore = pointerYRef.current <= midY;
          const siblings = nodes
            .filter((n) => n.parentId === activeParent && n.id !== folderId)
            .sort((a, b) => cmpKeys(a.sortOrder, b.sortOrder));
          let afterId: string | null | undefined;
          if (insertBefore) {
            const idx = siblings.findIndex((s) => s.id === sceneId);
            afterId = idx > 0 ? (siblings[idx - 1]?.id ?? null) : null;
          } else {
            afterId = sceneId;
          }
          glog("DragEnd(column)", "moveNode (sibling-scene path)", {
            folderId,
            activeParent,
            afterId,
            viaSceneId: sceneId,
          });
          void moveNode(folderId, activeParent, afterId);
          return;
        }
      }

      const folderParentMap: Record<string, string | null> = {};
      const orderedSiblings: Array<{ id: string; parentId: string | null }> =
        [];
      const sceneParentMap: Record<string, string | null> = {};
      const sortedNodes = [...nodes].sort((a, b) =>
        cmpKeys(a.sortOrder, b.sortOrder),
      );
      for (const n of sortedNodes) {
        if (n.nodeType === "folder") {
          folderParentMap[n.id] = n.parentId;
        }
        if (n.nodeType === "scene") sceneParentMap[n.id] = n.parentId;
        if (n.nodeType === "folder" || n.nodeType === "scene") {
          orderedSiblings.push({ id: n.id, parentId: n.parentId });
        }
      }
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
        glog("DragEnd(column)", "moveNode", {
          folderId,
          targetParentId: target.targetParentId,
          afterId: target.afterId,
        });
        void moveNode(folderId, target.targetParentId, target.afterId);
      } else {
        glog("DragEnd(column)", "no target → no-op");
      }
    }
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

  const nestedFolderIds = useMemo(() => {
    const ids: string[] = [];
    const walk = (parentId: string) => {
      for (const n of nodes) {
        if (n.parentId !== parentId || n.nodeType !== "folder") continue;
        ids.push(n.id);
        walk(n.id);
      }
    };
    for (const ch of chapters) walk(ch.folder.id);
    return ids;
  }, [nodes, chapters]);

  const allDisplayedScenes = useMemo(
    () => [
      ...chapters.flatMap((ch) =>
        ch.descendants
          .filter((d) => d.node.nodeType === "scene")
          .map((d) => d.node),
      ),
      ...looseScenes,
    ],
    [chapters, looseScenes],
  );

  const visibility = useGridCardVisibility({
    scenes: allDisplayedScenes,
    searchQuery,
    filter,
    pinsByScene,
  });

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={gridCollisionDetection}
      modifiers={[snapOverlayCenterToCursor]}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
    >
      <div
        ref={panelRef}
        className="relative flex h-full flex-col overflow-hidden"
        onClick={handlePanelClick}
      >
        <GridHeader
          containerId={containerId}
          projectId={projectId}
          chapterCount={totalChapters}
          nestedFolderIds={nestedFolderIds}
          onContainerChange={(id) => void setContainerId(projectId, id)}
          toolbarOpen={toolbarOpen}
          onToggleToolbar={() => setToolbarOpen(!toolbarOpen)}
          onManageLabels={() => setManageLabelsOpen(true)}
        />

        {toolbarOpen && <GridDisplayToolbar />}

        <GridContainerOutline containerId={containerId} />

        <ManageLabelsDialog
          open={manageLabelsOpen}
          onClose={() => setManageLabelsOpen(false)}
        />

        <div className="flex flex-1 gap-3 overflow-x-auto overflow-y-hidden p-4">
          {orderedColumns.map((entry) => {
            if (entry.kind === "chapter") {
              return (
                <GridColumn
                  key={entry.data.folder.id}
                  folder={entry.data.folder}
                  descendants={entry.data.descendants}
                  display={display}
                  visibility={visibility}
                  dropIndicator={dropIndicator}
                  columnDropIndicator={columnDropIndicator}
                  onRequestDeleteConfirm={handleDeleteScenes}
                  flatOrder={flatOrder}
                />
              );
            }
            if (entry.kind === "container") {
              return (
                <GridContainerSceneColumn
                  key={`container-${entry.folder.id}`}
                  folder={entry.folder}
                  scenes={entry.scenes}
                  display={display}
                  chapters={chapters.map((ch) => ch.folder)}
                  visibility={visibility}
                  dropIndicator={dropIndicator}
                  columnDropIndicator={columnDropIndicator}
                  onRequestDeleteConfirm={handleDeleteScenes}
                  flatOrder={flatOrder}
                />
              );
            }
            return (
              <GridLooseColumn
                key="loose"
                containerId={containerId}
                scenes={entry.scenes}
                display={display}
                chapters={chapters.map((ch) => ch.folder)}
                visibility={visibility}
                dropIndicator={dropIndicator}
                columnDropIndicator={columnDropIndicator}
                onRequestDeleteConfirm={handleDeleteScenes}
                flatOrder={flatOrder}
              />
            );
          })}

          {chapters.length === 0 && looseScenes.length === 0 && (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 px-4 text-center">
              <p className="text-sm text-muted-foreground">
                {t(
                  "grid.empty",
                  "章がありません。「章を追加」から始めましょう。",
                )}
              </p>
              <StructureTemplatePicker
                projectId={projectId}
                containerId={containerId}
              />
            </div>
          )}

          {(chapters.length > 0 || looseScenes.length > 0) && (
            <button
              type="button"
              onClick={() => void addChapter()}
              className="flex shrink-0 items-center justify-center self-stretch min-h-[8rem] w-14 rounded-lg border border-dashed border-border bg-transparent text-muted-foreground hover:text-foreground hover:bg-accent/30 hover:border-foreground/40 transition-colors font-mono text-[11px] tracking-widest"
              style={{ writingMode: "vertical-rl" }}
              title={t("grid.header.newChapter", "章を追加")}
            >
              ＋ {t("grid.header.newChapter", "章を追加")}
            </button>
          )}
        </div>

        <GridSelectionToolbar
          onMoveToChapter={(folderId) => {
            const ids = flatOrder.filter((id) => selectedSceneIds.has(id));
            if (ids.length === 0) return;
            clearSelection();
            void moveScenesToChapter(ids, folderId);
          }}
          onDelete={() => handleDeleteScenes(Array.from(selectedSceneIds))}
        />

        <GridStatusBar
          totalChapters={totalChapters}
          totalScenes={totalScenes}
          displayedScenes={allDisplayedScenes}
        />

        {deleteConfirmIds && (
          <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/80">
            <div className="rounded-lg border border-border bg-popover p-4 shadow-xl w-72">
              <p className="text-sm font-medium mb-1">
                {t("scenes.deleteConfirmTitle", "削除の確認")}
              </p>
              <p className="text-xs text-muted-foreground mb-4">
                {t(
                  "scenes.deleteConfirmBody",
                  "{{count}}件のシーンに本文またはsynopsisがあります。削除してもよいですか？",
                  { count: deleteConfirmIds.length },
                )}
              </p>
              <div className="flex gap-2 justify-end">
                <button
                  type="button"
                  className="rounded px-3 py-1 text-xs border border-border hover:bg-accent"
                  onClick={() => setDeleteConfirmIds(null)}
                >
                  {t("common.cancel", "キャンセル")}
                </button>
                <button
                  type="button"
                  className="rounded px-3 py-1 text-xs bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  onClick={() => {
                    const ids = deleteConfirmIds;
                    setDeleteConfirmIds(null);
                    clearSelection();
                    for (const id of ids) void deleteNode(id);
                  }}
                >
                  {t("common.deleteConfirm", "削除する")}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      <DragOverlay dropAnimation={null}>
        {activeDragNode && (
          <div
            className={`relative flex flex-col rounded-md border-2 border-primary bg-card shadow-xl ring-2 ring-primary/30 ${display.compactCards ? "w-56" : "w-80"}`}
            style={{ opacity: 0.92 }}
          >
            <div className="flex items-center gap-1 border-b px-3 py-2">
              <span className="flex-1 truncate text-sm font-semibold">
                {activeDragNode.title}
              </span>
            </div>
            {activeDragNode.synopsis && (
              <p className="line-clamp-2 px-3 py-1.5 text-[11px] text-muted-foreground">
                {activeDragNode.synopsis}
              </p>
            )}
            {activeDragIsMultiSelect && (
              <div className="absolute -right-2 -top-2 flex h-5 w-5 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-primary-foreground">
                {selectedSceneIds.size}
              </div>
            )}
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}
