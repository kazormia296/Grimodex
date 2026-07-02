import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { formatShortcut } from "@/lib/platform";
import { useTreeStore } from "@/features/tree/treeStore";
import { useTabStore } from "@/features/editor/tabStore";
import { StatusDot } from "@/features/tree/StatusDot";
import type { TreeNodeData, SceneStatus } from "@/features/tree/treeStore";
import type { AxisMode } from "./timelineStore";

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

interface Props {
  node: TreeNodeData;
  x: number;
  y: number;
  onClose: () => void;
  axisMode: AxisMode;
}

export function TimelineContextMenu({ node, x, y, onClose, axisMode }: Props) {
  const { t } = useTranslation();
  const menuRef = useRef<HTMLDivElement>(null);
  const setStatus = useTreeStore((s) => s.setStatus);
  const deleteNode = useTreeStore((s) => s.deleteNode);
  const updateStoryTime = useTreeStore((s) => s.updateStoryTime);
  const revealInTree = useTreeStore((s) => s.revealInTree);
  const setActiveScene = useTreeStore((s) => s.setActiveScene);

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

  // 開時にメニューへフォーカスを移し、close 時に元の要素へ復元する。
  // メニュー項目のクリックでエディタ等へフォーカスが移った場合は奪い返さない
  // （body に落ちた＝フォーカスが行方不明のときだけ復元する）。
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    menuRef.current?.focus();
    return () => {
      const active = document.activeElement;
      if (prev?.isConnected && (!active || active === document.body)) {
        prev.focus();
      }
    };
  }, []);

  const style: React.CSSProperties = {
    position: "fixed",
    left: Math.max(0, Math.min(x, window.innerWidth - 220)),
    top: Math.max(0, Math.min(y, window.innerHeight - 320)),
    zIndex: 9999,
  };

  function item(label: string, action: () => void, shortcut?: string) {
    return (
      <button
        key={label}
        type="button"
        onClick={() => {
          action();
          onClose();
        }}
        className="flex w-full items-center justify-between px-3 py-1.5 text-left text-xs text-foreground hover:bg-accent"
      >
        <span>{label}</span>
        {shortcut && (
          <span className="ml-6 text-muted-foreground">
            {formatShortcut(shortcut)}
          </span>
        )}
      </button>
    );
  }

  function sep() {
    return <div className="my-1 border-t border-border" />;
  }

  return createPortal(
    <div
      ref={menuRef}
      style={style}
      tabIndex={-1}
      className="min-w-[192px] rounded-md border border-border bg-popover py-1 shadow-lg"
    >
      {item(
        t("timeline.ctx.openInEditor", "Editor で開く"),
        () => {
          useTabStore.getState().openPinned(node.id);
          setActiveScene(node.id);
        },
        "Enter",
      )}
      {item(
        t("timeline.ctx.openInSide", "サイドで開く"),
        () => {
          useTabStore.getState().openInSecondaryGroup(node.id);
          setActiveScene(node.id);
        },
        "Ctrl+Enter",
      )}
      {sep()}

      {/* Set Status */}
      <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {t("tree.setStatus", "Set status")}
      </div>
      {STATUS_OPTIONS.map((s) => (
        <button
          key={s}
          type="button"
          onClick={() => {
            void setStatus(node.id, s);
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

      {/* Story-time specific actions */}
      {axisMode === "story" &&
        item(t("timeline.ctx.clearStoryTime", "Clear story-time"), () => {
          void updateStoryTime(node.id, null);
        })}
      {axisMode === "story" && sep()}

      {item(t("timeline.ctx.showInScenes", "Scenes で表示"), () =>
        revealInTree(node.id),
      )}
      {sep()}

      {item(
        t("timeline.ctx.delete", "削除"),
        () => void deleteNode(node.id),
        "Del",
      )}
    </div>,
    document.body,
  );
}
