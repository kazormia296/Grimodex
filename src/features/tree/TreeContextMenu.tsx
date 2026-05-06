import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Check, ChevronRight, MapPin, Settings, Tag } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTreeStore } from "./treeStore";
import { useTabStore } from "@/features/editor/tabStore";
import { useLabelStore } from "@/features/labels/labelStore";
import { resolveLabelColor } from "@/lib/labelPalette";
import { useScenesPanelContext } from "./ScenesPanelContext";
import { StatusDot } from "./StatusDot";
import type { TreeNodeData, SceneStatus } from "./treeStore";
import { useAddToMapBoards } from "@/features/map/hooks/useAddToMapBoards";

const PROJECT_ID = "default-project";

const EMPTY_LABEL_IDS: readonly string[] = Object.freeze([]);

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

interface ContextMenuProps {
  node: TreeNodeData;
  x: number;
  y: number;
  onClose: () => void;
  onStartRename: () => void;
}

export function TreeContextMenu({
  node,
  x,
  y,
  onClose,
  onStartRename,
}: ContextMenuProps) {
  const { t } = useTranslation();
  const menuRef = useRef<HTMLDivElement>(null);
  const { deleteNode, setStatus, createNode, setActiveScene } = useTreeStore();
  const selectedIds = useTreeStore((s) => s.selectedIds);
  const allNodes = useTreeStore((s) => s.nodes);
  const allLabels = useLabelStore((s) => s.labels);
  const assignedLabelIds = useLabelStore(
    (s) => s.nodeLabels[node.id] ?? EMPTY_LABEL_IDS,
  );
  const [labelMenuOpen, setLabelMenuOpen] = useState(false);
  const [statusMenuOpen, setStatusMenuOpen] = useState(false);
  const [mapMenuOpen, setMapMenuOpen] = useState(false);
  const { boards, addToBoard } = useAddToMapBoards(PROJECT_ID);
  const scenesContext = useScenesPanelContext();

  // If the right-clicked node is part of a multi-selection, operations apply
  // to all selected nodes; otherwise only to the right-clicked node.
  const targetIds: string[] =
    selectedIds.includes(node.id) && selectedIds.length > 1
      ? selectedIds
      : [node.id];
  const isMulti = targetIds.length > 1;
  const targetSceneIds = targetIds.filter(
    (id) => allNodes.find((n) => n.id === id)?.nodeType === "scene",
  );

  async function handleToggleLabel(labelId: string) {
    const hasLabel = assignedLabelIds.includes(labelId);
    const labelStore = useLabelStore.getState();
    for (const id of targetIds) {
      const current = labelStore.nodeLabels[id] ?? [];
      const next = hasLabel
        ? current.filter((x) => x !== labelId)
        : current.includes(labelId)
          ? current
          : [...current, labelId];
      if (next !== current) {
        await labelStore.setNodeLabels(id, next);
      }
    }
  }

  async function handleSetStatus(status: SceneStatus) {
    for (const id of targetSceneIds) {
      await setStatus(id, status);
    }
  }

  async function handleDelete() {
    for (const id of targetIds) {
      await deleteNode(id).catch(() => {});
    }
  }

  // Close on outside click or Escape
  useEffect(() => {
    function handleMouseDown(e: MouseEvent) {
      if (!menuRef.current?.contains(e.target as Node)) onClose();
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  // Clamp to viewport
  const style: React.CSSProperties = {
    position: "fixed",
    left: Math.min(x, window.innerWidth - 200),
    top: Math.min(y, window.innerHeight - 300),
    zIndex: 9999,
  };

  function item(
    label: string,
    action: () => void,
    shortcut?: string,
    disabled?: boolean,
  ) {
    return (
      <button
        key={label}
        type="button"
        disabled={disabled}
        onClick={() => {
          if (!disabled) {
            action();
            onClose();
          }
        }}
        className={cn(
          "flex w-full items-center justify-between px-3 py-1.5 text-left text-xs",
          disabled
            ? "pointer-events-none text-muted-foreground/50"
            : "text-foreground hover:bg-accent",
        )}
      >
        <span>{label}</span>
        {shortcut && (
          <span className="ml-6 text-muted-foreground">{shortcut}</span>
        )}
      </button>
    );
  }

  function sep() {
    return <div className="my-1 border-t border-border" />;
  }

  const isScene = node.nodeType === "scene";
  const isFolder = node.nodeType === "folder";
  const isNote = node.nodeType === "note";
  const isContainer = isFolder;

  return createPortal(
    <div
      ref={menuRef}
      style={style}
      className="min-w-[192px] rounded-md border border-border bg-popover py-1 shadow-lg"
    >
      {/* Open (Scene/Note only) */}
      {(isScene || isNote) &&
        item(
          t("tree.openInEditor"),
          () => {
            useTabStore.getState().openPinned(node.id);
            setActiveScene(node.id);
          },
          "Enter",
        )}
      {(isScene || isNote) &&
        item(
          t("tree.openInSide"),
          () => {
            useTabStore.getState().openInSecondaryGroup(node.id);
            setActiveScene(node.id);
          },
          "Ctrl+Enter",
        )}
      {(isScene || isNote) && sep()}

      {/* Set Status (Scene only — submenu) */}
      {targetSceneIds.length > 0 && (
        <>
          <div
            className="relative"
            onMouseEnter={() => setStatusMenuOpen(true)}
            onMouseLeave={() => setStatusMenuOpen(false)}
          >
            <button
              type="button"
              className={cn(
                "flex w-full items-center gap-2 px-3 py-1.5 text-xs text-foreground hover:bg-accent",
                statusMenuOpen && "bg-accent",
              )}
            >
              <span>{t("tree.setStatus")}</span>
              <ChevronRight className="ml-auto h-3 w-3" />
            </button>
            {statusMenuOpen && (
              <div className="absolute left-full top-0 ml-1 min-w-[160px] rounded-md border border-border bg-popover py-1 shadow-md">
                {STATUS_OPTIONS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => {
                      void handleSetStatus(s);
                      onClose();
                    }}
                    className={cn(
                      "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-accent",
                      !isMulti &&
                        node.status === s &&
                        "font-medium text-foreground",
                    )}
                  >
                    <StatusDot status={s} />
                    <span>{STATUS_LABELS[s]}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          {sep()}
        </>
      )}

      {/* Rename */}
      {item(t("tree.rename"), onStartRename, "F2")}

      {/* Assign labels (scene / note) */}
      {(isScene || isNote) && (
        <div
          className="relative"
          onMouseEnter={() => setLabelMenuOpen(true)}
          onMouseLeave={() => setLabelMenuOpen(false)}
        >
          <button
            type="button"
            className={cn(
              "flex w-full items-center gap-2 px-3 py-1.5 text-xs text-foreground hover:bg-accent",
              labelMenuOpen && "bg-accent",
            )}
          >
            <Tag className="h-3 w-3" />
            <span>{t("tree.assignLabels")}</span>
            <ChevronRight className="ml-auto h-3 w-3" />
          </button>
          {labelMenuOpen && (
            <div className="absolute left-full top-0 ml-1 min-w-[180px] rounded-md border border-border bg-popover py-1 shadow-md">
              {allLabels.length === 0 && (
                <div className="px-3 py-1.5 text-xs text-muted-foreground">
                  {t("scenes.noLabels")}
                </div>
              )}
              {allLabels.map((label) => {
                const checked = assignedLabelIds.includes(label.id);
                return (
                  <button
                    key={label.id}
                    type="button"
                    onClick={() => void handleToggleLabel(label.id)}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-foreground hover:bg-accent"
                  >
                    {checked ? (
                      <Check className="h-3 w-3 shrink-0" />
                    ) : (
                      <span className="w-3 shrink-0" />
                    )}
                    <span
                      className="h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{
                        backgroundColor: resolveLabelColor(label.color),
                      }}
                    />
                    <span className="truncate">{label.name}</span>
                  </button>
                );
              })}
              {scenesContext && (
                <>
                  <div className="my-1 border-t border-border" />
                  <button
                    type="button"
                    onClick={() => {
                      scenesContext.openManageLabels();
                      onClose();
                    }}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-foreground hover:bg-accent"
                  >
                    <Settings className="h-3 w-3 shrink-0" />
                    <span>{t("tree.manageLabels")}</span>
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      )}

      {/* Add children inside folder */}
      {isFolder &&
        item(t("tree.addScene"), () => {
          createNode({ nodeType: "scene", parentId: node.id })
            .then((n) => {
              useTabStore.getState().openPinned(n.id);
            })
            .catch(() => {});
        })}
      {isFolder &&
        item(t("tree.addNote"), () => {
          createNode({ nodeType: "note", parentId: node.id })
            .then((n) => {
              useTabStore.getState().openPinned(n.id);
            })
            .catch(() => {});
        })}
      {isFolder &&
        item(t("tree.addFolder"), () => {
          createNode({ nodeType: "folder", parentId: node.id }).catch(() => {});
        })}

      {/* Add sibling below (scene / note) */}
      {(isScene || isNote) &&
        item(t("tree.addSceneBelow"), () => {
          createNode({
            nodeType: "scene",
            parentId: node.parentId,
            afterId: node.id,
          })
            .then((n) => {
              useTabStore.getState().openPinned(n.id);
            })
            .catch(() => {});
        })}
      {(isScene || isNote) &&
        item(t("tree.addNoteBelow"), () => {
          createNode({
            nodeType: "note",
            parentId: node.parentId,
            afterId: node.id,
          })
            .then((n) => {
              useTabStore.getState().openPinned(n.id);
            })
            .catch(() => {});
        })}
      {(isScene || isNote) &&
        item(t("tree.addFolderBelow"), () => {
          createNode({
            nodeType: "folder",
            parentId: node.parentId,
            afterId: node.id,
          }).catch(() => {});
        })}

      {isContainer && sep()}

      {/* Add to Map (scene / note only) */}
      {(isScene || isNote) && boards.length > 0 && (
        <>
          {sep()}
          <div
            className="relative"
            onMouseEnter={() => setMapMenuOpen(true)}
            onMouseLeave={() => setMapMenuOpen(false)}
          >
            <button
              type="button"
              className={cn(
                "flex w-full items-center gap-2 px-3 py-1.5 text-xs text-foreground hover:bg-accent",
                mapMenuOpen && "bg-accent",
              )}
            >
              <MapPin className="h-3 w-3" />
              <span>Map に追加</span>
              <ChevronRight className="ml-auto h-3 w-3" />
            </button>
            {mapMenuOpen && (
              <div className="absolute left-full top-0 ml-1 min-w-[160px] rounded-md border border-border bg-popover py-1 shadow-md">
                {boards.map((b) => (
                  <button
                    key={b.id}
                    type="button"
                    onClick={() => {
                      void addToBoard(b.id, {
                        nodeRefType: node.nodeType as "scene" | "note",
                        treeNodeId: node.id,
                      });
                      onClose();
                    }}
                    className="flex w-full items-center px-3 py-1.5 text-left text-xs text-foreground hover:bg-accent"
                  >
                    {b.title}
                  </button>
                ))}
              </div>
            )}
          </div>
        </>
      )}

      {/* Delete */}
      {sep()}
      {item(t("tree.delete"), () => void handleDelete(), "Del", false)}
    </div>,
    document.body,
  );
}
