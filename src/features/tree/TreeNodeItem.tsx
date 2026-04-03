import { useState, useRef, useCallback, useEffect } from "react";
import {
  ChevronRight,
  ChevronDown,
  FileText,
  Folder,
  BookOpen,
  List,
  GripVertical,
} from "lucide-react";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { cn } from "@/lib/utils";
import { useTreeStore } from "./treeStore";
import { StatusDot } from "./StatusDot";
import type { TreeNodeData, SceneStatus } from "./treeStore";
import { TreeContextMenu } from "./TreeContextMenu";

const STATUS_OPTIONS: SceneStatus[] = [
  "outline",
  "draft",
  "complete",
  "revision",
  "final",
];
const STATUS_LABELS: Record<SceneStatus, string> = {
  outline: "Outline",
  draft: "Draft",
  complete: "Complete",
  revision: "Revision",
  final: "Final",
};

function NodeIcon({ nodeType }: { nodeType: string }) {
  switch (nodeType) {
    case "part":
      return <List className="h-3.5 w-3.5 text-foreground/70" />;
    case "chapter":
      return <BookOpen className="h-3.5 w-3.5 text-foreground/60" />;
    case "folder":
      return <Folder className="h-3.5 w-3.5 text-teal-500" />;
    case "note":
      return <FileText className="h-3.5 w-3.5 text-teal-500" />;
    default:
      return null;
  }
}

function StatusPopover({
  status,
  onSelect,
  onClose,
}: {
  status: string | null;
  onSelect: (s: SceneStatus) => void;
  onClose: () => void;
}) {
  return (
    <div
      className="absolute left-4 top-4 z-50 rounded-md border border-border bg-popover p-1 shadow-md"
      onMouseLeave={onClose}
    >
      {STATUS_OPTIONS.map((s) => (
        <button
          key={s}
          type="button"
          className={cn(
            "flex w-full items-center gap-2 rounded px-2 py-1 text-xs hover:bg-accent",
            status === s && "font-medium text-foreground",
          )}
          onClick={() => {
            onSelect(s);
            onClose();
          }}
        >
          <StatusDot status={s} />
          {STATUS_LABELS[s]}
        </button>
      ))}
    </div>
  );
}

export interface DropIndicator {
  nodeId: string;
  position: "before" | "after" | "inside";
}

interface TreeNodeItemProps {
  node: TreeNodeData;
  depth: number;
  isActive: boolean;
  isExpanded: boolean;
  children?: React.ReactNode;
  isVisible: boolean;
  charCount: number;
  showWordCounts: boolean;
  showStatusDots: boolean;
  dropIndicator: DropIndicator | null;
  onStartRename?: () => void;
}

