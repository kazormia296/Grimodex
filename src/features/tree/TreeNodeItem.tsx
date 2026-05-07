import { useState, useRef, useCallback, useEffect } from "react";
import { motion, AnimatePresence } from "motion/react";
import { DURATIONS, EASINGS, useReducedMotion } from "@/lib/animation";
import { useTranslation } from "react-i18next";
import {
  ChevronRight,
  ChevronDown,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  GripVertical,
} from "lucide-react";
import { useDraggable, useDroppable, useDndContext } from "@dnd-kit/core";
import { cn } from "@/lib/utils";
import { useTreeStore } from "./treeStore";
import { StatusDot } from "./StatusDot";
import type { TreeNodeData, SceneStatus } from "./treeStore";
import { TreeContextMenu } from "./TreeContextMenu";
import { useTabStore } from "@/features/editor/tabStore";
import { useLayoutStore } from "@/features/layout/layoutStore";
import { LabelDots } from "@/features/labels/LabelDots";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "@/components/ui/popover";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu";

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

export function NodeIcon({
  nodeType,
  isExpanded = false,
}: {
  nodeType: string;
  isExpanded?: boolean;
}) {
  switch (nodeType) {
    case "folder":
      return isExpanded ? (
        <FolderOpen className="h-3.5 w-3.5 text-muted-foreground" />
      ) : (
        <Folder className="h-3.5 w-3.5 text-muted-foreground" />
      );
    case "note":
      return <FileText className="h-3.5 w-3.5 text-muted-foreground" />;
    default:
      return null;
  }
}

export interface DropIndicator {
  nodeId: string;
  position: "before" | "after" | "inside";
}

interface TreeNodeItemProps {
  node: TreeNodeData;
  depth: number;
  isActive: boolean;
  isSelected: boolean;
  isExpanded: boolean;
  children?: React.ReactNode;
  isVisible: boolean;
  charCount: number;
  showWordCounts: boolean;
  showStatusDots: boolean;
  showLabelDots: boolean;
  showAiAttribution: boolean;
  aiRatio: number; // 0-100; shown as badge when showAiAttribution && aiRatio > 0
  dropIndicator: DropIndicator | null;
  /** Ordered flat list of nodes for Shift+Click range selection */
  orderedNodes: TreeNodeData[];
  /** Current view mode — synopsis tooltip shown only in "tree" mode */
  viewMode?: string;
}

