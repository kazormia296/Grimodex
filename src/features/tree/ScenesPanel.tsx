import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { GripVertical } from "lucide-react";
import { DndContext, DragOverlay } from "@dnd-kit/core";
import type { DragMoveEvent } from "@dnd-kit/core";
import { useTreeStore } from "./treeStore";
import { useScenesDerivedData } from "./useScenesDerivedData";
import { useScenesDnd } from "./useScenesDnd";
import { useScenesKeyboard } from "./useScenesKeyboard";
import { useLabelStore } from "@/features/labels/labelStore";
import { ManageLabelsDialog } from "@/features/labels/ManageLabelsDialog";
import { ScenesPanelContext } from "./ScenesPanelContext";
import { useTabStore } from "@/features/editor/tabStore";
import { NodeIcon } from "./TreeNodeItem";
import { StructureTemplatePicker } from "@/features/grid/StructureTemplatePicker";
import { StatusDot } from "./StatusDot";
import { SynopsisArea } from "./SynopsisArea";
import type { NodeType } from "./treeStore";
import { motion, AnimatePresence } from "motion/react";
import { DURATIONS, EASINGS, useReducedMotion } from "@/lib/animation";
import { BottomDropZone } from "./BottomDropZone";
import { TreeRenderer } from "./TreeRenderer";
import { RootContextMenu } from "./RootContextMenu";
import { ScenesToolbar } from "./ScenesToolbar";
import { ScenesFilterBar } from "./ScenesFilterBar";
import { DeleteConfirmDialog } from "./DeleteConfirmDialog";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu";
import { useDropTarget } from "@/features/trash-bin/useDropTarget";

const DEFAULT_PROJECT_ID = "default-project";

