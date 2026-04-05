import {
  useEffect,
  useRef,
  useState,
  useCallback,
  useMemo,
  Fragment,
} from "react";
import { createPortal } from "react-dom";
import {
  Plus,
  ChevronsUpDown,
  MoreHorizontal,
  Check,
  GripVertical,
  Undo2,
  Redo2,
} from "lucide-react";
import {
  DndContext,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  DragOverlay,
  useDroppable,
} from "@dnd-kit/core";
import type {
  DragStartEvent,
  DragEndEvent,
  DragMoveEvent,
} from "@dnd-kit/core";
import { cn } from "@/lib/utils";
import { useTreeStore } from "./treeStore";
import { useTreeHistoryStore } from "./treeHistoryStore";
import { useTabStore } from "@/features/editor/tabStore";
import { useLayoutStore } from "@/features/layout/layoutStore";
import { TreeNodeItem, NodeIcon } from "./TreeNodeItem";
import { StatusDot } from "./StatusDot";
import { SynopsisArea } from "./SynopsisArea";
import type { TreeNodeData, NodeType } from "./treeStore";
import { canHaveChildren } from "./treeStore";
import type { DropIndicator } from "./TreeNodeItem";

const DEFAULT_PROJECT_ID = "default-project";
const BOTTOM_DROP_ZONE_ID = "drop-bottom-zone";

function BottomDropZone() {
  const { setNodeRef } = useDroppable({ id: BOTTOM_DROP_ZONE_ID });
  return <div ref={setNodeRef} className="min-h-6" />;
}

// ---- Utility: flat visible node list (for keyboard nav) ----
function flattenVisible(
  parentId: string | null,
  childMap: Record<string, string[]>,
  nodeMap: Record<string, TreeNodeData>,
  expandedIds: string[],
  query: string,
  statusFilter?: string | null,
): TreeNodeData[] {
  const ids = childMap[parentId ?? "root"] ?? [];
  const result: TreeNodeData[] = [];
  for (const id of ids) {
    const node = nodeMap[id];
    if (!node) continue;
    if (!isNodeVisible(node, childMap, nodeMap, query, statusFilter)) continue;
    result.push(node);
    const isContainer = node.nodeType === "folder";
    const expanded =
      expandedIds.includes(id) ||
      (!!query && isNodeVisible(node, childMap, nodeMap, query, statusFilter));
    if (isContainer && expanded) {
      result.push(
        ...flattenVisible(
          id,
          childMap,
          nodeMap,
          expandedIds,
          query,
          statusFilter,
        ),
      );
    }
  }
  return result;
}

function hasMatchingDescendant(
  id: string,
  childMap: Record<string, string[]>,
  nodeMap: Record<string, TreeNodeData>,
  query: string,
): boolean {
  for (const childId of childMap[id] ?? []) {
    const child = nodeMap[childId];
    if (child && child.title.toLowerCase().includes(query)) return true;
    if (hasMatchingDescendant(childId, childMap, nodeMap, query)) return true;
  }
  return false;
}

function isNodeVisible(
  node: TreeNodeData,
  childMap: Record<string, string[]>,
  nodeMap: Record<string, TreeNodeData>,
  query: string,
  statusFilter?: string | null,
): boolean {
  // Status filter: hide scene nodes whose status doesn't match
  if (
    statusFilter &&
    node.nodeType === "scene" &&
    node.status !== statusFilter
  ) {
    return false;
  }
  if (!query) return true;
  if (node.title.toLowerCase().includes(query)) return true;
  return hasMatchingDescendant(node.id, childMap, nodeMap, query);
}

// ---- Tree renderer (recursive) ----
interface TreeRendererProps {
  parentId: string | null;
  childMap: Record<string, string[]>;
  nodeMap: Record<string, TreeNodeData>;
  depth: number;
  activeSceneId: string;
  selectedIds: string[];
  expandedIds: string[];
  filterQuery: string;
  statusFilter?: string | null;
  viewMode: string;
  charCounts: Record<string, number>;
  aiRatios: Record<string, number>;
  showWordCounts: boolean;
  showStatusDots: boolean;
  showAiAttribution: boolean;
  dropIndicator: DropIndicator | null;
  nodeTotals: Record<string, number>;
  orderedNodes: TreeNodeData[];
}

