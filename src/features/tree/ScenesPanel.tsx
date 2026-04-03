import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { Plus, ChevronsUpDown, LayoutList } from "lucide-react";
import { useTreeStore } from "./treeStore";
import { TreeNodeItem } from "./TreeNodeItem";
import { SynopsisArea } from "./SynopsisArea";
import type { TreeNodeData, NodeType } from "./treeStore";

const DEFAULT_PROJECT_ID = "default-project";

/** Returns true if any descendant of `id` matches the query */
function hasMatchingDescendant(
  id: string,
  childMap: Record<string, string[]>,
  nodeMap: Record<string, TreeNodeData>,
  query: string,
): boolean {
  const children = childMap[id] ?? [];
  for (const childId of children) {
    const child = nodeMap[childId];
    if (child && child.title.toLowerCase().includes(query)) return true;
    if (hasMatchingDescendant(childId, childMap, nodeMap, query)) return true;
  }
  return false;
}

function isVisible(
  node: TreeNodeData,
  childMap: Record<string, string[]>,
  nodeMap: Record<string, TreeNodeData>,
  query: string,
): boolean {
  if (!query) return true;
  if (node.title.toLowerCase().includes(query)) return true;
  return hasMatchingDescendant(node.id, childMap, nodeMap, query);
}

interface TreeRendererProps {
  parentId: string | null;
  childMap: Record<string, string[]>;
  nodeMap: Record<string, TreeNodeData>;
  depth: number;
  activeSceneId: string;
  expandedIds: string[];
  filterQuery: string;
  viewMode: string;
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
}: TreeRendererProps) {
  const ids = childMap[parentId ?? "root"] ?? [];
  const query = filterQuery.toLowerCase();

  return (
    <>
      {ids.map((id) => {
        const node = nodeMap[id];
        if (!node) return null;
        const visible = isVisible(node, childMap, nodeMap, query);
        const isExpanded = expandedIds.includes(id) || (!!query && visible);
        return (
          <TreeNodeItem
            key={id}
            node={node}
            depth={depth}
            isActive={node.id === activeSceneId}
            isExpanded={isExpanded}
            isVisible={visible}
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
            />
          </TreeNodeItem>
        );
      })}
    </>
  );
}

type CreateMenuOption = { type: NodeType; label: string };

const CREATE_OPTIONS: CreateMenuOption[] = [
  { type: "scene", label: "New scene" },
  { type: "chapter", label: "New chapter" },
  { type: "part", label: "New part" },
  { type: "folder", label: "New folder" },
  { type: "note", label: "New note" },
];

export function ScenesPanel() {
  const {
    nodes,
    activeSceneId,
    isLoading,
    expandedIds,
    filterQuery,
    viewMode,
    loadTree,
    createNode,
    expandAll,
    collapseAll,
    setFilterQuery,
    setViewMode,
  } = useTreeStore();

  const filterRef = useRef<HTMLInputElement>(null);
  const [showCreateMenu, setShowCreateMenu] = useState(false);
  const [showViewMenu, setShowViewMenu] = useState(false);
  const allExpanded = useRef(false);

  useEffect(() => {
    loadTree(DEFAULT_PROJECT_ID);
  }, [loadTree]);

  // Build child map and node map
  const { childMap, nodeMap } = useMemo(() => {
    const nm: Record<string, TreeNodeData> = {};
    const cm: Record<string, string[]> = { root: [] };
    for (const n of nodes) {
      nm[n.id] = n;
    }
    // Sort nodes by sortOrder before building childMap
    const sorted = [...nodes].sort((a, b) => a.sortOrder - b.sortOrder);
    for (const n of sorted) {
      const key = n.parentId ?? "root";
      if (!cm[key]) cm[key] = [];
      cm[key].push(n.id);
    }
    return { childMap: cm, nodeMap: nm };
  }, [nodes]);

  const handleToggleAll = useCallback(() => {
    if (allExpanded.current) {
      collapseAll();
    } else {
      expandAll();
    }
    allExpanded.current = !allExpanded.current;
  }, [expandAll, collapseAll]);

  const activeNode = nodeMap[activeSceneId];

  const handleCreate = useCallback(
    (type: NodeType) => {
      setShowCreateMenu(false);
      // Determine parent based on type and active node
      let parentId: string | null = null;
      if (type === "scene") {
        // Find parent chapter of active scene
        const active = nodeMap[activeSceneId];
        if (active?.nodeType === "scene") parentId = active.parentId;
        else if (active?.nodeType === "chapter") parentId = active.id;
        else
          parentId =
            Object.values(nodeMap).find((n) => n.nodeType === "chapter")?.id ??
            null;
      } else if (type === "chapter") {
        // Part or root
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

  if (isLoading && nodes.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        読み込み中…
      </div>
    );
  }

  return (
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
                {CREATE_OPTIONS.map((opt) => (
                  <button
                    key={opt.type}
                    type="button"
                    className="flex w-full rounded px-2 py-1 text-xs hover:bg-accent"
                    onClick={() => handleCreate(opt.type)}
                  >
                    {opt.label}
                  </button>
                ))}
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

          {/* View menu */}
          <div className="relative">
            <button
              type="button"
              title="表示メニュー"
              onClick={() => setShowViewMenu((v) => !v)}
              className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <LayoutList className="h-3.5 w-3.5" />
            </button>
            {showViewMenu && (
              <div className="absolute right-0 top-6 z-50 min-w-[120px] rounded-md border border-border bg-popover p-1 shadow-md">
                {(["tree", "outline"] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    className={`flex w-full rounded px-2 py-1 text-xs hover:bg-accent ${viewMode === mode ? "font-medium text-foreground" : "text-muted-foreground"}`}
                    onClick={() => {
                      setViewMode(mode);
                      setShowViewMenu(false);
                    }}
                  >
                    {mode === "tree" ? "Tree" : "Outline"}
                  </button>
                ))}
              </div>
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
      <div className="flex-1 overflow-auto py-1">
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
          />
        </ul>
      </div>

      {/* Synopsis area for active scene */}
      {activeNode?.nodeType === "scene" && (
        <SynopsisArea nodeId={activeSceneId} />
      )}
    </div>
  );
}
