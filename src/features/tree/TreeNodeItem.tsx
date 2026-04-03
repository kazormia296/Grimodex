import { useState, useRef, useCallback } from "react";
import {
  ChevronRight,
  ChevronDown,
  FileText,
  Folder,
  BookOpen,
  List,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useTreeStore } from "./treeStore";
import { StatusDot } from "./StatusDot";
import type { TreeNodeData, SceneStatus } from "./treeStore";

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

/** Returns appropriate icon for a node type */
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

interface StatusPopoverProps {
  status: string | null;
  onSelect: (status: SceneStatus) => void;
  onClose: () => void;
}

function StatusPopover({ status, onSelect, onClose }: StatusPopoverProps) {
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

interface TreeNodeItemProps {
  node: TreeNodeData;
  depth: number;
  isActive: boolean;
  isExpanded: boolean;
  children?: React.ReactNode;
  isVisible: boolean;
}

export function TreeNodeItem({
  node,
  depth,
  isActive,
  isExpanded,
  children,
  isVisible,
}: TreeNodeItemProps) {
  const toggleExpand = useTreeStore((s) => s.toggleExpand);
  const setActiveScene = useTreeStore((s) => s.setActiveScene);
  const updateNodeTitle = useTreeStore((s) => s.updateNodeTitle);
  const deleteNode = useTreeStore((s) => s.deleteNode);
  const setStatus = useTreeStore((s) => s.setStatus);

  const [isEditing, setIsEditing] = useState(false);
  const [editTitle, setEditTitle] = useState(node.title);
  const [showStatusPopover, setShowStatusPopover] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const isContainer =
    node.nodeType === "part" ||
    node.nodeType === "chapter" ||
    node.nodeType === "folder";

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

  if (!isVisible) return null;

  return (
    <li className="list-none">
      <div
        className={cn(
          "group relative flex cursor-pointer items-center gap-0.5 rounded px-1 py-0.5 text-sm",
          "hover:bg-accent/50",
          isActive && "bg-accent font-medium",
        )}
        style={{ paddingLeft: `${depth * 12 + 4}px` }}
        onClick={handleClick}
        onDoubleClick={startEdit}
      >
        {/* Expand/collapse chevron for containers */}
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

        {/* Status dot (scene only) or icon */}
        {node.nodeType === "scene" ? (
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
              className="w-full rounded border border-ring bg-background px-1 text-sm focus:outline-none"
              autoFocus
            />
          ) : (
            <span className="block truncate text-xs leading-5">
              {node.title}
            </span>
          )}
        </span>

        {/* Delete button (hover) */}
        {!isEditing && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              deleteNode(node.id);
            }}
            className="ml-1 hidden h-4 w-4 flex-shrink-0 items-center justify-center rounded text-muted-foreground opacity-60 hover:opacity-100 group-hover:flex"
            aria-label="削除"
          >
            ×
          </button>
        )}
      </div>

      {/* Children */}
      {isContainer && isExpanded && children && (
        <ul className="list-none">{children}</ul>
      )}
    </li>
  );
}