function TreeRenderer({
  parentId,
  childMap,
  nodeMap,
  depth,
  activeSceneId,
  selectedIds,
  expandedIds,
  filterQuery,
  statusFilter,
  viewMode,
  charCounts,
  aiRatios,
  showWordCounts,
  showStatusDots,
  showAiAttribution,
  dropIndicator,
  nodeTotals,
  orderedNodes,
}: TreeRendererProps) {
  const ids = childMap[parentId ?? "root"] ?? [];
  const query = filterQuery.toLowerCase();

  return (
    <>
      {ids.map((id) => {
        const node = nodeMap[id];
        if (!node) return null;
        const visible = isNodeVisible(
          node,
          childMap,
          nodeMap,
          query,
          statusFilter,
        );
        const isExpanded = expandedIds.includes(id) || (!!query && visible);
        const isLeaf = node.nodeType === "scene" || node.nodeType === "note";
        const count = isLeaf ? (charCounts[id] ?? 0) : (nodeTotals[id] ?? 0);
        return (
          <Fragment key={id}>
            <TreeNodeItem
              node={node}
              depth={depth}
              isActive={node.id === activeSceneId}
              isSelected={selectedIds.includes(id)}
              isExpanded={isExpanded}
              isVisible={visible}
              charCount={count}
              showWordCounts={showWordCounts}
              showStatusDots={showStatusDots}
              showAiAttribution={showAiAttribution}
              aiRatio={aiRatios[id] ?? 0}
              dropIndicator={dropIndicator}
              orderedNodes={orderedNodes}
              viewMode={viewMode}
            >
              <TreeRenderer
                parentId={id}
                childMap={childMap}
                nodeMap={nodeMap}
                depth={depth + 1}
                activeSceneId={activeSceneId}
                selectedIds={selectedIds}
                expandedIds={expandedIds}
                filterQuery={filterQuery}
                statusFilter={statusFilter}
                viewMode={viewMode}
                charCounts={charCounts}
                aiRatios={aiRatios}
                showWordCounts={showWordCounts}
                showStatusDots={showStatusDots}
                showAiAttribution={showAiAttribution}
                dropIndicator={dropIndicator}
                nodeTotals={nodeTotals}
                orderedNodes={orderedNodes}
              />
            </TreeNodeItem>
            {viewMode === "outline" && node.nodeType === "scene" && visible && (
              <li
                className="list-none text-[11px] text-muted-foreground"
                style={{
                  paddingLeft: `${depth * 12 + 58}px`,
                  paddingBottom: 4,
                }}
              >
                {node.synopsis ?? (
                  <span className="italic opacity-40">synopsis なし</span>
                )}
              </li>
            )}
          </Fragment>
        );
      })}
    </>
  );
}

// ---- Panel menu ----
interface PanelMenuProps {
  viewMode: string;
  setViewMode: (m: "tree" | "outline") => void;
  sortMode: string;
  setSortMode: (m: "manual" | "title" | "wordcount" | "status") => void;
  statusFilter: string | null;
  setStatusFilter: (
    s: "outline" | "draft" | "complete" | "revision" | "final" | null,
  ) => void;
  showWordCounts: boolean;
  setShowWordCounts: (v: boolean) => void;
  showStatusDots: boolean;
  setShowStatusDots: (v: boolean) => void;
  showAiAttribution: boolean;
  setShowAiAttribution: (v: boolean) => void;
  autoRevealActiveScene: boolean;
  setAutoRevealActiveScene: (v: boolean) => void;
  onClose: () => void;
  excludedRef?: React.RefObject<HTMLButtonElement | null>;
}

const SORT_LABELS: Record<string, string> = {
  manual: "手動",
  title: "タイトル順",
  wordcount: "文字数順",
  status: "ステータス順",
};

const STATUS_FILTER_OPTIONS: Array<{
  value: "outline" | "draft" | "complete" | "revision" | "final" | null;
  label: string;
}> = [
  { value: null, label: "すべて表示" },
  { value: "outline", label: "Outline" },
  { value: "draft", label: "Draft" },
  { value: "complete", label: "Complete" },
  { value: "revision", label: "Revision" },
  { value: "final", label: "Final" },
];

