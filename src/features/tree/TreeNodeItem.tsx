import { useState, useRef, useCallback, useEffect, memo } from "react";
import type { RefObject } from "react";
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
import { useDraggable, useDroppable } from "@dnd-kit/core";
import { cn } from "@/lib/utils";
import { useTreeStore } from "./treeStore";
import { StatusDot } from "./StatusDot";
import { recordMark } from "@/lib/perfLog";
import type { TreeNodeData, SceneStatus } from "./treeStore";
import { isFileBackedNode } from "@/features/external-mount/externalRootStore";
import { TreeContextMenu } from "./TreeContextMenu";
import { useLayoutStore } from "@/features/layout/layoutStore";
import { openEditorDocument } from "@/application/editor/openEditorDocument";
import { defaultEditorNavigationPorts } from "@/features/editor/editorNavigationPorts";
import { LabelDots } from "@/features/labels/LabelDots";
import { ScenesThreadTrack } from "@/features/plot-threads/ScenesThreadTrack";
import { TRACK_COL_WIDTH } from "@/features/plot-threads/sceneThreadTracks";
import type { PlotThreadRow } from "@/features/plot-threads/api";
import { LensDot } from "./LensDot";
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
  /** For folders, the flat list of leaf descendant ids whose charCount should
   *  be summed for the running total. Undefined for leaves. */
  leafDescendants?: string[];
  showWordCounts: boolean;
  showStatusDots: boolean;
  showLabelDots: boolean;
  showPlotThreadTrack: boolean;
  showAiAttribution: boolean;
  /** Per-column track state string for this row (buildSceneThreadTracks). */
  trackCells?: string;
  /** Branch/merge connector string for this row (buildSceneThreadTracks). */
  trackConnectors?: string;
  /** Plot-thread track columns (subway gutter). Stable ref. */
  trackColumns?: PlotThreadRow[];
  /** Ordered flat list of nodes for Shift+Click range selection.
   *  ref 渡し (クリック時に .current を読む) なのは、filter/expand 毎に
   *  配列参照が変わって memo が全行で破綻するのを防ぐため。 */
  orderedNodesRef: RefObject<TreeNodeData[]>;
  /** ドラッグ中はクリック/ダブルクリック/リネームを抑止する。
   *  旧 useDndContext 購読は context 更新のたび全行を再レンダーするため
   *  prop (drag 開始/終了の 2 回だけ変化) に置き換えた。 */
  dragInProgress: boolean;
  /** Current view mode — synopsis tooltip shown only in "tree" mode */
  viewMode?: string;
}

/** memo 化の前提: 全 props がスカラーか安定参照であること。
 *  node/leafDescendants は useScenesDerivedData の useMemo 産物、
 *  orderedNodesRef は ref。folder 行だけは children (毎 render 新規の
 *  JSX element) を受けるため親の再レンダーに常に追従する (許容済み)。
 *  ドロップ指示 (data-drop-*) は props でなく useScenesDnd が DOM 属性を
 *  直接トグルし、ここでは data-[drop-*] variant で見た目だけ持つ。 */
