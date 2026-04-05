import { useEffect } from "react";
import { useSceneStore } from "./store";
import { useTreeStore } from "./treeStore";
import { TabBar } from "@/features/editor/TabBar";
import { Breadcrumb } from "@/features/editor/Breadcrumb";
import { EditorPane } from "@/features/editor/EditorPane";
import { useTabStore } from "@/features/editor/tabStore";
import { RevisionHistoryModal } from "@/features/revision/RevisionHistoryModal";

/**
 * SceneEditor is a container that renders one or two EditorPane instances
 * depending on whether the secondary editor group is active.
 *
 * - Single pane: primary group only (default)
 * - Split pane: primary + secondary group (triggered by Ctrl+Enter)
 *
 * Content synchronization for the same scene open in both groups is handled
 * internally by EditorPane via sceneContentStore.
 */
export function SceneEditor() {
  const activeSceneId = useSceneStore((s) => s.activeSceneId);

  const primaryActiveTabId = useTabStore((s) => s.activeTabId);
  const secondaryActiveTabId = useTabStore((s) => s.secondaryActiveTabId);
  const secondaryTabs = useTabStore((s) => s.secondaryTabs);
  const activeGroupIndex = useTabStore((s) => s.activeGroupIndex);

  const hasSecondaryGroup = secondaryTabs.length > 0;

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
  // so chat context / codex quick always reflect the focused pane
  useEffect(() => {
    if (activeGroupIndex === 0 && primaryActiveTabId) {
      useTreeStore.getState().setActiveScene(primaryActiveTabId);
    } else if (activeGroupIndex === 1 && secondaryActiveTabId) {
      useTreeStore.getState().setActiveScene(secondaryActiveTabId);
    }
  }, [activeGroupIndex, primaryActiveTabId, secondaryActiveTabId]);

  const primarySceneId = primaryActiveTabId ?? activeSceneId;
  const secondarySceneId = secondaryActiveTabId;

  return (
    <div className="flex h-full flex-col">
      {/* Breadcrumb spans full width above the split */}
      <Breadcrumb />

      <div className="flex flex-1 overflow-hidden">
        {/* Primary group */}
        <div
          className={
            hasSecondaryGroup
              ? "flex w-1/2 flex-col border-r border-border"
              : "flex flex-1 flex-col"
          }
        >
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
          ) : null}
        </div>

        {/* Secondary group (only when there are secondary tabs) */}
        {hasSecondaryGroup && secondarySceneId && (
          <div className="flex w-1/2 flex-col">
            <TabBar groupIndex={1} />
            <EditorPane
              sceneId={secondarySceneId}
              groupIndex={1}
              onFocus={() => {
                useTabStore.getState().setActiveGroup(1);
                useTreeStore.getState().setActiveScene(secondarySceneId);
              }}
            />
          </div>
        )}
      </div>

      <RevisionHistoryModal />
    </div>
  );
}