function PanelMenu({
  viewMode,
  setViewMode,
  sortMode,
  setSortMode,
  statusFilter,
  setStatusFilter,
  showWordCounts,
  setShowWordCounts,
  showStatusDots,
  setShowStatusDots,
  showAiAttribution,
  setShowAiAttribution,
  autoRevealActiveScene,
  setAutoRevealActiveScene,
  onClose,
  excludedRef,
}: PanelMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function close(e: MouseEvent) {
      if (
        !ref.current?.contains(e.target as Node) &&
        !excludedRef?.current?.contains(e.target as Node)
      ) {
        onClose();
      }
    }
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [onClose, excludedRef]);

  function radioItem<T extends string | null>(
    value: T,
    current: string | null,
    label: string,
    onSelect: (v: T) => void,
  ) {
    return (
      <button
        key={String(value)}
        type="button"
        onClick={() => {
          onSelect(value);
        }}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-xs hover:bg-accent"
      >
        {current === value ? (
          <Check className="h-3 w-3" />
        ) : (
          <span className="w-3" />
        )}
        {label}
      </button>
    );
  }

  function checkItem(
    label: string,
    checked: boolean,
    onChange: (v: boolean) => void,
  ) {
    return (
      <button
        type="button"
        onClick={() => onChange(!checked)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-xs hover:bg-accent"
      >
        {checked ? <Check className="h-3 w-3" /> : <span className="w-3" />}
        {label}
      </button>
    );
  }

  return (
    <div
      ref={ref}
      className="min-w-[180px] rounded-md border border-border bg-popover py-1 shadow-md"
    >
      <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        View
      </div>
      {radioItem("tree", viewMode, "Tree", setViewMode as (v: string) => void)}
      {radioItem(
        "outline",
        viewMode,
        "Outline",
        setViewMode as (v: string) => void,
      )}
      <div className="my-1 border-t border-border" />
      <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        Sort by
      </div>
      {(["manual", "title", "wordcount", "status"] as const).map((m) =>
        radioItem(m, sortMode, SORT_LABELS[m], setSortMode),
      )}
      <div className="my-1 border-t border-border" />
      <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        Filter by status
      </div>
      {STATUS_FILTER_OPTIONS.map(({ value, label }) =>
        radioItem(value, statusFilter, label, setStatusFilter),
      )}
      <div className="my-1 border-t border-border" />
      <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        Show
      </div>
      {checkItem("文字数", showWordCounts, setShowWordCounts)}
      {checkItem("ステータスドット", showStatusDots, setShowStatusDots)}
      {checkItem("AI帰属バッジ", showAiAttribution, setShowAiAttribution)}
      {checkItem(
        "アクティブを自動表示",
        autoRevealActiveScene,
        setAutoRevealActiveScene,
      )}
    </div>
  );
}

// ---- Main Panel ----
const CREATE_OPTIONS = [
  { type: "scene" as NodeType, label: "New scene" },
  { type: "note" as NodeType, label: "New note" },
  null, // separator
  { type: "folder" as NodeType, label: "New folder" },
];