function TreeNodeItemImpl({
  node,
  depth,
  isActive,
  isSelected,
  isExpanded,
  children,
  leafDescendants,
  showWordCounts,
  showStatusDots,
  showLabelDots,
  showPlotThreadTrack,
  showAiAttribution,
  trackCells,
  trackConnectors,
  trackColumns,
  orderedNodesRef,
  dragInProgress,
  viewMode,
}: TreeNodeItemProps) {
  const __perfStart = performance.now();
  const toggleExpand = useTreeStore((s) => s.toggleExpand);
  const updateNodeTitle = useTreeStore((s) => s.updateNodeTitle);
  const setStatus = useTreeStore((s) => s.setStatus);
  const pendingRenameId = useTreeStore((s) => s.pendingRenameId);
  const setPendingRenameId = useTreeStore((s) => s.setPendingRenameId);

  // Per-id reactive subscriptions: a keystroke that changes one scene's
  // charCount only re-renders that scene's leaf and the folder ancestors
  // whose summed total actually changed (Object.is comparison on the number).
  const isLeafForCount = node.nodeType === "scene" || node.nodeType === "note";
  const fallbackCharCount = node.charCount ?? 0;
  const charCount = useTreeStore((s) => {
    if (isLeafForCount) return s.charCounts[node.id] ?? fallbackCharCount;
    if (!leafDescendants) return 0;
    let total = 0;
    for (const id of leafDescendants) total += s.charCounts[id] ?? 0;
    return total;
  });
  const aiRatio = useTreeStore((s) => s.aiRatios[node.id] ?? 0);

  const { t } = useTranslation();
  const [isEditing, setIsEditing] = useState(false);
  const [editTitle, setEditTitle] = useState(node.title);
  const [showStatusPopover, setShowStatusPopover] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const isContainer = node.nodeType === "folder";

  const reduced = useReducedMotion();
  const fileBacked = isFileBackedNode(node.sourceUri);

  // D&D: draggable
  const {
    attributes,
    listeners,
    setNodeRef: setDragRef,
    isDragging,
  } = useDraggable({ id: node.id, data: { node }, disabled: fileBacked });

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

  // DragOverlay handles the visual ghost, so suppress transform on the original.
  // Only reduce opacity to show the "source" placeholder in place.
  // ドロップ指示の隙間 (before/after の padding) と inside の ring は
  // useScenesDnd が書く data-drop-* 属性 + className の data-[drop-*]
  // variant が担う。React の style オブジェクトに padding を含めると
  // ドラッグ中の再レンダーで直書き属性側の見た目と競合するため持たない。
  const style = {
    opacity: isDragging ? 0.3 : 1,
    transition: "padding 100ms ease-out",
  };

  const focusEditorPanel = useCallback(() => {
    try {
      if (
        localStorage.getItem("grimodex:screenshot-mode") === "true" &&
        localStorage.getItem("grimodex:screenshot-panel") != null
      ) {
        return;
      }
    } catch {
      /* noop */
    }
    useLayoutStore.getState().requestEditorFocus();
  }, []);

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      if (node.nodeType === "scene" || node.nodeType === "note") {
        if (e.shiftKey) {
          useTreeStore
            .getState()
            .rangeSelectNode(node.id, orderedNodesRef.current ?? []);
        } else if (e.ctrlKey || e.metaKey) {
          useTreeStore.getState().selectNode(node.id, true);
        } else {
          useTreeStore.getState().selectNode(node.id, false);
          openEditorDocument(
            {
              target: { kind: "scene", documentId: node.id },
              mode: "preview",
              revealEditor: false,
              focusEditor: false,
              syncSceneContext: true,
            },
            defaultEditorNavigationPorts,
          );
          focusEditorPanel();
        }
      } else {
        // Folder: visually select + toggle expand/collapse
        useTreeStore.getState().selectNode(node.id, false);
        toggleExpand(node.id);
      }
    },
    [node, orderedNodesRef, toggleExpand, focusEditorPanel],
  );

  const handleDoubleClick = useCallback(() => {
    if (node.nodeType === "scene" || node.nodeType === "note") {
      openEditorDocument(
        {
          target: { kind: "scene", documentId: node.id },
          mode: "pinned",
          revealEditor: true,
          focusEditor: false,
          syncSceneContext: true,
        },
        defaultEditorNavigationPorts,
      );
      focusEditorPanel();
    }
  }, [node, focusEditorPanel]);

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

  // 左ガターの「縦版ミニ・タイムライン」幅。スレッド列ぶん content を右へ寄せ、
  // ガター自体は absolute で固定 x（深さ非依存）に置く＝縦線が全行で整列する。
  const trackColumnCount = trackColumns?.length ?? 0;
  const trackWidth =
    showPlotThreadTrack && trackColumnCount > 0
      ? trackColumnCount * TRACK_COL_WIDTH
      : 0;

  const __renderResult = (
    <li
      ref={setRef}
      style={style}
      // data-drop-before/after は useScenesDnd の applyDropIndicator が
      // ドラッグ中に直接トグルする (28px の隙間で挿入位置を示す)
      className="list-none data-[drop-before=true]:pt-7 data-[drop-after=true]:pb-7"
      data-node-id={node.id}
    >
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            data-node-row={node.id}
            className={cn(
              "group relative flex cursor-pointer items-center gap-0.5 rounded px-1 py-0.5 text-sm",
              "hover:bg-accent/50",
              // data-drop-inside も applyDropIndicator が直接トグルする
              "data-[drop-inside=true]:ring-1 data-[drop-inside=true]:ring-primary data-[drop-inside=true]:ring-inset",
              isActive && "bg-accent/70 font-medium",
              isSelected && !isActive && "bg-primary/20",
            )}
            style={{
              // アクティブの左バーは border ではなく inset box-shadow で描く。
              // border は padding box を 2px ずらし、absolute の縦トラックガターが
              // その行だけ右へジャンプする（選択行で線がズレる不具合）。box-shadow は
              // レイアウトに影響しないため全行でガターの x が揃う。
              boxShadow:
                isActive &&
                (node.nodeType === "scene" || node.nodeType === "note")
                  ? "inset 2px 0 0 0 var(--primary)"
                  : undefined,
              paddingLeft: `${trackWidth + depth * 12 + 4}px`,
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
            {/* 縦版ミニ・タイムライン（読み取り専用の左ガター・固定 x で整列） */}
            {trackWidth > 0 && trackColumns && (
              <ScenesThreadTrack
                cells={trackCells ?? ""}
                columns={trackColumns}
                connectors={trackConnectors}
              />
            )}
            {/* Drag handle — always in layout to prevent title shift */}
            <span
              {...(fileBacked ? {} : attributes)}
              {...(fileBacked ? {} : listeners)}
              className={cn(
                "flex h-5 w-4 flex-shrink-0 items-center justify-center text-muted-foreground/50 opacity-0 group-hover:opacity-100",
                fileBacked ? "cursor-not-allowed opacity-30" : "cursor-grab",
              )}
              title={fileBacked ? t("externalMount.filenameOrder") : undefined}
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
                        openEditorDocument(
                          {
                            target: { kind: "scene", documentId: n.id },
                            mode: "pinned",
                            revealEditor: true,
                            focusEditor: false,
                            syncSceneContext: true,
                          },
                          defaultEditorNavigationPorts,
                        );
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

            {/* メタ構造 lens バッジ */}
            {node.nodeType === "scene" && !isEditing && (
              <LensDot sceneId={node.id} updatedAt={node.updatedAt} />
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
  recordMark(
    "treeNodeItem.render",
    performance.now() - __perfStart,
    __perfStart,
  );
  return __renderResult;
}

// 親 (ScenesPanel) はフィルタ/選択/ドラッグ状態など多くの store slice を
// 購読して頻繁に再レンダーされる。memo で「props が実際に変わった行」だけに
// 再レンダーを絞る (gate: TreeRenderer.perf.test.tsx)。
export const TreeNodeItem = memo(TreeNodeItemImpl);