export function ScenesPanel() {
  const { t } = useTranslation();
  const {
    nodes,
    activeSceneId,
    selectedIds,
    isLoading,
    expandedIds,
    filterQuery,
    viewMode,
    sortMode,
    statusFilter,
    labelFilter,
    charCounts,
    aiRatios,
    showWordCounts,
    showStatusDots,
    showLabelDots,
    showAiAttribution,
    autoRevealActiveScene,
    loadTree,
    createNode,
    expandAll,
    collapseAll,
    setFilterQuery,
    setStatusFilter,
    toggleLabelFilter,
    clearLabelFilter,
    setLabelFilter,
    toggleExpand,
    setActiveScene,
    moveNode,
    pendingRevealId,
    setPendingRenameId,
    projectId,
  } = useTreeStore();

  const reduced = useReducedMotion();
  const allLabels = useLabelStore((s) => s.labels);
  const nodeLabels = useLabelStore((s) => s.nodeLabels);

  // Drop dangling label IDs when labels are deleted/project changes
  useEffect(() => {
    if (labelFilter.length === 0) return;
    const validIds = new Set(allLabels.map((l) => l.id));
    const filtered = labelFilter.filter((id) => validIds.has(id));
    if (filtered.length !== labelFilter.length) {
      setLabelFilter(filtered);
    }
  }, [allLabels, labelFilter, setLabelFilter]);

  const filterRef = useRef<HTMLInputElement>(null);
  const treeRef = useRef<HTMLDivElement>(null);
  const [manageLabelsOpen, setManageLabelsOpen] = useState(false);
  const scenesPanelContextValue = useMemo(
    () => ({ openManageLabels: () => setManageLabelsOpen(true) }),
    [],
  );
  const [deleteConfirm, setDeleteConfirm] = useState<string[] | null>(null);

  useEffect(() => {
    loadTree(DEFAULT_PROJECT_ID).then(() => {
      const nodeIds = new Set(useTreeStore.getState().nodes.map((n) => n.id));
      useTabStore
        .getState()
        .loadTabState(nodeIds)
        .then(() => {
          useTabStore.getState().initAutoSave();
        });
    });
    return () => {
      useTabStore.getState().disposeAutoSave?.();
    };
  }, [loadTree]);

  const { childMap, nodeMap, nodeTotals, flatNodes } = useScenesDerivedData({
    nodes,
    sortMode,
    charCounts,
    expandedIds,
    filterQuery,
    statusFilter,
    labelFilter,
    nodeLabels,
  });

  // Auto-reveal active scene: scroll it into view when activeSceneId changes
  useEffect(() => {
    if (!autoRevealActiveScene || !treeRef.current) return;
    const el = treeRef.current.querySelector(
      `[data-node-id="${activeSceneId}"]`,
    );
    if (el) {
      el.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [activeSceneId, autoRevealActiveScene]);

  // Force-reveal when requested from outside (e.g. "Show in Scenes" tab context menu)
  useEffect(() => {
    if (!pendingRevealId || !treeRef.current) return;
    const id = pendingRevealId;
    useTreeStore.setState({ pendingRevealId: null });
    // Retry scroll until the element appears in the DOM (panel may still be mounting)
    let attempts = 0;
    const tryScroll = () => {
      const el = treeRef.current?.querySelector(`[data-node-id="${id}"]`);
      if (el) {
        el.scrollIntoView({ block: "center", behavior: "smooth" });
      } else if (attempts++ < 10) {
        requestAnimationFrame(tryScroll);
      }
    };
    requestAnimationFrame(tryScroll);
  }, [pendingRevealId]);

  const handleToggleAll = useCallback(() => {
    const folderIds = nodes
      .filter((n) => n.nodeType === "folder")
      .map((n) => n.id);
    const allExpanded =
      folderIds.length > 0 && folderIds.every((id) => expandedIds.includes(id));
    if (allExpanded) collapseAll();
    else expandAll();
  }, [nodes, expandedIds, expandAll, collapseAll]);

  const handleCreate = useCallback(
    (type: NodeType) => {
      // The DropdownMenu item uses e.preventDefault() to keep the menu open
      // so the user can create multiple items in a row.
      let parentId: string | null = null;
      const active = nodeMap[activeSceneId];
      if (active?.nodeType === "scene" || active?.nodeType === "note") {
        parentId = active.parentId;
      } else if (active?.nodeType === "folder") {
        parentId = active.id;
      }
      createNode({ nodeType: type, parentId, afterId: activeSceneId })
        .then((newNode) => {
          if (newNode.nodeType === "scene" || newNode.nodeType === "note") {
            useTabStore.getState().openPinned(newNode.id);
          }
        })
        .catch(() => {});
    },
    [createNode, activeSceneId, nodeMap],
  );

  const initiateDelete = useCallback(
    (ids: string[]) => {
      // Recursively collect all descendant IDs (inclusive)
      function collectAll(id: string): string[] {
        return [id, ...(childMap[id] ?? []).flatMap(collectAll)];
      }

      // Check all descendants (including folder contents) for content/synopsis
      const needsConfirm = ids.flatMap(collectAll).some((id) => {
        const node = nodeMap[id];
        if (!node || node.nodeType === "folder") return false;
        return (charCounts[id] ?? 0) > 0 || !!node.synopsis;
      });
      if (needsConfirm) {
        setDeleteConfirm(ids);
      } else {
        // Delete sequentially to avoid state race conditions
        ids
          .reduce(
            (p, id) => p.then(() => useTreeStore.getState().deleteNode(id)),
            Promise.resolve(),
          )
          .catch(() => {});
      }
    },
    [nodeMap, charCounts, childMap],
  );

  const handleTreeKeyDown = useScenesKeyboard({
    flatNodes,
    nodeMap,
    activeSceneId,
    selectedIds,
    expandedIds,
    setActiveScene,
    toggleExpand,
    setPendingRenameId,
    initiateDelete,
    treeRef,
    filterRef,
    editorPanelTitle: t("layout.panel.editor"),
  });

  const {
    sensors,
    draggingId,
    dropIndicator,
    onDragStart,
    onDragMove,
    onDragEnd,
    onDragOver,
  } = useScenesDnd({ nodeMap, childMap, flatNodes, moveNode });

  const activeNode = nodeMap[activeSceneId];

  // hooks の呼び出し順を一定に保つため早期 return より前に置く (React rules)。
  const trashDropRef = useDropTarget("scenes-panel", "scenes-panel");

  if (isLoading && nodes.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        {t("common.loading")}
      </div>
    );
  }

  const draggingNode = draggingId ? nodeMap[draggingId] : null;

  return (
    <ScenesPanelContext.Provider value={scenesPanelContextValue}>
      <DndContext
        sensors={sensors}
        onDragStart={onDragStart}
        onDragMove={(e) => {
          onDragMove(e);
          onDragOver(e as unknown as DragMoveEvent);
        }}
        onDragEnd={onDragEnd}
      >
        <div
          ref={trashDropRef}
          data-droptarget-id="scenes-panel"
          className="relative flex h-full flex-col data-[trash-drop-hover=true]:ring-2 data-[trash-drop-hover=true]:ring-primary/60"
        >
          <ScenesToolbar
            onCreate={handleCreate}
            onToggleAll={handleToggleAll}
          />
          <ScenesFilterBar
            filterRef={filterRef}
            filterQuery={filterQuery}
            setFilterQuery={setFilterQuery}
            statusFilter={statusFilter}
            setStatusFilter={setStatusFilter}
            labelFilter={labelFilter}
            toggleLabelFilter={toggleLabelFilter}
            clearLabelFilter={clearLabelFilter}
            allLabels={allLabels}
          />

          {/* Tree */}
          <ContextMenu>
            <ContextMenuTrigger asChild>
              <div
                ref={treeRef}
                className="flex-1 overflow-y-auto overflow-x-hidden py-1 outline-none"
                tabIndex={0}
                onKeyDown={handleTreeKeyDown}
              >
                {nodes.length === 0 ? (
                  <div
                    data-testid="scenes-empty-state"
                    className="flex h-full flex-col items-center justify-center gap-3 px-4 text-center"
                  >
                    <p className="text-xs text-muted-foreground">
                      {t("scenes.empty")}
                    </p>
                    <StructureTemplatePicker
                      projectId={projectId}
                      containerId={null}
                    />
                  </div>
                ) : (
                  <>
                    <ul className="list-none">
                      <TreeRenderer
                        parentId={null}
                        childMap={childMap}
                        nodeMap={nodeMap}
                        depth={0}
                        activeSceneId={activeSceneId}
                        selectedIds={selectedIds}
                        expandedIds={expandedIds}
                        filterQuery={filterQuery}
                        statusFilter={statusFilter}
                        labelFilter={labelFilter}
                        nodeLabels={nodeLabels}
                        viewMode={viewMode}
                        charCounts={charCounts}
                        aiRatios={aiRatios}
                        showWordCounts={showWordCounts}
                        showStatusDots={showStatusDots}
                        showLabelDots={showLabelDots}
                        showAiAttribution={showAiAttribution}
                        dropIndicator={dropIndicator}
                        nodeTotals={nodeTotals}
                        orderedNodes={flatNodes}
                      />
                    </ul>
                    <BottomDropZone />
                  </>
                )}
              </div>
            </ContextMenuTrigger>
            <RootContextMenu createNode={createNode} />
          </ContextMenu>

          {/* Synopsis area — hidden in Outline mode (synopsis is shown inline there) */}
          <AnimatePresence mode="wait">
            {viewMode !== "outline" && activeNode?.nodeType === "scene" && (
              <motion.div
                key="synopsis"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: 8 }}
                transition={
                  reduced
                    ? { duration: 0 }
                    : { duration: DURATIONS.fast, ease: EASINGS.easeOut }
                }
              >
                <SynopsisArea nodeId={activeSceneId} />
              </motion.div>
            )}
          </AnimatePresence>

          {deleteConfirm && (
            <DeleteConfirmDialog
              ids={deleteConfirm}
              childMap={childMap}
              nodeMap={nodeMap}
              charCounts={charCounts}
              onCancel={() => setDeleteConfirm(null)}
              onConfirm={() => setDeleteConfirm(null)}
            />
          )}
        </div>

        {/* Drag overlay — portaled to body to escape dockview's transform context
         which breaks position:fixed used by DragOverlay */}
        {createPortal(
          <DragOverlay dropAnimation={null}>
            {draggingNode && (
              <div className="flex items-center gap-0.5 rounded bg-background/80 px-1 py-0.5 text-sm shadow-lg ring-1 ring-primary">
                <span className="flex h-4 w-3 flex-shrink-0 items-center justify-center text-muted-foreground/50">
                  <GripVertical className="h-3 w-3" />
                </span>
                <span className="w-4 flex-shrink-0" />
                {draggingNode.nodeType === "scene" && showStatusDots ? (
                  <StatusDot status={draggingNode.status} />
                ) : (
                  <NodeIcon nodeType={draggingNode.nodeType} />
                )}
                <span className="block truncate text-xs leading-5">
                  {draggingNode.title}
                </span>
              </div>
            )}
          </DragOverlay>,
          document.body,
        )}

        <ManageLabelsDialog
          open={manageLabelsOpen}
          onClose={() => setManageLabelsOpen(false)}
        />
      </DndContext>
    </ScenesPanelContext.Provider>
  );
}