export function ScenesPanel() {
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
    charCounts,
    aiRatios,
    showWordCounts,
    showStatusDots,
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
    setShowWordCounts,
    setShowStatusDots,
    setShowAiAttribution,
    setAutoRevealActiveScene,
    toggleExpand,
    setActiveScene,
    moveNode,
  } = useTreeStore();

  const { canUndo, canRedo } = useTreeHistoryStore();

  const filterRef = useRef<HTMLInputElement>(null);
  const treeRef = useRef<HTMLDivElement>(null);
  const [showCreateMenu, setShowCreateMenu] = useState(false);
  const [showPanelMenu, setShowPanelMenu] = useState(false);
  const createBtnRef = useRef<HTMLButtonElement>(null);
  const panelMenuBtnRef = useRef<HTMLButtonElement>(null);
  const createMenuRef = useRef<HTMLDivElement>(null);
  const [createMenuPos, setCreateMenuPos] = useState<DOMRect | null>(null);
  const [panelMenuPos, setPanelMenuPos] = useState<DOMRect | null>(null);
  const allExpandedRef = useRef(false);
  const pointerYRef = useRef(0);
  const [dropIndicator, setDropIndicator] = useState<DropIndicator | null>(
    null,
  );
  const [draggingId, setDraggingId] = useState<string | null>(null);
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
    let sorted = [...nodes].sort((a, b) => a.sortOrder - b.sortOrder);

    // Apply sortMode to leaf nodes within each parent
    if (sortMode !== "manual") {
      sorted = sorted.sort((a, b) => {
        // Keep containers in manual order; only sort leaves
        const aIsLeaf = a.nodeType === "scene" || a.nodeType === "note";
        const bIsLeaf = b.nodeType === "scene" || b.nodeType === "note";
        if (!aIsLeaf || !bIsLeaf || a.parentId !== b.parentId) {
          return a.sortOrder - b.sortOrder;
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
      ),
    [childMap, nodeMap, expandedIds, filterQuery, statusFilter],
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

  const handleToggleAll = useCallback(() => {
    if (allExpandedRef.current) collapseAll();
    else expandAll();
    allExpandedRef.current = !allExpandedRef.current;
  }, [expandAll, collapseAll]);

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
        title: "エディタ",
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
        // Trigger rename on active node via a custom event
        const el = treeRef.current?.querySelector(
          `[data-node-id="${activeSceneId}"]`,
        );
        if (el)
          (el as HTMLElement).dispatchEvent(
            new CustomEvent("start-rename", { bubbles: true }),
          );
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
          .sort((a, b) => a!.sortOrder - b!.sortOrder) as TreeNodeData[];
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
      const isContainer = ["part", "chapter", "folder"].includes(
        overNode.nodeType,
      );
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
        読み込み中…
      </div>
    );
  }

  const draggingNode = draggingId ? nodeMap[draggingId] : null;

  return (
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
          <span className="text-xs font-semibold text-foreground">Scenes</span>
          <div className="flex items-center gap-0.5">
            {/* Create button */}
            <button
              ref={createBtnRef}
              type="button"
              title="新規作成"
              onClick={() => {
                if (!showCreateMenu && createBtnRef.current) {
                  setCreateMenuPos(
                    createBtnRef.current.getBoundingClientRect(),
                  );
                }
                setShowCreateMenu((v) => !v);
              }}
              className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>

            {/* Undo */}
            <button
              type="button"
              title="元に戻す (Ctrl+Z)"
              disabled={!canUndo}
              onClick={() =>
                useTreeHistoryStore
                  .getState()
                  .undo()
                  .catch(() => {})
              }
              className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
            >
              <Undo2 className="h-3.5 w-3.5" />
            </button>

            {/* Redo */}
            <button
              type="button"
              title="やり直し (Ctrl+Shift+Z)"
              disabled={!canRedo}
              onClick={() =>
                useTreeHistoryStore
                  .getState()
                  .redo()
                  .catch(() => {})
              }
              className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
            >
              <Redo2 className="h-3.5 w-3.5" />
            </button>

            {/* Expand/collapse toggle */}
            <button
              type="button"
              title="全展開/折りたたみ"
              onClick={handleToggleAll}
              className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <ChevronsUpDown className="h-3.5 w-3.5" />
            </button>

            {/* Panel menu */}
            <button
              ref={panelMenuBtnRef}
              type="button"
              title="パネルメニュー"
              onClick={() => {
                if (!showPanelMenu && panelMenuBtnRef.current) {
                  setPanelMenuPos(
                    panelMenuBtnRef.current.getBoundingClientRect(),
                  );
                }
                setShowPanelMenu((v) => !v);
              }}
              className={cn(
                "flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground",
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
            placeholder="フィルター..."
            className="w-full rounded border border-border bg-background px-2 py-0.5 text-xs text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>

        {/* Tree */}
        <div
          ref={treeRef}
          className="flex-1 overflow-y-auto overflow-x-hidden py-1 outline-none"
          tabIndex={0}
          onKeyDown={handleTreeKeyDown}
        >
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
              viewMode={viewMode}
              charCounts={charCounts}
              aiRatios={aiRatios}
              showWordCounts={showWordCounts}
              showStatusDots={showStatusDots}
              showAiAttribution={showAiAttribution}
              dropIndicator={dropIndicator}
              nodeTotals={nodeTotals}
              orderedNodes={flatNodes}
            />
          </ul>
          <BottomDropZone />
        </div>

        {/* Synopsis area — hidden in Outline mode (synopsis is shown inline there) */}
        {viewMode !== "outline" && activeNode?.nodeType === "scene" && (
          <SynopsisArea nodeId={activeSceneId} />
        )}

        {deleteConfirm && (
          <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/80">
            <div className="rounded-lg border border-border bg-popover p-4 shadow-xl w-72">
              <p className="text-sm font-medium mb-1">削除の確認</p>
              <p className="text-xs text-muted-foreground mb-4">
                {(() => {
                  function collectAll(id: string): string[] {
                    return [id, ...(childMap[id] ?? []).flatMap(collectAll)];
                  }
                  return deleteConfirm.flatMap(collectAll).filter((id) => {
                    const node = nodeMap[id];
                    if (!node || node.nodeType === "folder") return false;
                    return (charCounts[id] ?? 0) > 0 || !!node.synopsis;
                  }).length;
                })()}
                件のシーンに本文またはsynopsisがあります。削除すると元に戻せません。
              </p>
              <div className="flex gap-2 justify-end">
                <button
                  type="button"
                  className="rounded px-3 py-1 text-xs border border-border hover:bg-accent"
                  onClick={() => setDeleteConfirm(null)}
                >
                  キャンセル
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
                          p.then(() => useTreeStore.getState().deleteNode(id)),
                        Promise.resolve(),
                      )
                      .catch(() => {});
                  }}
                >
                  削除する
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
            className="min-w-[140px] rounded-md border border-border bg-popover p-1 shadow-md"
          >
            {CREATE_OPTIONS.map((opt, i) =>
              opt === null ? (
                <div key={i} className="my-1 border-t border-border" />
              ) : (
                <button
                  key={opt.type}
                  type="button"
                  className="flex w-full rounded px-2 py-1 text-xs hover:bg-accent"
                  onClick={() => handleCreate(opt.type)}
                >
                  {opt.label}
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
              showWordCounts={showWordCounts}
              setShowWordCounts={setShowWordCounts}
              showStatusDots={showStatusDots}
              setShowStatusDots={setShowStatusDots}
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
    </DndContext>
  );
}
