import { useState, useRef, useEffect } from "react";
import { ChevronDown, ChevronRight, Home } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useTreeStore } from "@/features/tree/treeStore";
import type { TreeNodeData } from "@/features/tree/treeStore";
import { cmpKeys } from "@/features/tree/fractionalIndex";
import { cn } from "@/lib/utils";

interface Props {
  containerId: string | null;
  projectId: string;
  onSelect: (id: string | null) => void;
}

function buildAncestors(
  id: string | null,
  nodesById: Record<string, TreeNodeData>,
): TreeNodeData[] {
  const chain: TreeNodeData[] = [];
  let cur = id ? nodesById[id] : null;
  while (cur) {
    chain.unshift(cur);
    cur = cur.parentId ? nodesById[cur.parentId] : null;
  }
  return chain;
}

interface FolderNodeProps {
  node: TreeNodeData;
  allNodes: TreeNodeData[];
  depth: number;
  onSelect: (id: string | null) => void;
  selected: string | null;
}

function FolderNode({
  node,
  allNodes,
  depth,
  onSelect,
  selected,
}: FolderNodeProps) {
  const [expanded, setExpanded] = useState(false);
  const children = allNodes
    .filter((n) => n.parentId === node.id && n.nodeType === "folder")
    .sort((a, b) => cmpKeys(a.sortOrder, b.sortOrder));

  return (
    <>
      <button
        className={cn(
          "flex w-full items-center gap-1 rounded px-2 py-1 text-[12px] hover:bg-accent text-left",
          selected === node.id && "bg-accent font-medium",
        )}
        style={{ paddingLeft: `${8 + depth * 12}px` }}
        onClick={() => onSelect(node.id)}
      >
        {children.length > 0 ? (
          <span
            className="shrink-0"
            onClick={(e) => {
              e.stopPropagation();
              setExpanded((v) => !v);
            }}
          >
            {expanded ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
          </span>
        ) : (
          <span className="h-3 w-3 shrink-0" />
        )}
        <span className="truncate">{node.title}</span>
      </button>
      {expanded &&
        children.map((child) => (
          <FolderNode
            key={child.id}
            node={child}
            allNodes={allNodes}
            depth={depth + 1}
            onSelect={onSelect}
            selected={selected}
          />
        ))}
    </>
  );
}

export function GridContainerSelector({ containerId, onSelect }: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const nodes = useTreeStore((s) => s.nodes);
  const nodesById = Object.fromEntries(nodes.map((n) => [n.id, n]));

  const ancestors = buildAncestors(containerId, nodesById);
  const rootFolders = nodes
    .filter((n) => n.nodeType === "folder" && n.parentId === null)
    .sort((a, b) => cmpKeys(a.sortOrder, b.sortOrder));

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(e.target as Node) &&
        buttonRef.current &&
        !buttonRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    if (open) document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  return (
    <div className="relative flex items-center gap-0.5 text-[12px]">
      {/* Root breadcrumb */}
      <button
        className="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-accent"
        onClick={() => onSelect(null)}
        title={t("grid.container.root", "プロジェクトルート")}
      >
        <Home className="h-3 w-3" />
      </button>

      {/* Ancestor breadcrumbs */}
      {ancestors.map((seg) => (
        <span key={seg.id} className="flex items-center gap-0.5">
          <ChevronRight className="h-3 w-3 text-muted-foreground" />
          <button
            className="rounded px-1.5 py-0.5 hover:bg-accent truncate max-w-[120px]"
            onClick={() => onSelect(seg.id)}
            title={seg.title}
          >
            {seg.title}
          </button>
        </span>
      ))}

      {/* Dropdown toggle */}
      <button
        ref={buttonRef}
        className={cn(
          "rounded px-1 py-0.5 hover:bg-accent",
          open && "bg-accent",
        )}
        onClick={() => setOpen((v) => !v)}
        aria-label={t("grid.container.selectFolder", "フォルダを選択")}
      >
        <ChevronDown className="h-3 w-3" />
      </button>

      {/* Dropdown */}
      {open && (
        <div
          ref={popoverRef}
          className="absolute left-0 top-full z-50 mt-1 min-w-[200px] max-h-64 overflow-y-auto rounded-md border bg-popover p-1 shadow-md"
        >
          {/* Root option */}
          <button
            className={cn(
              "flex w-full items-center gap-1 rounded px-2 py-1 text-[12px] hover:bg-accent",
              containerId === null && "bg-accent font-medium",
            )}
            onClick={() => {
              onSelect(null);
              setOpen(false);
            }}
          >
            <Home className="h-3 w-3" />
            {t("grid.container.root", "プロジェクトルート")}
          </button>

          {rootFolders.map((folder) => (
            <FolderNode
              key={folder.id}
              node={folder}
              allNodes={nodes}
              depth={0}
              selected={containerId}
              onSelect={(id) => {
                onSelect(id);
                setOpen(false);
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
