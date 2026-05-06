import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import {
  Plus,
  ChevronsUpDown,
  MoreHorizontal,
  GripVertical,
  Undo2,
  Redo2,
  X,
} from "lucide-react";
import {
  DndContext,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  DragOverlay,
} from "@dnd-kit/core";
import type {
  DragStartEvent,
  DragEndEvent,
  DragMoveEvent,
} from "@dnd-kit/core";
import { cn } from "@/lib/utils";
import { useTreeStore } from "./treeStore";
import { useLabelStore } from "@/features/labels/labelStore";
import { ManageLabelsDialog } from "@/features/labels/ManageLabelsDialog";
import { ScenesPanelContext } from "./ScenesPanelContext";
import { resolveLabelColor } from "@/lib/labelPalette";
import { cmpKeys } from "./fractionalIndex";
import { useTreeHistoryStore } from "./treeHistoryStore";
import { useTabStore } from "@/features/editor/tabStore";
import { useLayoutStore } from "@/features/layout/layoutStore";
import { NodeIcon } from "./TreeNodeItem";
import { StructureTemplatePicker } from "@/features/grid/StructureTemplatePicker";
import { StatusDot } from "./StatusDot";
import { SynopsisArea } from "./SynopsisArea";
import type { TreeNodeData, NodeType } from "./treeStore";
import { canHaveChildren } from "./treeStore";
import type { DropIndicator } from "./TreeNodeItem";
import { motion, AnimatePresence } from "motion/react";
import { DURATIONS, EASINGS, useReducedMotion } from "@/lib/animation";
import { BottomDropZone, BOTTOM_DROP_ZONE_ID } from "./BottomDropZone";
import { TreeRenderer } from "./TreeRenderer";
import { PanelMenu } from "./PanelMenu";
import { RootContextMenu } from "./RootContextMenu";
import { flattenVisible } from "./treeVisibility";

const DEFAULT_PROJECT_ID = "default-project";

