import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { useTabStore } from "./tabStore";
import { useEditorSessionStore } from "./editorSessionStore";
import { useTreeStore } from "@/features/tree/treeStore";
import { useLayoutStore } from "@/features/layout/layoutStore";
import { discardDocumentInGroup, saveScene } from "./editorSaveRegistry";
import { UnsavedDialog } from "./UnsavedDialog";
import type { GroupIndex } from "./tabStore";

interface TabContextMenuProps {
  nodeId: string;
  groupIndex: GroupIndex;
  x: number;
  y: number;
  onClose: () => void;
}

// ---- Main context menu ----

export function TabContextMenu({
  nodeId,
  groupIndex,
  x,
  y,
  onClose,
}: TabContextMenuProps) {
  const { t } = useTranslation();
  const menuRef = useRef<HTMLDivElement>(null);
  const [pendingClose, setPendingClose] = useState<{
    nodeIds: string[];
  } | null>(null);

  const tabs = useTabStore((s) =>
    groupIndex === 0 ? s.tabs : s.secondaryTabs,
  );
  const activeTabId = useTabStore((s) =>
    groupIndex === 0 ? s.activeTabId : s.secondaryActiveTabId,
  );
  const secondaryGroupOpen = useTabStore((s) => s.secondaryGroupOpen);
  const dirtyTabIds = useEditorSessionStore((s) => s.dirtyDocumentIds);
  const node = useTreeStore((s) => s.nodes.find((n) => n.id === nodeId));

  const tabIndex = tabs.findIndex((t) => t.nodeId === nodeId);
  const isPreview = tabs[tabIndex]?.isPreview ?? false;
  const isScene = node?.nodeType === "scene" || node?.nodeType === "note";
  const isActiveTab = nodeId === activeTabId;

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
          {item(t("editor.tab.close"), () => closeTabs([nodeId]))}
          {item(
            t("editor.tab.closeOthers"),
            () => {
              const others = tabs
                .filter((t) => t.nodeId !== nodeId)
                .map((t) => t.nodeId);
              closeTabs(others);
            },
            !hasOthers,
          )}
          {item(
            t("editor.tab.closeRight"),
            () => {
              const right = tabs.slice(tabIndex + 1).map((t) => t.nodeId);
              closeTabs(right);
            },
            !hasRight,
          )}
          {item(
            t("editor.tab.closeLeft"),
            () => {
              const left = tabs.slice(0, tabIndex).map((t) => t.nodeId);
              closeTabs(left);
            },
            !hasLeft,
          )}
          {item(t("editor.tab.closeAll"), () => {
            const all = tabs.map((t) => t.nodeId);
            closeTabs(all);
          })}

          {/* "タブを固定する" is shown only for preview tabs */}
          {isPreview && (
            <>
              {SEP}
              {item(t("editor.tab.pin"), () => {
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

          {/* "右/下に分割" — only when right-clicking the active tab */}
          {isActiveTab && (
            <>
              {item(t("editor.tab.splitRight"), () => {
                useTabStore
                  .getState()
                  .openInSecondaryGroupDirectional(nodeId, "right");
                useTreeStore.getState().setActiveScene(nodeId);
                onClose();
              })}
              {item(t("editor.tab.splitBelow"), () => {
                useTabStore
                  .getState()
                  .openInSecondaryGroupDirectional(nodeId, "below");
                useTreeStore.getState().setActiveScene(nodeId);
                onClose();
              })}
              {SEP}
            </>
          )}

          {/* "移動" — move tab to the other group (always removes from source) */}
          {groupIndex === 0 ? (
            secondaryGroupOpen ? (
              // Secondary exists: move there (direction label matches current split)
              item(
                useTabStore.getState().splitDirection === "below"
                  ? t("editor.tab.moveBelow")
                  : t("editor.tab.moveRight"),
                () => {
                  useTabStore.getState().moveTabBetweenGroups(nodeId, 0, 1);
                  useTreeStore.getState().setActiveScene(nodeId);
                  onClose();
                },
              )
            ) : (
              // No secondary: create it with chosen direction and move the tab
              <>
                {item(t("editor.tab.moveRight"), () => {
                  useTabStore
                    .getState()
                    .moveTabBetweenGroups(nodeId, 0, 1, undefined, "right");
                  useTreeStore.getState().setActiveScene(nodeId);
                  onClose();
                })}
                {item(t("editor.tab.moveBelow"), () => {
                  useTabStore
                    .getState()
                    .moveTabBetweenGroups(nodeId, 0, 1, undefined, "below");
                  useTreeStore.getState().setActiveScene(nodeId);
                  onClose();
                })}
              </>
            )
          ) : (
            // Secondary → Primary
            item(t("editor.tab.movePrimary"), () => {
              useTabStore.getState().moveTabBetweenGroups(nodeId, 1, 0);
              useTreeStore.getState().setActiveScene(nodeId);
              onClose();
            })
          )}

          {isScene && SEP}

          {isScene &&
            item(t("editor.tab.showInScenes"), () => {
              useLayoutStore.getState().showPanel("scenes");
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
            for (const id of pendingClose.nodeIds) {
              discardDocumentInGroup(id, groupIndex);
            }
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
