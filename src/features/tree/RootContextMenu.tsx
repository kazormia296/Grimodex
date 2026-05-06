import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useTabStore } from "@/features/editor/tabStore";
import type { TreeNodeData, NodeType } from "./treeStore";

export interface RootContextMenuProps {
  x: number;
  y: number;
  onClose: () => void;
  createNode: (opts: {
    nodeType: NodeType;
    parentId: string | null;
  }) => Promise<TreeNodeData>;
}

export function RootContextMenu({
  x,
  y,
  onClose,
  createNode,
}: RootContextMenuProps) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onMouseDown(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) onClose();
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  const style: React.CSSProperties = {
    position: "fixed",
    left: Math.min(x, window.innerWidth - 200),
    top: Math.min(y, window.innerHeight - 200),
    zIndex: 9999,
  };

  function item(label: string, action: () => void) {
    return (
      <button
        key={label}
        type="button"
        onClick={() => {
          action();
          onClose();
        }}
        className="flex w-full items-center px-3 py-1.5 text-left text-xs text-foreground hover:bg-accent"
      >
        {label}
      </button>
    );
  }

  return createPortal(
    <div
      ref={ref}
      style={style}
      className="min-w-[192px] rounded-md border border-border bg-popover py-1 shadow-lg"
    >
      {item(t("scenes.addScene"), () => {
        createNode({ nodeType: "scene", parentId: null })
          .then((n) => {
            useTabStore.getState().openPinned(n.id);
          })
          .catch(() => {});
      })}
      {item(t("scenes.addNote"), () => {
        createNode({ nodeType: "note", parentId: null })
          .then((n) => {
            useTabStore.getState().openPinned(n.id);
          })
          .catch(() => {});
      })}
      {item(t("scenes.addFolder"), () => {
        createNode({ nodeType: "folder", parentId: null }).catch(() => {});
      })}
    </div>,
    document.body,
  );
}
