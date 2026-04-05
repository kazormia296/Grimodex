import { useEffect } from "react";
import { useSceneStore } from "./store";
import { useTreeStore } from "./treeStore";
import { TabBar } from "@/features/editor/TabBar";
import { Breadcrumb } from "@/features/editor/Breadcrumb";
import { EditorPane } from "@/features/editor/EditorPane";
import { useTabStore } from "@/features/editor/tabStore";
import { RevisionHistoryModal } from "@/features/revision/RevisionHistoryModal";

function EmptyGroupPlaceholder({ groupIndex }: { groupIndex: 0 | 1 }) {
  return (
    <div
      className="flex flex-1 cursor-default select-none items-center justify-center text-xs text-muted-foreground/50"
      onClick={() => useTabStore.getState().setActiveGroup(groupIndex)}
    >
      エディタグループが空です
    </div>
  );
}

/**
 * SceneEditor renders one or two EditorPane instances.
 * Empty editor groups are allowed — they show a placeholder instead of an editor.
 */
export function SceneEditor() {
  const activeSceneId = useSceneStore((s) => s.activeSceneId);

  const primaryActiveTabId = useTabStore((s) => s.activeTabId);
  const secondaryActiveTabId = useTabStore((s) => s.secondaryActiveTabId);
  const secondaryGroupOpen = useTabStore((s) => s.secondaryGroupOpen);
  const activeGroupIndex = useTabStore((s) => s.activeGroupIndex);
  const splitDirection = useTabStore((s) => s.splitDirection);

  // Ensure the active scene always has a tab (handles external changes like node creation).
  // Only open editor tabs for scene/note types — folders have no content.
  useEffect(() => {
    if (!activeSceneId) return;
    const node = useTreeStore
      .getState()
      .nodes.find((n) => n.id === activeSceneId);
    if (!node || (node.nodeType !== "scene" && node.nodeType !== "note"))
      return;
    const { tabs } = useTabStore.getState();
    if (!tabs.find((t) => t.nodeId === activeSceneId)) {
      useTabStore.getState().openPreview(activeSceneId);
    }
  }, [activeSceneId]);

  // Sync activeGroupIndex → treeStore.activeSceneId
  useEffect(() => {
    if (activeGroupIndex === 0 && primaryActiveTabId) {
      useTreeStore.getState().setActiveScene(primaryActiveTabId);
    } else if (activeGroupIndex === 1 && secondaryActiveTabId) {
      useTreeStore.getState().setActiveScene(secondaryActiveTabId);
    }
  }, [activeGroupIndex, primaryActiveTabId, secondaryActiveTabId]);

  const primarySceneId = primaryActiveTabId;
  const secondarySceneId = secondaryActiveTabId;

  const splitClass =
    secondaryGroupOpen && splitDirection === "below"
      ? "flex flex-1 flex-col overflow-hidden"
      : "flex flex-1 overflow-hidden";

  const primaryClass = secondaryGroupOpen
    ? splitDirection === "below"
      ? "flex h-1/2 flex-col border-b border-border"
      : "flex w-1/2 flex-col border-r border-border"
    : "flex min-w-0 flex-1 flex-col";

  const secondaryClass =
    splitDirection === "below" ? "flex h-1/2 flex-col" : "flex w-1/2 flex-col";

  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      {/* Breadcrumb spans full width above the split */}
      <Breadcrumb />

      <div className={splitClass}>
        {/* Primary group */}
        <div className={primaryClass}>
          <TabBar groupIndex={0} />
          {primarySceneId ? (
            <EditorPane
              sceneId={primarySceneId}
              groupIndex={0}
              onFocus={() => {
                useTabStore.getState().setActiveGroup(0);
                useTreeStore.getState().setActiveScene(primarySceneId);
              }}
            />
          ) : (
            <EmptyGroupPlaceholder groupIndex={0} />
          )}
        </div>

        {/* Secondary group */}
        {secondaryGroupOpen && (
          <div className={secondaryClass}>
            <TabBar groupIndex={1} />
            {secondarySceneId ? (
              <EditorPane
                sceneId={secondarySceneId}
                groupIndex={1}
                onFocus={() => {
                  useTabStore.getState().setActiveGroup(1);
                  useTreeStore.getState().setActiveScene(secondarySceneId);
                }}
              />
            ) : (
              <EmptyGroupPlaceholder groupIndex={1} />
            )}
          </div>
        )}
      </div>

      <RevisionHistoryModal />
    </div>
  );
}