export function TreeNodeItem({
  node,
  depth,
  isActive,
  isSelected,
  isExpanded,
  children,
  isVisible,
  charCount,
  showWordCounts,
  showStatusDots,
  showLabelDots,
  showAiAttribution,
  aiRatio,
  dropIndicator,
  orderedNodes,
  viewMode,
}: TreeNodeItemProps) {
  const toggleExpand = useTreeStore((s) => s.toggleExpand);
  const setActiveScene = useTreeStore((s) => s.setActiveScene);
  const updateNodeTitle = useTreeStore((s) => s.updateNodeTitle);
  const setStatus = useTreeStore((s) => s.setStatus);
  const pendingRenameId = useTreeStore((s) => s.pendingRenameId);
  const setPendingRenameId = useTreeStore((s) => s.setPendingRenameId);

  const { t } = useTranslation();
  const [isEditing, setIsEditing] = useState(false);
  const [editTitle, setEditTitle] = useState(node.title);
  const [showStatusPopover, setShowStatusPopover] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const isContainer = node.nodeType === "folder";

  // Suppress rename/double-click while any drag is active
  const { active: dndActive } = useDndContext();
  const dragInProgress = dndActive !== null;
  const reduced = useReducedMotion();

  // D&D: draggable
  const {
    attributes,
    listeners,
    setNodeRef: setDragRef,
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

  const isDropBefore =
    dropIndicator?.nodeId === node.id && dropIndicator.position === "before";
  const isDropAfter =
    dropIndicator?.nodeId === node.id && dropIndicator.position === "after";
  const isDropInside =
    dropIndicator?.nodeId === node.id && dropIndicator.position === "inside";

  // DragOverlay handles the visual ghost, so suppress transform on the original.
  // Only reduce opacity to show the "source" placeholder in place.
  // paddingTop/Bottom creates a gap at the insert position instead of a thin indicator line.
  const style = {
    opacity: isDragging ? 0.3 : 1,
    paddingTop: isDropBefore ? 28 : 0,
    paddingBottom: isDropAfter ? 28 : 0,
    transition: "padding 100ms ease-out",
  };

  const focusEditorPanel = useCallback(() => {
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
  }, [t]);

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      if (node.nodeType === "scene" || node.nodeType === "note") {
        if (e.shiftKey) {
          useTreeStore.getState().rangeSelectNode(node.id, orderedNodes);
        } else if (e.ctrlKey || e.metaKey) {
          useTreeStore.getState().selectNode(node.id, true);
        } else {
          useTreeStore.getState().selectNode(node.id, false);
          useTabStore.getState().openPreview(node.id);
          setActiveScene(node.id);
          focusEditorPanel();
        }
      } else {
        // Folder: visually select + toggle expand/collapse
        useTreeStore.getState().selectNode(node.id, false);
        toggleExpand(node.id);
      }
    },
    [node, orderedNodes, setActiveScene, toggleExpand, focusEditorPanel],
  );

  const handleDoubleClick = useCallback(() => {
    if (node.nodeType === "scene" || node.nodeType === "note") {
      useTabStore.getState().openPinned(node.id);
      setActiveScene(node.id);
      focusEditorPanel();
    }
  }, [node, setActiveScene, focusEditorPanel]);

  const startEdit = useCallback(() => {
    setEditTitle(node.title);
    setIsEditing(true);
    setTimeout(() => inputRef.current?.select(), 0);
  }, [node.title]);

  // Auto-enter edit mode when this node was just created
  useEffect(() => {
    if (pendingRenameId === node.id) {
      startEdit();
      setPendingRenameId(null);
    }
  }, [pendingRenameId, node.id, startEdit, setPendingRenameId]);

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
    <li ref={setRef} style={style} className="list-none" data-node-id={node.id}>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            className={cn(
              "group relative flex cursor-pointer items-center gap-0.5 rounded px-1 py-0.5 text-sm",
              "hover:bg-accent/50",
              isActive && "bg-accent/70 font-medium",
              isActive &&
                (node.nodeType === "scene" || node.nodeType === "note") &&
                "border-l-2 border-primary",
              isSelected && !isActive && "bg-primary/20",
              isDropInside && "ring-1 ring-primary ring-inset",
            )}
            style={{
              paddingLeft: `${depth * 12 + (isActive && (node.nodeType === "scene" || node.nodeType === "note") ? 2 : 4)}px`,
            }}
            title={
              viewMode !== "outline" &&
              node.nodeType === "scene" &&
              node.synopsis
                ? node.synopsis.slice(0, 100)
                : undefined
            }
            onClick={dragInProgress ? undefined : (e) => handleClick(e)}
            onDoubleClick={dragInProgress ? undefined : handleDoubleClick}
          >
            {/* Drag handle — always in layout to prevent title shift */}
            <span
              {...attributes}
              {...listeners}
              className="flex h-5 w-4 flex-shrink-0 cursor-grab items-center justify-center text-muted-foreground/50 opacity-0 group-hover:opacity-100"
              onClick={(e) => e.stopPropagation()}
            >
              <GripVertical className="h-4 w-4" />
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
              <Popover
                open={showStatusPopover}
                onOpenChange={setShowStatusPopover}
              >
                <PopoverTrigger asChild>
                  <StatusDot
                    status={node.status}
                    onClick={(e) => e.stopPropagation()}
                  />
                </PopoverTrigger>
                <PopoverContent
                  align="start"
                  className="w-auto p-1"
                  onClick={(e) => e.stopPropagation()}
                >
                  {STATUS_OPTIONS.map((s) => (
                    <button
                      key={s}
                      type="button"
                      className={cn(
                        "flex w-full items-center gap-2 rounded px-2 py-1 text-xs hover:bg-accent",
                        node.status === s && "font-medium text-foreground",
                      )}
                      onClick={() => {
                        setStatus(node.id, s);
                        setShowStatusPopover(false);
                      }}
                    >
                      <StatusDot status={s} />
                      {STATUS_LABELS[s]}
                    </button>
                  ))}
                </PopoverContent>
              </Popover>
            ) : (
              <NodeIcon nodeType={node.nodeType} isExpanded={isExpanded} />
            )}

            {/* Title */}
            <span className="ml-1 flex-1 overflow-hidden">
              {isEditing ? (
                <Input
                  ref={inputRef}
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  onBlur={finishEdit}
                  onKeyDown={handleKeyDown}
                  onClick={(e) => e.stopPropagation()}
                  className="h-5 w-full rounded border-ring px-1 text-xs"
                  // eslint-disable-next-line jsx-a11y/no-autofocus
                  autoFocus
                />
              ) : (
                <span className="block truncate text-xs leading-5">
                  {node.title}
                </span>
              )}
            </span>

            {/* Folder hover quick-add buttons */}
            {node.nodeType === "folder" && !isEditing && (
              <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  title={t("tree.addScene")}
                  onClick={(e) => {
                    e.stopPropagation();
                    useTreeStore
                      .getState()
                      .createNode({ nodeType: "scene", parentId: node.id })
                      .then((n) => {
                        useTabStore.getState().openPinned(n.id);
                      })
                      .catch(() => {});
                  }}
                  className="h-4 w-4 text-muted-foreground hover:bg-accent/70 hover:text-foreground"
                >
                  <FileText className="h-3 w-3" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  title={t("tree.addFolder")}
                  onClick={(e) => {
                    e.stopPropagation();
                    useTreeStore
                      .getState()
                      .createNode({ nodeType: "folder", parentId: node.id })
                      .catch(() => {});
                  }}
                  className="h-4 w-4 text-muted-foreground hover:bg-accent/70 hover:text-foreground"
                >
                  <FolderPlus className="h-3 w-3" />
                </Button>
              </div>
            )}

            {/* Label dots */}
            {showLabelDots && node.nodeType === "scene" && !isEditing && (
              <LabelDots nodeId={node.id} />
            )}

            {/* AI attribution badge */}
            {showAiAttribution &&
              node.nodeType === "scene" &&
              aiRatio > 0 &&
              !isEditing && (
                <span className="ml-1 flex-shrink-0 rounded px-1 text-[10px] tabular-nums bg-purple-500/15 text-purple-400">
                  {aiRatio}%
                </span>
              )}

            {/* Word count */}
            {showWordCounts && !isEditing && (
              <span
                className={cn(
                  "ml-1 flex-shrink-0 text-[10px] tabular-nums",
                  charCount === 0
                    ? "text-muted-foreground/40"
                    : "text-muted-foreground",
                )}
              >
                {charCount > 0 ? charCount.toLocaleString() : ""}
              </span>
            )}
          </div>
        </ContextMenuTrigger>
        <TreeContextMenu node={node} onStartRename={startEdit} />
      </ContextMenu>

      {/* Children */}
      <AnimatePresence initial={false}>
        {isContainer && isExpanded && children && (
          <motion.ul
            className="list-none overflow-hidden"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{
              duration: reduced ? 0 : DURATIONS.normal,
              ease: EASINGS.easeOut,
            }}
          >
            {children}
          </motion.ul>
        )}
      </AnimatePresence>
    </li>
  );
}