export function TreeNodeItem({
  node,
  depth,
  isActive,
  isExpanded,
  children,
  isVisible,
  charCount,
  showWordCounts,
  showStatusDots,
  dropIndicator,
  onStartRename,
}: TreeNodeItemProps) {
  const toggleExpand = useTreeStore((s) => s.toggleExpand);
  const setActiveScene = useTreeStore((s) => s.setActiveScene);
  const updateNodeTitle = useTreeStore((s) => s.updateNodeTitle);
  const setStatus = useTreeStore((s) => s.setStatus);

  const [isEditing, setIsEditing] = useState(false);
  const [editTitle, setEditTitle] = useState(node.title);
  const [showStatusPopover, setShowStatusPopover] = useState(false);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const isContainer =
    node.nodeType === "part" ||
    node.nodeType === "chapter" ||
    node.nodeType === "folder";

  // D&D: draggable
  const {
    attributes,
    listeners,
    setNodeRef: setDragRef,
    transform,
    isDragging,
  } = useDraggable({ id: node.id, data: { node } });

  // D&D: droppable
  const { setNodeRef: setDropRef } = useDroppable({
    id: `drop-${node.id}`,
    data: { node },
  });

  const setRef = useCallback(
    (el: HTMLLIElement | null) => {
      setDragRef(el);
      setDropRef(el);
    },
    [setDragRef, setDropRef],
  );

  const style = {
    transform: CSS.Translate.toString(transform),
    opacity: isDragging ? 0.4 : 1,
  };

  const handleClick = useCallback(() => {
    if (node.nodeType === "scene" || node.nodeType === "note") {
      setActiveScene(node.id);
    } else {
      toggleExpand(node.id);
    }
  }, [node, setActiveScene, toggleExpand]);

  const startEdit = useCallback(() => {
    setEditTitle(node.title);
    setIsEditing(true);
    setTimeout(() => inputRef.current?.select(), 0);
  }, [node.title]);

  // Expose startEdit via prop
  useEffect(() => {
    if (onStartRename) {
      // no-op: parent calls startEdit via the passed callback
    }
  }, [onStartRename]);

  const finishEdit = useCallback(() => {
    const trimmed = editTitle.trim();
    if (trimmed && trimmed !== node.title) {
      updateNodeTitle(node.id, trimmed).catch(() => {});
    }
    setIsEditing(false);
  }, [editTitle, node.id, node.title, updateNodeTitle]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" || e.key === "Escape") {
        if (e.key === "Escape") setEditTitle(node.title);
        finishEdit();
        e.preventDefault();
      }
    },
    [finishEdit, node.title],
  );

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY });
  }, []);

  if (!isVisible) return null;

  const isDropBefore =
    dropIndicator?.nodeId === node.id && dropIndicator.position === "before";
  const isDropAfter =
    dropIndicator?.nodeId === node.id && dropIndicator.position === "after";
  const isDropInside =
    dropIndicator?.nodeId === node.id && dropIndicator.position === "inside";

  return (
    <li ref={setRef} style={style} className="list-none">
      {/* Drop-before indicator */}
      {isDropBefore && (
        <div className="mx-2 h-0.5 rounded-full bg-primary" />
      )}

      <div
        className={cn(
          "group relative flex cursor-pointer items-center gap-0.5 rounded px-1 py-0.5 text-sm",
          "hover:bg-accent/50",
          isActive && "bg-accent/70 font-medium",
          isActive &&
            (node.nodeType === "scene" || node.nodeType === "note") &&
            "border-l-2 border-primary",
          isDropInside && "ring-1 ring-primary ring-inset",
        )}
        style={{ paddingLeft: `${depth * 12 + (isActive && (node.nodeType === "scene" || node.nodeType === "note") ? 2 : 4)}px` }}
        onClick={handleClick}
        onDoubleClick={startEdit}
        onContextMenu={handleContextMenu}
      >
        {/* Drag handle */}
        <span
          {...attributes}
          {...listeners}
          className="hidden h-4 w-3 flex-shrink-0 cursor-grab items-center justify-center text-muted-foreground/50 group-hover:flex"
          onClick={(e) => e.stopPropagation()}
        >
          <GripVertical className="h-3 w-3" />
        </span>

        {/* Expand/collapse chevron */}
        {isContainer ? (
          <span className="flex h-4 w-4 flex-shrink-0 items-center justify-center text-muted-foreground">
            {isExpanded ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
          </span>
        ) : (
          <span className="w-4 flex-shrink-0" />
        )}

        {/* Status dot or icon */}
        {node.nodeType === "scene" && showStatusDots ? (
          <div className="relative">
            <StatusDot
              status={node.status}
              onClick={(e) => {
                e.stopPropagation();
                setShowStatusPopover((v) => !v);
              }}
            />
            {showStatusPopover && (
              <StatusPopover
                status={node.status}
                onSelect={(s) => setStatus(node.id, s)}
                onClose={() => setShowStatusPopover(false)}
              />
            )}
          </div>
        ) : (
          <NodeIcon nodeType={node.nodeType} />
        )}

        {/* Title */}
        <span className="flex-1 overflow-hidden">
          {isEditing ? (
            <input
              ref={inputRef}
              value={editTitle}
              onChange={(e) => setEditTitle(e.target.value)}
              onBlur={finishEdit}
              onKeyDown={handleKeyDown}
              onClick={(e) => e.stopPropagation()}
              className="w-full rounded border border-ring bg-background px-1 text-xs focus:outline-none"
              autoFocus
            />
          ) : (
            <span className="block truncate text-xs leading-5">
              {node.title}
            </span>
          )}
        </span>

        {/* Word count */}
        {showWordCounts && !isEditing && (
          <span
            className={cn(
              "ml-1 flex-shrink-0 text-[10px] tabular-nums",
              charCount === 0 ? "text-muted-foreground/40" : "text-muted-foreground",
            )}
          >
            {charCount > 0 ? charCount.toLocaleString() : ""}
          </span>
        )}
      </div>

      {/* Drop-after indicator */}
      {isDropAfter && (
        <div className="mx-2 h-0.5 rounded-full bg-primary" />
      )}

      {/* Children */}
      {isContainer && isExpanded && children && (
        <ul className="list-none">{children}</ul>
      )}

      {/* Context menu */}
      {contextMenu && (
        <TreeContextMenu
          node={node}
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
          onStartRename={() => {
            setContextMenu(null);
            startEdit();
          }}
        />
      )}
    </li>
  );
}
