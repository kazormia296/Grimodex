import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { useTreeStore } from "./treeStore";
import { useTabStore } from "@/features/editor/tabStore";
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

      {/* Set Status (Scene only) */}
      {isScene && (
        <>
          <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            {t("tree.setStatus")}
          </div>
          {STATUS_OPTIONS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => {
                setStatus(node.id, s);
                onClose();
              }}
              className={cn(
                "flex w-full items-center gap-2 px-3 py-1.5 text-xs hover:bg-accent",
                node.status === s && "font-medium text-foreground",
              )}
            >
              <StatusDot status={s} />
              {STATUS_LABELS[s]}
            </button>
          ))}
          {sep()}
        </>
      )}

      {/* Rename */}
      {item(t("tree.rename"), onStartRename, "F2")}

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

      {/* Delete */}
      {sep()}
      {item(
        t("tree.delete"),
        () => deleteNode(node.id).catch(() => {}),
        "Del",
        false,
      )}
    </div>,
    document.body,
  );
}
