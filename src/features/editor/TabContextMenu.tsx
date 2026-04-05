import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";
import { useTabStore } from "./tabStore";
import { useTreeStore } from "@/features/tree/treeStore";
import { useLayoutStore } from "@/features/layout/layoutStore";
import { saveScene } from "./editorSaveRegistry";
import type { GroupIndex } from "./tabStore";

interface TabContextMenuProps {
  nodeId: string;
  groupIndex: GroupIndex;
  x: number;
  y: number;
  onClose: () => void;
}

// ---- Unsaved-changes confirmation dialog ----

interface UnsavedDialogProps {
  count: number;
  onSaveAndClose: () => void;
  onCloseWithoutSave: () => void;
  onCancel: () => void;
}

function UnsavedDialog({
  count,
  onSaveAndClose,
  onCloseWithoutSave,
  onCancel,
}: UnsavedDialogProps) {
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onCancel();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return createPortal(
    <div
      ref={overlayRef}
      className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/40"
      onMouseDown={(e) => {
        if (e.target === overlayRef.current) onCancel();
      }}
    >
      <div className="min-w-[360px] rounded-lg border border-border bg-popover p-5 shadow-xl">
        <p className="mb-4 text-sm text-foreground">
          {count === 1
            ? "1個のタブに未保存の変更があります。保存しますか？"
            : `${count}個のタブに未保存の変更があります。保存しますか？`}
        </p>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent"
          >
            キャンセル
          </button>
          <button
            type="button"
            onClick={onCloseWithoutSave}
            className="rounded px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent"
          >
            保存せず閉じる
          </button>
          <button
            type="button"
            onClick={onSaveAndClose}
            className="rounded bg-primary px-3 py-1.5 text-xs text-primary-foreground hover:bg-primary/90"
          >
            すべて保存して閉じる
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ---- Main context menu ----

export function TabContextMenu({
  nodeId,
  groupIndex,
  x,
  y,
  onClose,
}: TabContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pendingClose, setPendingClose] = useState<{
    nodeIds: string[];
  } | null>(null);

  const tabs = useTabStore((s) =>
    groupIndex === 0 ? s.tabs : s.secondaryTabs,
  );
  const dirtyTabIds = useTabStore((s) => s.dirtyTabIds);
  const node = useTreeStore((s) => s.nodes.find((n) => n.id === nodeId));

  const tabIndex = tabs.findIndex((t) => t.nodeId === nodeId);
  const isPreview = tabs[tabIndex]?.isPreview ?? false;
  const isScene = node?.nodeType === "scene" || node?.nodeType === "note";

  const hasOthers = tabs.length > 1;
  const hasRight = tabIndex < tabs.length - 1;
  const hasLeft = tabIndex > 0;

  // Close on outside click or Escape
  useEffect(() => {
    function onMouseDown(e: MouseEvent) {
      if (!menuRef.current?.contains(e.target as Node)) onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const style: React.CSSProperties = {
    position: "fixed",
    left: Math.min(x, window.innerWidth - 210),
    top: Math.min(y, window.innerHeight - 340),
    zIndex: 9999,
  };

  // ---- Close helpers ----

  function closeTabs(nodeIds: string[]) {
    const dirty = nodeIds.filter((id) => dirtyTabIds.has(id));
    if (dirty.length > 0) {
      setPendingClose({ nodeIds });
      return;
    }
    executeClose(nodeIds);
  }

  function executeClose(nodeIds: string[]) {
    const store = useTabStore.getState();
    const treeState = useTreeStore.getState();

    for (const id of nodeIds) {
      if (groupIndex === 0) {
        store.closeTab(id);
      } else {
        store.closeSecondaryTab(id);
      }
    }

    // Update active scene after close
    const {
      activeTabId,
      secondaryActiveTabId,
      secondaryTabs: remaining,
    } = useTabStore.getState();
    if (groupIndex === 0 && activeTabId) {
      treeState.setActiveScene(activeTabId);
    } else if (groupIndex === 1) {
      if (remaining.length === 0 && activeTabId) {
        treeState.setActiveScene(activeTabId);
      } else if (secondaryActiveTabId) {
        treeState.setActiveScene(secondaryActiveTabId);
      }
    }
    onClose();
  }

  async function saveAndClose(nodeIds: string[]) {
    await Promise.all(nodeIds.map((id) => saveScene(id)));
    executeClose(nodeIds);
  }

  // ---- Menu item builder ----

  function item(label: string, action: () => void, disabled = false) {
    return (
      <button
        key={label}
        type="button"
        disabled={disabled}
        onClick={() => {
          if (!disabled) action();
        }}
        className={cn(
          "flex w-full items-center px-3 py-1.5 text-left text-xs",
          disabled
            ? "pointer-events-none text-muted-foreground/40"
            : "text-foreground hover:bg-accent",
        )}
      >
        {label}
      </button>
    );
  }

  const SEP = <div className="my-1 border-t border-border" />;

  return (
    <>
      {createPortal(
        <div
          ref={menuRef}
          style={style}
          className="min-w-[200px] rounded-md border border-border bg-popover py-1 shadow-lg"
        >
          {item("閉じる", () => closeTabs([nodeId]))}
          {item(
            "他を閉じる",
            () => {
              const others = tabs
                .filter((t) => t.nodeId !== nodeId)
                .map((t) => t.nodeId);
              closeTabs(others);
            },
            !hasOthers,
          )}
          {item(
            "右を閉じる",
            () => {
              const right = tabs.slice(tabIndex + 1).map((t) => t.nodeId);
              closeTabs(right);
            },
            !hasRight,
          )}
          {item(
            "左を閉じる",
            () => {
              const left = tabs.slice(0, tabIndex).map((t) => t.nodeId);
              closeTabs(left);
            },
            !hasLeft,
          )}
          {item("すべて閉じる", () => {
            const all = tabs.map((t) => t.nodeId);
            closeTabs(all);
          })}

          {/* "タブを固定する" is shown only for preview tabs */}
          {isPreview && (
            <>
              {SEP}
              {item("タブを固定する", () => {
                if (groupIndex === 0) {
                  useTabStore.getState().pinTab(nodeId);
                } else {
                  useTabStore.getState().pinSecondaryTab(nodeId);
                }
                onClose();
              })}
            </>
          )}

          {SEP}

          {item("右に分割", () => {
            useTabStore
              .getState()
              .openInSecondaryGroupDirectional(nodeId, "right");
            useTreeStore.getState().setActiveScene(nodeId);
            onClose();
          })}
          {item("下に分割", () => {
            useTabStore
              .getState()
              .openInSecondaryGroupDirectional(nodeId, "below");
            useTreeStore.getState().setActiveScene(nodeId);
            onClose();
          })}

          {isScene && SEP}

          {isScene &&
            item("Scenesで表示", () => {
              useLayoutStore.getState().togglePanel("scenes");
              useTreeStore.getState().revealInTree(nodeId);
              onClose();
            })}
        </div>,
        document.body,
      )}

      {pendingClose && (
        <UnsavedDialog
          count={
            pendingClose.nodeIds.filter((id) => dirtyTabIds.has(id)).length
          }
          onSaveAndClose={() => {
            saveAndClose(pendingClose.nodeIds).catch(console.error);
            setPendingClose(null);
          }}
          onCloseWithoutSave={() => {
            executeClose(pendingClose.nodeIds);
            setPendingClose(null);
          }}
          onCancel={() => {
            setPendingClose(null);
            onClose();
          }}
        />
      )}
    </>
  );
}
