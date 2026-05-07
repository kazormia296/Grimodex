import { useState } from "react";
import { ChevronDown, ChevronRight, Home } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useTreeStore } from "@/features/tree/treeStore";
import type { TreeNodeData } from "@/features/tree/treeStore";
import { cmpKeys } from "@/features/tree/fractionalIndex";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

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
  const nodes = useTreeStore((s) => s.nodes);
  const nodesById = Object.fromEntries(nodes.map((n) => [n.id, n]));

  const ancestors = buildAncestors(containerId, nodesById);
  const rootFolders = nodes
    .filter((n) => n.nodeType === "folder" && n.parentId === null)
    .sort((a, b) => cmpKeys(a.sortOrder, b.sortOrder));

  return (
    <div className="flex items-center gap-0.5 text-[12px]">
      {/* Root breadcrumb */}
      <Button
        variant="ghost"
        size="icon-xs"
        onClick={() => onSelect(null)}
        title={t("grid.container.root", "プロジェクトルート")}
      >
        <Home />
      </Button>

      {/* Ancestor breadcrumbs */}
      {ancestors.map((seg) => (
        <span key={seg.id} className="flex items-center gap-0.5">
          <ChevronRight className="h-3 w-3 text-muted-foreground" />
          <Button
            variant="ghost"
            size="xs"
            className="max-w-[120px] px-1.5 font-normal"
            onClick={() => onSelect(seg.id)}
            title={seg.title}
          >
            <span className="truncate">{seg.title}</span>
          </Button>
        </span>
      ))}

      {/* Dropdown toggle */}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            className={cn(open && "bg-accent")}
            aria-label={t("grid.container.selectFolder", "フォルダを選択")}
          >
            <ChevronDown />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="w-auto min-w-[200px] max-h-64 overflow-y-auto p-1"
        >
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
        </PopoverContent>
      </Popover>
    </div>
  );
}
