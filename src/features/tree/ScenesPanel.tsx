import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import {
  Plus,
  ChevronsUpDown,
  MoreHorizontal,
  Check,
  GripVertical,
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
import { TreeNodeItem, NodeIcon } from "./TreeNodeItem";
import { StatusDot } from "./StatusDot";
import { SynopsisArea } from "./SynopsisArea";
import { CodexQuickSection } from "./CodexQuickSection";
import type { TreeNodeData, NodeType } from "./treeStore";
import { isValidParent } from "./treeStore";
import type { DropIndicator } from "./TreeNodeItem";

const DEFAULT_PROJECT_ID = "default-project";

// ---- Utility: flat visible node list (for keyboard nav) ----
function flattenVisible(
  parentId: string | null,
  childMap: Record<string, string[]>,
  nodeMap: Record<string, TreeNodeData>,
  expandedIds: string[],
  query: string,
): TreeNodeData[] {
  const ids = childMap[parentId ?? "root"] ?? [];
  const result: TreeNodeData[] = [];
  for (const id of ids) {
    const node = nodeMap[id];
    if (!node) continue;
    if (!isNodeVisible(node, childMap, nodeMap, query)) continue;
    result.push(node);
    const isContainer = ["part", "chapter", "folder"].includes(node.nodeType);
    const expanded =
      expandedIds.includes(id) ||
      (!!query && isNodeVisible(node, childMap, nodeMap, query));
    if (isContainer && expanded) {
      result.push(...flattenVisible(id, childMap, nodeMap, expandedIds, query));
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
): boolean {
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
  expandedIds: string[];
  filterQuery: string;
  viewMode: string;
  charCounts: Record<string, number>;
  showWordCounts: boolean;
  showStatusDots: boolean;
  dropIndicator: DropIndicator | null;
  nodeTotals: Record<string, number>;
}

function TreeRenderer({
  parentId,
  childMap,
  nodeMap,
  depth,
  activeSceneId,
  expandedIds,
  filterQuery,
  viewMode,
  charCounts,
  showWordCounts,
  showStatusDots,
  dropIndicator,
  nodeTotals,
}: TreeRendererProps) {
  const ids = childMap[parentId ?? "root"] ?? [];
  const query = filterQuery.toLowerCase();

  return (
    <>
      {ids.map((id) => {
        const node = nodeMap[id];
        if (!node) return null;
        const visible = isNodeVisible(node, childMap, nodeMap, query);
        const isExpanded = expandedIds.includes(id) || (!!query && visible);
        const isLeaf = node.nodeType === "scene" || node.nodeType === "note";
        const count = isLeaf ? (charCounts[id] ?? 0) : (nodeTotals[id] ?? 0);
        return (
          <TreeNodeItem
            key={id}
            node={node}
            depth={depth}
            isActive={node.id === activeSceneId}
            isExpanded={isExpanded}
            isVisible={visible}
            charCount={count}
            showWordCounts={showWordCounts}
            showStatusDots={showStatusDots}
            dropIndicator={dropIndicator}
          >
            {viewMode === "outline" &&
              node.nodeType === "scene" &&
              node.synopsis && (
                <li
                  className="list-none text-[11px] text-muted-foreground"
                  style={{
                    paddingLeft: `${depth * 12 + 24}px`,
                    paddingBottom: 4,
                  }}
                >
                  {node.synopsis}
                </li>
              )}
            <TreeRenderer
              parentId={id}
              childMap={childMap}
              nodeMap={nodeMap}
              depth={depth + 1}
              activeSceneId={activeSceneId}
              expandedIds={expandedIds}
              filterQuery={filterQuery}
              viewMode={viewMode}
              charCounts={charCounts}
              showWordCounts={showWordCounts}
              showStatusDots={showStatusDots}
              dropIndicator={dropIndicator}
              nodeTotals={nodeTotals}
            />
          </TreeNodeItem>
        );
      })}
    </>
  );
}

// ---- Panel menu ----
interface PanelMenuProps {
  viewMode: string;
  setViewMode: (m: "tree" | "outline") => void;
  showWordCounts: boolean;
  setShowWordCounts: (v: boolean) => void;
  showStatusDots: boolean;
  setShowStatusDots: (v: boolean) => void;
  onExpandAll: () => void;
  onCollapseAll: () => void;
  onClose: () => void;
}

function PanelMenu({
  viewMode,
  setViewMode,
  showWordCounts,
  setShowWordCounts,
  showStatusDots,
  setShowStatusDots,
  onExpandAll,
  onCollapseAll,
  onClose,
}: PanelMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function close(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) onClose();
    }
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [onClose]);

  function toggle<T>(
    _label: string,
    value: T,
    options: T[],
    onSelect: (v: T) => void,
  ) {
    return options.map((opt) => (
      <button
        key={String(opt)}
        type="button"
        onClick={() => {
          onSelect(opt);
          onClose();
        }}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-xs hover:bg-accent"
      >
        {value === opt ? (
          <Check className="h-3 w-3" />
        ) : (
          <span className="w-3" />
        )}
        {String(opt) === "tree"
          ? "Tree"
          : String(opt) === "outline"
            ? "Outline"
            : String(opt)}
      </button>
    ));
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

  function menuItem(label: string, action: () => void) {
    return (
      <button
        type="button"
        onClick={() => {
          action();
          onClose();
        }}
        className="flex w-full px-3 py-1.5 text-left text-xs hover:bg-accent"
      >
        {label}
      </button>
    );
  }

  return (
    <div
      ref={ref}
      className="absolute right-0 top-6 z-50 min-w-[180px] rounded-md border border-border bg-popover py-1 shadow-md"
    >
      <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        View
      </div>
      {toggle(
        "view",
        viewMode,
        ["tree", "outline"],
        setViewMode as (v: string) => void,
      )}
      <div className="my-1 border-t border-border" />
      <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        Show
      </div>
      {checkItem("文字数", showWordCounts, setShowWordCounts)}
      {checkItem("ステータスドット", showStatusDots, setShowStatusDots)}
      <div className="my-1 border-t border-border" />
      {menuItem("全展開", onExpandAll)}
      {menuItem("全折りたたみ", onCollapseAll)}
    </div>
  );
}

// ---- Main Panel ----
const CREATE_OPTIONS = [
  { type: "scene" as NodeType, label: "New scene" },
  { type: "chapter" as NodeType, label: "New chapter" },
  { type: "part" as NodeType, label: "New part" },
  null, // separator
  { type: "folder" as NodeType, label: "New folder" },
  { type: "note" as NodeType, label: "New note" },
];

export function ScenesPanel() {
  const {
    nodes,
    activeSceneId,
    isLoading,
    expandedIds,
    filterQuery,
    viewMode,
    charCounts,
    showWordCounts,
    showStatusDots,
    loadTree,
    createNode,
    expandAll,
    collapseAll,
    setFilterQuery,
    setViewMode,
    setShowWordCounts,
    setShowStatusDots,
    toggleExpand,
    setActiveScene,
    moveNode,
  } = useTreeStore();

  const filterRef = useRef<HTMLInputElement>(null);
  const treeRef = useRef<HTMLDivElement>(null);
  const [showCreateMenu, setShowCreateMenu] = useState(false);
  const [showPanelMenu, setShowPanelMenu] = useState(false);
  const allExpandedRef = useRef(false);
  const pointerYRef = useRef(0);
  const [dropIndicator, setDropIndicator] = useState<DropIndicator | null>(
    null,
  );
  const [draggingId, setDraggingId] = useState<string | null>(null);

  useEffect(() => {
    loadTree(DEFAULT_PROJECT_ID);
  }, [loadTree]);

  const { childMap, nodeMap } = useMemo(() => {
    const nm: Record<string, TreeNodeData> = {};
    const cm: Record<string, string[]> = { root: [] };
    for (const n of nodes) nm[n.id] = n;
    const sorted = [...nodes].sort((a, b) => a.sortOrder - b.sortOrder);
    for (const n of sorted) {
      const key = n.parentId ?? "root";
      if (!cm[key]) cm[key] = [];
      cm[key].push(n.id);
    }
    return { childMap: cm, nodeMap: nm };
  }, [nodes]);

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
      ),
    [childMap, nodeMap, expandedIds, filterQuery],
  );

  const handleToggleAll = useCallback(() => {
    if (allExpandedRef.current) collapseAll();
    else expandAll();
    allExpandedRef.current = !allExpandedRef.current;
  }, [expandAll, collapseAll]);

  const handleCreate = useCallback(
    (type: NodeType) => {
      setShowCreateMenu(false);
      let parentId: string | null = null;
      if (type === "scene") {
        const active = nodeMap[activeSceneId];
        if (active?.nodeType === "scene") parentId = active.parentId;
        else if (active?.nodeType === "chapter") parentId = active.id;
        else
          parentId =
            Object.values(nodeMap).find((n) => n.nodeType === "chapter")?.id ??
            null;
      } else if (type === "chapter") {
        const active = nodeMap[activeSceneId];
        const parentChapter = active?.parentId
          ? nodeMap[active.parentId]
          : null;
        parentId = parentChapter?.parentId ?? null;
      } else if (type === "note") {
        const active = nodeMap[activeSceneId];
        if (active?.nodeType === "note") parentId = active.parentId;
        else
          parentId =
            Object.values(nodeMap).find((n) => n.nodeType === "folder")?.id ??
            null;
      }
      createNode({ nodeType: type, parentId, afterId: activeSceneId }).catch(
        () => {},
      );
    },
    [createNode, activeSceneId, nodeMap],
  );

  // Keyboard navigation
  const handleTreeKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // Let input elements handle their own arrow/delete keys
      if ((e.target as HTMLElement).tagName === "INPUT") return;

      const idx = flatNodes.findIndex((n) => n.id === activeSceneId);
      if (e.key === "ArrowDown") {
        e.preventDefault();
        const next = flatNodes[idx + 1];
        if (next) setActiveScene(next.id);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        const prev = flatNodes[idx - 1];
        if (prev) setActiveScene(prev.id);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        const cur = nodeMap[activeSceneId];
        if (cur && ["part", "chapter", "folder"].includes(cur.nodeType)) {
          if (!expandedIds.includes(activeSceneId)) toggleExpand(activeSceneId);
        }
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        const cur = nodeMap[activeSceneId];
        if (
          cur &&
          ["part", "chapter", "folder"].includes(cur.nodeType) &&
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
          const { deleteNode } = useTreeStore.getState();
          deleteNode(activeSceneId).catch(() => {});
        }
      } else if (e.key === "f" && e.ctrlKey) {
        e.preventDefault();
        filterRef.current?.focus();
      }
    },
    [
      flatNodes,
      activeSceneId,
      nodeMap,
      expandedIds,
      setActiveScene,
      toggleExpand,
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
      if (!over || active.id === over.id) return;

      const activeId = active.id as string;
      // over.id is like "drop-{nodeId}"
      const overId = String(over.id).replace(/^drop-/, "");
      if (activeId === overId) return;

      const activeNode = nodeMap[activeId];
      const overNode = nodeMap[overId];
      if (!activeNode || !overNode) return;

      // Compute drop position from pointer Y vs over element rect
      const overRect = over.rect;
      const pointerY = pointerYRef.current;
      let position: "before" | "after" | "inside" = "after";
      if (overRect) {
        const isContainer = ["part", "chapter", "folder"].includes(
          overNode.nodeType,
        );
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

      // Validate
      const parentNode = newParentId ? nodeMap[newParentId] : null;
      if (!isValidParent(activeNode.nodeType, parentNode?.nodeType ?? null))
        return;

      moveNode(activeId, newParentId, afterId).catch(() => {});
    },
    [nodeMap, childMap, moveNode],
  );

  // Update drop indicator during drag
  const onDragOver = useCallback(
    ({ active, over }: DragMoveEvent) => {
      if (!over) {
        setDropIndicator(null);
        return;
      }
      const overId = String(over.id).replace(/^drop-/, "");
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
    [nodeMap],
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
      <div className="flex h-full flex-col">
        {/* Toolbar */}
        <div className="flex flex-shrink-0 items-center justify-between border-b border-border px-2 py-1.5">
          <span className="text-xs font-semibold text-foreground">Scenes</span>
          <div className="flex items-center gap-0.5">
            {/* Create button */}
            <div className="relative">
              <button
                type="button"
                title="新規作成"
                onClick={() => setShowCreateMenu((v) => !v)}
                className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <Plus className="h-3.5 w-3.5" />
              </button>
              {showCreateMenu && (
                <div className="absolute right-0 top-6 z-50 min-w-[140px] rounded-md border border-border bg-popover p-1 shadow-md">
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
                </div>
              )}
            </div>

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
            <div className="relative">
              <button
                type="button"
                title="パネルメニュー"
                onClick={() => setShowPanelMenu((v) => !v)}
                className={cn(
                  "flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground",
                  showPanelMenu && "bg-accent text-foreground",
                )}
              >
                <MoreHorizontal className="h-3.5 w-3.5" />
              </button>
              {showPanelMenu && (
                <PanelMenu
                  viewMode={viewMode}
                  setViewMode={setViewMode}
                  showWordCounts={showWordCounts}
                  setShowWordCounts={setShowWordCounts}
                  showStatusDots={showStatusDots}
                  setShowStatusDots={setShowStatusDots}
                  onExpandAll={expandAll}
                  onCollapseAll={collapseAll}
                  onClose={() => setShowPanelMenu(false)}
                />
              )}
            </div>
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
              expandedIds={expandedIds}
              filterQuery={filterQuery}
              viewMode={viewMode}
              charCounts={charCounts}
              showWordCounts={showWordCounts}
              showStatusDots={showStatusDots}
              dropIndicator={dropIndicator}
              nodeTotals={nodeTotals}
            />
          </ul>
        </div>

        {/* Synopsis area */}
        {activeNode?.nodeType === "scene" && (
          <SynopsisArea nodeId={activeSceneId} />
        )}

        {/* Codex Quick section */}
        <CodexQuickSection />
      </div>

      {/* Drag overlay — portaled to body to escape dockview's transform context
         which breaks position:fixed used by DragOverlay */}
      {createPortal(
        <DragOverlay>
          {draggingNode && (
            <div className="flex items-center gap-0.5 rounded bg-background/95 px-1 py-0.5 text-sm shadow-lg ring-1 ring-primary">
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
    </DndContext>
  );
}
