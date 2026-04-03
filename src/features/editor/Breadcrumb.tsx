import { useState, useRef, useEffect, useCallback } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTreeStore } from "@/features/tree/treeStore";
import { useTabStore } from "./tabStore";
import type { TreeNodeData, NodeType } from "@/features/tree/treeStore";

export interface BreadcrumbSegment {
  id: string;
  title: string;
  nodeType: NodeType;
}

/**
 * Compute the ancestor path from root to the given node (inclusive).
 * Returns [] if the node is not found.
 */
export function computeBreadcrumbPath(
  nodeId: string,
  nodeMap: Record<string, TreeNodeData>,
): BreadcrumbSegment[] {
  const node = nodeMap[nodeId];
  if (!node) return [];

  const path: BreadcrumbSegment[] = [];
  let current: TreeNodeData | undefined = node;
  while (current) {
    path.unshift({
      id: current.id,
      title: current.title,
      nodeType: current.nodeType,
    });
    current = current.parentId ? nodeMap[current.parentId] : undefined;
  }
  return path;
}

interface SegmentDropdownProps {
  segment: BreadcrumbSegment;
  siblings: TreeNodeData[];
  onSelect: (id: string) => void;
  onClose: () => void;
}

function SegmentDropdown({
  segment,
  siblings,
  onSelect,
  onClose,
}: SegmentDropdownProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) onClose();
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="absolute left-0 top-full z-50 mt-0.5 min-w-[180px] rounded-md border border-border bg-popover py-1 shadow-md"
    >
      {siblings.map((sib) => (
        <button
          key={sib.id}
          type="button"
          className={cn(
            "flex w-full items-center px-3 py-1.5 text-left text-xs hover:bg-accent",
            sib.id === segment.id && "font-medium text-foreground",
          )}
          onClick={() => {
            onSelect(sib.id);
            onClose();
          }}
        >
          {sib.title}
        </button>
      ))}
    </div>
  );
}

export function Breadcrumb() {
  const activeSceneId = useTreeStore((s) => s.activeSceneId);
  const nodes = useTreeStore((s) => s.nodes);
  const [openSegmentId, setOpenSegmentId] = useState<string | null>(null);

  const nodeMap = Object.fromEntries(nodes.map((n) => [n.id, n]));
  const path = computeBreadcrumbPath(activeSceneId, nodeMap);

  const getSiblings = useCallback(
    (segment: BreadcrumbSegment): TreeNodeData[] => {
      const node = nodeMap[segment.id];
      if (!node) return [];
      return nodes
        .filter(
          (n) => n.parentId === node.parentId && n.nodeType === node.nodeType,
        )
        .sort((a, b) => a.sortOrder - b.sortOrder);
    },
    [nodes, nodeMap],
  );

  function handleSelect(id: string) {
    const node = nodeMap[id];
    if (!node) return;
    if (node.nodeType === "scene" || node.nodeType === "note") {
      useTabStore.getState().openPinned(id);
      useTreeStore.getState().setActiveScene(id);
    }
  }

  if (path.length === 0) return null;

  return (
    <div className="flex items-center overflow-x-auto border-b border-border px-3 py-1 text-xs text-muted-foreground">
      {path.map((segment, i) => (
        <span key={segment.id} className="flex items-center">
          {i > 0 && <ChevronRight className="mx-1 h-3 w-3 flex-shrink-0" />}
          <span className="relative">
            <button
              type="button"
              className={cn(
                "rounded px-1 py-0.5 hover:bg-accent hover:text-foreground",
                i === path.length - 1 && "text-foreground",
              )}
              onClick={() =>
                setOpenSegmentId(
                  openSegmentId === segment.id ? null : segment.id,
                )
              }
            >
              {segment.title}
            </button>
            {openSegmentId === segment.id && (
              <SegmentDropdown
                segment={segment}
                siblings={getSiblings(segment)}
                onSelect={handleSelect}
                onClose={() => setOpenSegmentId(null)}
              />
            )}
          </span>
        </span>
      ))}
    </div>
  );
}