// ---- Main Panel ----
const CREATE_OPTIONS = [
  { type: "scene" as NodeType, labelKey: "scenes.newScene" },
  { type: "note" as NodeType, labelKey: "scenes.newNote" },
  null, // separator
  { type: "folder" as NodeType, labelKey: "scenes.newFolder" },
];

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
    setViewMode,
    setSortMode,
    setStatusFilter,
    toggleLabelFilter,
    clearLabelFilter,
    setLabelFilter,
    setShowWordCounts,
    setShowStatusDots,
    setShowLabelDots,
    setShowAiAttribution,
    setAutoRevealActiveScene,
    toggleExpand,
    setActiveScene,
    moveNode,
    pendingRevealId,
    setPendingRenameId,
    projectId,
  } = useTreeStore();

  const { canUndo, canRedo } = useTreeHistoryStore();
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
  const [showCreateMenu, setShowCreateMenu] = useState(false);
  const [showPanelMenu, setShowPanelMenu] = useState(false);
  const [manageLabelsOpen, setManageLabelsOpen] = useState(false);
  const scenesPanelContextValue = useMemo(
    () => ({ openManageLabels: () => setManageLabelsOpen(true) }),
    [],
  );
  const createBtnRef = useRef<HTMLButtonElement>(null);
  const panelMenuBtnRef = useRef<HTMLButtonElement>(null);
  const createMenuRef = useRef<HTMLDivElement>(null);
  const [createMenuPos, setCreateMenuPos] = useState<DOMRect | null>(null);
  const [panelMenuPos, setPanelMenuPos] = useState<DOMRect | null>(null);
  const pointerYRef = useRef(0);
  const [dropIndicator, setDropIndicator] = useState<DropIndicator | null>(
    null,
  );
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string[] | null>(null);
  const [rootContextMenu, setRootContextMenu] = useState<{
    x: number;
    y: number;
  } | null>(null);

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

  // Close create menu when clicking outside (excluding the create button itself)
  useEffect(() => {
    if (!showCreateMenu) return;
    function handleMouseDown(e: MouseEvent) {
      if (
        !createMenuRef.current?.contains(e.target as Node) &&
        !createBtnRef.current?.contains(e.target as Node)
      ) {
        setShowCreateMenu(false);
      }
    }
    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, [showCreateMenu]);

  const STATUS_SORT_ORDER: Record<string, number> = {
    outline: 0,
    draft: 1,
    complete: 2,
    revision: 3,
    final: 4,
  };

  const { childMap, nodeMap } = useMemo(() => {
    const nm: Record<string, TreeNodeData> = {};
    const cm: Record<string, string[]> = { root: [] };
    for (const n of nodes) nm[n.id] = n;

    // Base order: always sort by sortOrder first
    let sorted = [...nodes].sort((a, b) => cmpKeys(a.sortOrder, b.sortOrder));

    // Apply sortMode to leaf nodes within each parent
    if (sortMode !== "manual") {
      sorted = sorted.sort((a, b) => {
        // Keep containers in manual order; only sort leaves
        const aIsLeaf = a.nodeType === "scene" || a.nodeType === "note";
        const bIsLeaf = b.nodeType === "scene" || b.nodeType === "note";
        if (!aIsLeaf || !bIsLeaf || a.parentId !== b.parentId) {
          return cmpKeys(a.sortOrder, b.sortOrder);
        }
        if (sortMode === "title") {
          return a.title.localeCompare(b.title, "ja");
        }
        if (sortMode === "wordcount") {
          return (charCounts[b.id] ?? 0) - (charCounts[a.id] ?? 0);
        }
        if (sortMode === "status") {
          return (
            (STATUS_SORT_ORDER[a.status ?? "outline"] ?? 0) -
            (STATUS_SORT_ORDER[b.status ?? "outline"] ?? 0)
          );
        }
        return 0;
      });
    }

    for (const n of sorted) {
      const key = n.parentId ?? "root";
      if (!cm[key]) cm[key] = [];
      cm[key].push(n.id);
    }
    return { childMap: cm, nodeMap: nm };
  }, [nodes, sortMode, charCounts]);

  // Compute container word count totals (sum of descendant scenes/notes)
  const nodeTotals = useMemo(() => {
    const totals: Record<string, number> = {};
    function sumDescendants(id: string): number {
      const node = nodeMap[id];
      if (!node) return 0;
      if (node.nodeType === "scene" || node.nodeType === "note") {
        return charCounts[id] ?? 0;
      }
      let total = 0;
      for (const childId of childMap[id] ?? []) {
        total += sumDescendants(childId);
      }
      totals[id] = total;
      return total;
    }
    for (const id of childMap["root"] ?? []) sumDescendants(id);
    return totals;
  }, [nodeMap, childMap, charCounts]);

  // Flat visible list for keyboard navigation
  const flatNodes = useMemo(
    () =>
      flattenVisible(
        null,
        childMap,
        nodeMap,
        expandedIds,
        filterQuery.toLowerCase(),
        statusFilter,
        labelFilter,
        nodeLabels,
      ),
    [
      childMap,
      nodeMap,
      expandedIds,
      filterQuery,
      statusFilter,
      labelFilter,
      nodeLabels,
    ],
  );

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
      // Keep the menu open so the user can create multiple items in a row
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

  function focusEditorPanel() {
    const { dockviewApi } = useLayoutStore.getState();
    if (!dockviewApi) return;
    const panel = dockviewApi.getPanel("editor");
    if (panel) {
      panel.api.setActive();
    } else {
      dockviewApi.addPanel({
        id: "editor",
        component: "editor",
        title: t("layout.panel.editor"),
      });
    }
  }

  // Keyboard navigation
  const handleTreeKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // Let input elements handle their own arrow/delete keys
      if ((e.target as HTMLElement).tagName === "INPUT") return;

      const idx = flatNodes.findIndex((n) => n.id === activeSceneId);
      if (e.key === "ArrowDown") {
        e.preventDefault();
        const next = flatNodes[idx + 1];
        if (next) {
          if (next.nodeType === "scene" || next.nodeType === "note") {
            useTabStore.getState().openPreview(next.id);
            focusEditorPanel();
          }
          useTreeStore.getState().selectNode(next.id, false);
        }
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        const prev = flatNodes[idx - 1];
        if (prev) {
          if (prev.nodeType === "scene" || prev.nodeType === "note") {
            useTabStore.getState().openPreview(prev.id);
            focusEditorPanel();
          }
          useTreeStore.getState().selectNode(prev.id, false);
        }
      } else if (e.key === " ") {
        e.preventDefault();
        const cur = nodeMap[activeSceneId];
        if (cur && (cur.nodeType === "scene" || cur.nodeType === "note")) {
          useTabStore.getState().openPreview(cur.id);
          focusEditorPanel();
        }
      } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        // Ctrl+Enter: open in secondary group (split view)
        e.preventDefault();
        const cur = nodeMap[activeSceneId];
        if (cur && (cur.nodeType === "scene" || cur.nodeType === "note")) {
          useTabStore.getState().openInSecondaryGroup(cur.id);
          setActiveScene(cur.id);
          focusEditorPanel();
        }
      } else if (e.key === "Enter") {
        e.preventDefault();
        const cur = nodeMap[activeSceneId];
        if (cur && (cur.nodeType === "scene" || cur.nodeType === "note")) {
          useTabStore.getState().openPinned(cur.id);
          setActiveScene(cur.id);
          focusEditorPanel();
        } else if (cur) {
          toggleExpand(cur.id);
        }
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        const cur = nodeMap[activeSceneId];
        if (cur && cur.nodeType === "folder") {
          if (!expandedIds.includes(activeSceneId)) toggleExpand(activeSceneId);
        }
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        const cur = nodeMap[activeSceneId];
        if (
          cur &&
          cur.nodeType === "folder" &&
          expandedIds.includes(activeSceneId)
        ) {
          toggleExpand(activeSceneId);
        } else if (cur?.parentId) {
          setActiveScene(cur.parentId);
        }
      } else if (e.key === "F2") {
        e.preventDefault();
        if (activeSceneId) setPendingRenameId(activeSceneId);
      } else if (e.key === "Delete" || e.key === "Backspace") {
        if (document.activeElement === treeRef.current) {
          e.preventDefault();
          const idsToDelete =
            selectedIds.length > 0
              ? selectedIds
              : activeSceneId
                ? [activeSceneId]
                : [];
          if (idsToDelete.length > 0) {
            initiateDelete(idsToDelete);
          }
        }
      } else if (e.key === "f" && e.ctrlKey) {
        e.preventDefault();
        filterRef.current?.focus();
      } else if (e.key === "z" && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
        e.preventDefault();
        useTreeHistoryStore
          .getState()
          .undo()
          .catch(() => {});
      } else if (e.key === "z" && (e.ctrlKey || e.metaKey) && e.shiftKey) {
        e.preventDefault();
        useTreeHistoryStore
          .getState()
          .redo()
          .catch(() => {});
      }
    },
    [
      flatNodes,
      activeSceneId,
      nodeMap,
      expandedIds,
      setActiveScene,
      toggleExpand,
      selectedIds,
      initiateDelete,
    ],
  );

  // D&D sensors
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor),
  );

  const onDragStart = useCallback(({ active }: DragStartEvent) => {
    setDraggingId(active.id as string);
  }, []);

  const onDragMove = useCallback(({ activatorEvent, delta }: DragMoveEvent) => {
    if (activatorEvent instanceof PointerEvent) {
      pointerYRef.current = activatorEvent.clientY + delta.y;
    }
  }, []);

  const onDragEnd = useCallback(
    ({ active, over }: DragEndEvent) => {
      setDraggingId(null);
      setDropIndicator(null);
      if (active.id === over?.id) return;

      const activeId = active.id as string;
      const activeNode = nodeMap[activeId];
      if (!activeNode) return;

      if (!over) return;

      const rawOverId = String(over.id);

      // Handle drop on bottom zone → after last visible item
      if (rawOverId === BOTTOM_DROP_ZONE_ID) {
        const lastNode = flatNodes
          .filter((n) => n.id !== activeId)
          .slice(-1)[0];
        if (!lastNode) return;
        const parentNode = lastNode.parentId
          ? nodeMap[lastNode.parentId]
          : null;
        if (parentNode && !canHaveChildren(parentNode.nodeType)) return;
        moveNode(activeId, lastNode.parentId, lastNode.id).catch(() => {});
        return;
      }

      // over.id is like "drop-{nodeId}"
      const overId = rawOverId.replace(/^drop-/, "");
      if (activeId === overId) return;

      const overNode = nodeMap[overId];
      if (!overNode) return;

      // Compute drop position from pointer Y vs over element rect
      const overRect = over.rect;
      const pointerY = pointerYRef.current;
      let position: "before" | "after" | "inside" = "after";
      if (overRect) {
        const isContainer = overNode.nodeType === "folder";
        const relY = pointerY - overRect.top;
        const h = overRect.height;
        if (isContainer) {
          if (relY < h * 0.25) position = "before";
          else if (relY > h * 0.75) position = "after";
          else position = "inside";
        } else {
          position = relY < h / 2 ? "before" : "after";
        }
      }

      // Determine newParentId and afterId
      let newParentId: string | null;
      let afterId: string | null;
      if (position === "inside") {
        newParentId = overId;
        afterId = null;
      } else {
        newParentId = overNode.parentId;
        if (position === "after") {
          afterId = overId;
        } else {
          // before: find the sibling before overId
          const siblings = childMap[newParentId ?? "root"] ?? [];
          const idx = siblings.indexOf(overId);
          afterId = idx > 0 ? siblings[idx - 1] : null;
        }
      }

      // Validate: only folders can receive children
      const parentNode = newParentId ? nodeMap[newParentId] : null;
      if (parentNode && !canHaveChildren(parentNode.nodeType)) return;

      // Multi-select: move all selected nodes if the dragged node is in the selection
      const { selectedIds } = useTreeStore.getState();
      if (selectedIds.includes(activeId) && selectedIds.length > 1) {
        // Sort selected nodes by current sortOrder to preserve relative order
        const selectedNodes = selectedIds
          .map((id) => nodeMap[id])
          .filter(Boolean)
          .sort((a, b) =>
            cmpKeys(a!.sortOrder, b!.sortOrder),
          ) as TreeNodeData[];
        let prevAfterId = afterId;
        for (const selNode of selectedNodes) {
          moveNode(selNode.id, newParentId, prevAfterId).catch(() => {});
          prevAfterId = selNode.id;
        }
      } else {
        moveNode(activeId, newParentId, afterId).catch(() => {});
      }
    },
    [nodeMap, childMap, moveNode, flatNodes],
  );

  // Update drop indicator during drag
  const onDragOver = useCallback(
    ({ active, over }: DragMoveEvent) => {
      if (!over) {
        setDropIndicator(null);
        return;
      }

      const rawOverId = String(over.id);

      // Bottom drop zone → "after" on last visible item
      if (rawOverId === BOTTOM_DROP_ZONE_ID) {
        const lastNode = flatNodes
          .filter((n) => n.id !== String(active.id))
          .slice(-1)[0];
        if (lastNode) {
          setDropIndicator({ nodeId: lastNode.id, position: "after" });
        } else {
          setDropIndicator(null);
        }
        return;
      }

      const overId = rawOverId.replace(/^drop-/, "");
      if (active.id === overId) {
        setDropIndicator(null);
        return;
      }
      const overNode = nodeMap[overId];
      if (!overNode) {
        setDropIndicator(null);
        return;
      }

      const overRect = over.rect;
      if (!overRect) {
        setDropIndicator(null);
        return;
      }
      const pointerY = pointerYRef.current;
      const isContainer = overNode.nodeType === "folder";
      const relY = pointerY - overRect.top;
      const h = overRect.height;
      let position: "before" | "after" | "inside";
      if (isContainer) {
        if (relY < h * 0.25) position = "before";
        else if (relY > h * 0.75) position = "after";
        else position = "inside";
      } else {
        position = relY < h / 2 ? "before" : "after";
      }
      setDropIndicator({ nodeId: overId, position });
    },
    [nodeMap, flatNodes],
  );

  const activeNode = nodeMap[activeSceneId];

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
        <div className="relative flex h-full flex-col">
          {/* Toolbar */}
          <div className="flex flex-shrink-0 items-center justify-between border-b border-border px-2 py-1.5">
            <span className="text-xs font-semibold text-foreground">
              Scenes
            </span>
            <div className="flex items-center gap-0.5">
              {/* Create button */}
              <button
                ref={createBtnRef}
                type="button"
                title={t("scenes.create")}
                onClick={() => {
                  if (!showCreateMenu && createBtnRef.current) {
                    setCreateMenuPos(
                      createBtnRef.current.getBoundingClientRect(),
                    );
                  }
                  setShowCreateMenu((v) => !v);
                }}
                className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground active:scale-[0.97] transition-transform duration-75"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>

              {/* Undo */}
              <button
                type="button"
                title={t("scenes.undo")}
                disabled={!canUndo}
                onClick={() =>
                  useTreeHistoryStore
                    .getState()
                    .undo()
                    .catch(() => {})
                }
                className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-30 active:scale-[0.97] transition-transform duration-75"
              >
                <Undo2 className="h-3.5 w-3.5" />
              </button>

              {/* Redo */}
              <button
                type="button"
                title={t("scenes.redo")}
                disabled={!canRedo}
                onClick={() =>
                  useTreeHistoryStore
                    .getState()
                    .redo()
                    .catch(() => {})
                }
                className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-30 active:scale-[0.97] transition-transform duration-75"
              >
                <Redo2 className="h-3.5 w-3.5" />
              </button>

              {/* Expand/collapse toggle */}
              <button
                type="button"
                title={t("scenes.expandCollapse")}
                onClick={handleToggleAll}
                className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground active:scale-[0.97] transition-transform duration-75"
              >
                <ChevronsUpDown className="h-3.5 w-3.5" />
              </button>

              {/* Panel menu */}
              <button
                ref={panelMenuBtnRef}
                type="button"
                title={t("scenes.panelMenu")}
                onClick={() => {
                  if (!showPanelMenu && panelMenuBtnRef.current) {
                    setPanelMenuPos(
                      panelMenuBtnRef.current.getBoundingClientRect(),
                    );
                  }
                  setShowPanelMenu((v) => !v);
                }}
                className={cn(
                  "flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground active:scale-[0.97] transition-transform duration-75",
                  showPanelMenu && "bg-accent text-foreground",
                )}
              >
                <MoreHorizontal className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>

          {/* Filter input */}
          <div className="flex-shrink-0 border-b border-border px-2 py-1">
            <input
              ref={filterRef}
              type="text"
              value={filterQuery}
              onChange={(e) => setFilterQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setFilterQuery("");
              }}
              placeholder={t("scenes.filterPlaceholder")}
              className="w-full rounded border border-border bg-background px-2 py-0.5 text-xs text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>

          {/* Active filter chips */}
          {(statusFilter || labelFilter.length > 0) && (
            <div className="flex-shrink-0 flex flex-wrap items-center gap-1 border-b border-border px-2 py-1">
              {statusFilter && (
                <button
                  type="button"
                  onClick={() => setStatusFilter(null)}
                  title={t("scenes.removeFilter")}
                  className="flex items-center gap-1 rounded-full border border-border bg-accent/50 px-1.5 py-0.5 text-[10px] text-foreground hover:bg-accent"
                >
                  <StatusDot status={statusFilter} />
                  <span>
                    {statusFilter.charAt(0).toUpperCase() +
                      statusFilter.slice(1)}
                  </span>
                  <X className="h-2.5 w-2.5" />
                </button>
              )}
              {labelFilter.map((id) => {
                const label = allLabels.find((l) => l.id === id);
                if (!label) return null;
                const color = resolveLabelColor(label.color);
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => toggleLabelFilter(id)}
                    title={t("scenes.removeFilter")}
                    className="flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px]"
                    style={{
                      borderColor: color,
                      backgroundColor: `${color}22`,
                      color,
                    }}
                  >
                    <span
                      className="h-2 w-2 rounded-full"
                      style={{ backgroundColor: color }}
                    />
                    <span className="truncate max-w-[100px]">{label.name}</span>
                    <X className="h-2.5 w-2.5" />
                  </button>
                );
              })}
              <button
                type="button"
                onClick={() => {
                  setStatusFilter(null);
                  clearLabelFilter();
                }}
                className="ml-auto text-[10px] text-primary hover:underline"
              >
                {t("scenes.clearFilters")}
              </button>
            </div>
          )}

          {/* Tree */}
          <div
            ref={treeRef}
            className="flex-1 overflow-y-auto overflow-x-hidden py-1 outline-none"
            tabIndex={0}
            onKeyDown={handleTreeKeyDown}
            onContextMenu={(e) => {
              e.preventDefault();
              setRootContextMenu({ x: e.clientX, y: e.clientY });
            }}
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

          {rootContextMenu && (
            <RootContextMenu
              x={rootContextMenu.x}
              y={rootContextMenu.y}
              onClose={() => setRootContextMenu(null)}
              createNode={createNode}
            />
          )}

          {deleteConfirm && (
            <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/80">
              <div className="rounded-lg border border-border bg-popover p-4 shadow-xl w-72">
                <p className="text-sm font-medium mb-1">
                  {t("scenes.deleteConfirmTitle")}
                </p>
                <p className="text-xs text-muted-foreground mb-4">
                  {t("scenes.deleteConfirmBody", {
                    count: (() => {
                      function collectAll(id: string): string[] {
                        return [
                          id,
                          ...(childMap[id] ?? []).flatMap(collectAll),
                        ];
                      }
                      return deleteConfirm.flatMap(collectAll).filter((id) => {
                        const node = nodeMap[id];
                        if (!node || node.nodeType === "folder") return false;
                        return (charCounts[id] ?? 0) > 0 || !!node.synopsis;
                      }).length;
                    })(),
                  })}
                </p>
                <div className="flex gap-2 justify-end">
                  <button
                    type="button"
                    className="rounded px-3 py-1 text-xs border border-border hover:bg-accent"
                    onClick={() => setDeleteConfirm(null)}
                  >
                    {t("common.cancel")}
                  </button>
                  <button
                    type="button"
                    className="rounded px-3 py-1 text-xs bg-destructive text-destructive-foreground hover:bg-destructive/90"
                    onClick={() => {
                      const ids = deleteConfirm;
                      setDeleteConfirm(null);
                      ids
                        .reduce(
                          (p, id) =>
                            p.then(() =>
                              useTreeStore.getState().deleteNode(id),
                            ),
                          Promise.resolve(),
                        )
                        .catch(() => {});
                    }}
                  >
                    {t("common.deleteConfirm")}
                  </button>
                </div>
              </div>
            </div>
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

        {/* Create menu portal — escapes dockview stacking context */}
        {showCreateMenu &&
          createMenuPos &&
          createPortal(
            <div
              ref={createMenuRef}
              style={{
                position: "fixed",
                top: createMenuPos.bottom + 2,
                right: window.innerWidth - createMenuPos.right,
                zIndex: 9999,
              }}
              className="min-w-[140px] rounded-md border border-border bg-popover py-1 shadow-md"
            >
              {CREATE_OPTIONS.map((opt, i) =>
                opt === null ? (
                  <div key={i} className="my-1 border-t border-border" />
                ) : (
                  <button
                    key={opt.type}
                    type="button"
                    className="flex w-full px-3 py-1.5 text-left text-xs text-foreground hover:bg-accent"
                    onClick={() => handleCreate(opt.type)}
                  >
                    {t(opt.labelKey)}
                  </button>
                ),
              )}
            </div>,
            document.body,
          )}

        {/* Panel menu portal — escapes dockview stacking context */}
        {showPanelMenu &&
          panelMenuPos &&
          createPortal(
            <div
              style={{
                position: "fixed",
                top: panelMenuPos.bottom + 2,
                right: window.innerWidth - panelMenuPos.right,
                zIndex: 9999,
              }}
            >
              <PanelMenu
                viewMode={viewMode}
                setViewMode={setViewMode}
                sortMode={sortMode}
                setSortMode={setSortMode}
                statusFilter={statusFilter}
                setStatusFilter={setStatusFilter}
                labelFilter={labelFilter}
                toggleLabelFilter={toggleLabelFilter}
                clearLabelFilter={clearLabelFilter}
                showWordCounts={showWordCounts}
                setShowWordCounts={setShowWordCounts}
                showStatusDots={showStatusDots}
                setShowStatusDots={setShowStatusDots}
                showLabelDots={showLabelDots}
                setShowLabelDots={setShowLabelDots}
                showAiAttribution={showAiAttribution}
                setShowAiAttribution={setShowAiAttribution}
                autoRevealActiveScene={autoRevealActiveScene}
                setAutoRevealActiveScene={setAutoRevealActiveScene}
                onClose={() => setShowPanelMenu(false)}
                excludedRef={panelMenuBtnRef}
              />
            </div>,
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
