import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTreeStore } from "@/features/tree/treeStore";
import { useTabStore } from "./tabStore";
import type { TreeNodeData, NodeType } from "@/features/tree/treeStore";
import { cmpKeys } from "@/features/tree/fractionalIndex";

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
  anchorEl: HTMLElement;
  onSelect: (id: string) => void;
  onClose: () => void;
}

function SegmentDropdown({
  segment,
  siblings,
  anchorEl,
  onSelect,
  onClose,
}: SegmentDropdownProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<React.CSSProperties>({});

  // Position the portal dropdown below the anchor element
  useEffect(() => {
    const rect = anchorEl.getBoundingClientRect();
    setStyle({
      position: "fixed",
      top: rect.bottom + 2,
      left: rect.left,
      zIndex: 9999,
    });
  }, [anchorEl]);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) onClose();
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [onClose]);

  return createPortal(
    <div
      ref={ref}
      style={style}
      className="min-w-[180px] rounded-md border border-border bg-popover py-1 shadow-md"
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
    </div>,
    document.body,
  );
}

export function Breadcrumb() {
  const activeSceneId = useTreeStore((s) => s.activeSceneId);
  const nodes = useTreeStore((s) => s.nodes);
  const [openSegmentId, setOpenSegmentId] = useState<string | null>(null);
  const buttonRefs = useRef<Map<string, HTMLButtonElement>>(new Map());

  const nodeMap = Object.fromEntries(nodes.map((n) => [n.id, n]));

  // Only update the displayed path when the active node is a scene or note.
  // Selecting a folder in the Scenes panel should not change the breadcrumb.
  const activePath = useMemo(() => {
    const node = nodeMap[activeSceneId];
    if (!node || node.nodeType === "folder") return null;
    return computeBreadcrumbPath(activeSceneId, nodeMap);
  }, [activeSceneId, nodeMap]);

  const lastPathRef = useRef<BreadcrumbSegment[]>([]);
  if (activePath) lastPathRef.current = activePath;
  const path = activePath ?? lastPathRef.current;

  const getSiblings = useCallback(
    (segment: BreadcrumbSegment): TreeNodeData[] => {
      const node = nodeMap[segment.id];
      if (!node) return [];
      return nodes
        .filter(
          (n) => n.parentId === node.parentId && n.nodeType === node.nodeType,
        )
        .sort((a, b) => cmpKeys(a.sortOrder, b.sortOrder));
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

  // Narrow-width strategy: when path has 4+ segments and the bar overflows,
  // we collapse the middle segments into a single "…" trigger that opens a
  // menu of the hidden segments. Keep the first and last segments visible.
  // Apply per-segment truncate so individual long titles still ellipsize.
  return (
    // data-panel-header: エディタの chrome ジェスチャ帯（dblclick=最大化 /
    // 右クリック=パネルメニュー）。TabBar はタブ自体が dblclick を持つため
    // ジェスチャ対象はパンくず行に限定する。
    <div
      data-panel-header
      className="flex min-w-0 items-center border-b border-border px-3 py-1 text-xs text-muted-foreground"
    >
      {path.map((segment, i) => {
        const isLast = i === path.length - 1;
        const isFirst = i === 0;
        // Middle segments shrink first; first/last keep priority.
        const shrinkClass =
          isFirst || isLast ? "shrink-[2] basis-auto" : "shrink-[3] basis-auto";
        return (
          <span
            key={segment.id}
            className={cn("flex min-w-0 items-center", shrinkClass)}
          >
            {i > 0 && <ChevronRight className="mx-1 h-3 w-3 shrink-0" />}
            <span className="relative min-w-0">
              <button
                ref={(el) => {
                  if (el) buttonRefs.current.set(segment.id, el);
                  else buttonRefs.current.delete(segment.id);
                }}
                type="button"
                title={segment.title}
                className={cn(
                  "block max-w-full truncate rounded px-1 py-0.5 hover:bg-accent hover:text-foreground",
                  isLast && "text-foreground",
                )}
                onClick={() =>
                  setOpenSegmentId(
                    openSegmentId === segment.id ? null : segment.id,
                  )
                }
              >
                {segment.title}
              </button>
              {openSegmentId === segment.id &&
                buttonRefs.current.get(segment.id) && (
                  <SegmentDropdown
                    segment={segment}
                    siblings={getSiblings(segment)}
                    anchorEl={buttonRefs.current.get(segment.id)!}
                    onSelect={handleSelect}
                    onClose={() => setOpenSegmentId(null)}
                  />
                )}
            </span>
          </span>
        );
      })}
    </div>
  );
}
