import { useEffect, useState } from "react";
import { useSceneStore } from "./store";
import { useTreeStore } from "./treeStore";
import { TabBar } from "@/features/editor/TabBar";
import { Breadcrumb } from "@/features/editor/Breadcrumb";
import { EditorPane } from "@/features/editor/EditorPane";
import { useTabStore } from "@/features/editor/tabStore";
import { RevisionHistoryModal } from "@/features/revision/RevisionHistoryModal";
import { cn } from "@/lib/utils";
import { DRAG_DATA_KEY, DRAG_GROUP_KEY } from "@/features/editor/TabBar";
import type { GroupIndex } from "@/features/editor/tabStore";

interface DragPayload {
  nodeId: string;
  groupIndex: GroupIndex;
}

function EmptyGroupPlaceholder({ groupIndex }: { groupIndex: GroupIndex }) {
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
 * Full-area drop zone: overlaid on a group's content area.
 * Accepts drops from the OTHER group only (same-group drags are handled by the TabBar).
 */
function FullAreaDropZone({ targetGroup }: { targetGroup: GroupIndex }) {
  const [isOver, setIsOver] = useState(false);
  const otherGroup: GroupIndex = targetGroup === 0 ? 1 : 0;

  return (
    <div
      className={cn(
        "absolute inset-0 z-20 transition-colors",
        isOver
          ? "bg-primary/10 ring-2 ring-inset ring-primary/40"
          : "bg-transparent",
      )}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(DRAG_DATA_KEY)) return;
        // Only accept from the OTHER group
        if (!e.dataTransfer.types.includes(DRAG_GROUP_KEY(otherGroup))) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        setIsOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) {
          setIsOver(false);
        }
      }}
      onDrop={(e) => {
        e.preventDefault();
        setIsOver(false);
        const raw = e.dataTransfer.getData(DRAG_DATA_KEY);
        if (!raw) return;
        const { nodeId, groupIndex: srcGroup } = JSON.parse(raw) as DragPayload;
        if (srcGroup === targetGroup) return;
        useTabStore
          .getState()
          .moveTabBetweenGroups(nodeId, srcGroup, targetGroup);
        const newActive =
          targetGroup === 0
            ? useTabStore.getState().activeTabId
            : useTabStore.getState().secondaryActiveTabId;
        if (newActive) useTreeStore.getState().setActiveScene(newActive);
      }}
    />
  );
}

/**
 * Edge drop zones shown on the single (non-split) primary group.
 * Dropping on the right edge creates a right-split; bottom edge creates a below-split.
 */
function EdgeDropZones() {
  const [hoveredEdge, setHoveredEdge] = useState<"right" | "below" | null>(
    null,
  );

  function makeHandlers(direction: "right" | "below") {
    return {
      onDragOver(e: React.DragEvent) {
        if (!e.dataTransfer.types.includes(DRAG_DATA_KEY)) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "move";
        setHoveredEdge(direction);
      },
      onDragLeave(e: React.DragEvent) {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) {
          setHoveredEdge(null);
        }
      },
      onDrop(e: React.DragEvent) {
        e.preventDefault();
        e.stopPropagation();
        setHoveredEdge(null);
        const raw = e.dataTransfer.getData(DRAG_DATA_KEY);
        if (!raw) return;
        const { nodeId, groupIndex: srcGroup } = JSON.parse(raw) as DragPayload;
        useTabStore
          .getState()
          .moveTabBetweenGroups(nodeId, srcGroup, 1, undefined, direction);
        useTreeStore.getState().setActiveScene(nodeId);
      },
    };
  }

  return (
    <>
      {/* Right edge — 25% width, full height, lower z-index */}
      <div
        className={cn(
          "absolute bottom-0 right-0 top-0 z-20 w-1/4 transition-colors",
          hoveredEdge === "right"
            ? "bg-primary/20 ring-2 ring-inset ring-primary/50"
            : "bg-transparent",
        )}
        {...makeHandlers("right")}
      />
      {/* Bottom edge — 25% height, full width, higher z-index (covers corner) */}
      <div
        className={cn(
          "absolute bottom-0 left-0 right-0 z-30 h-1/4 transition-colors",
          hoveredEdge === "below"
            ? "bg-primary/20 ring-2 ring-inset ring-primary/50"
            : "bg-transparent",
        )}
        {...makeHandlers("below")}
      />
    </>
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

  const [isDraggingTab, setIsDraggingTab] = useState(false);

  useEffect(() => {
    function onDragStart() {
      setIsDraggingTab(true);
    }
    function onDragEnd() {
      setIsDraggingTab(false);
    }
    document.addEventListener("dragstart", onDragStart);
    document.addEventListener("dragend", onDragEnd);
    return () => {
      document.removeEventListener("dragstart", onDragStart);
      document.removeEventListener("dragend", onDragEnd);
    };
  }, []);

  // Ensure the active scene always has a tab (handles external changes like node creation).
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
      <Breadcrumb />

      <div className={splitClass}>
        {/* ---- Primary group ---- */}
        <div className={primaryClass}>
          <TabBar groupIndex={0} />
          <div className="relative flex-1 overflow-hidden">
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

            {isDraggingTab &&
              (secondaryGroupOpen ? (
                // Split view: accept drops from the secondary group across the full area
                <FullAreaDropZone targetGroup={0} />
              ) : (
                // Single group: right/bottom edge zones create a new split
                <EdgeDropZones />
              ))}
          </div>
        </div>

        {/* ---- Secondary group ---- */}
        {secondaryGroupOpen && (
          <div className={secondaryClass}>
            <TabBar groupIndex={1} />
            <div className="relative flex-1 overflow-hidden">
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

              {/* Secondary always accepts drops from primary across the full area */}
              {isDraggingTab && <FullAreaDropZone targetGroup={1} />}
            </div>
          </div>
        )}
      </div>

      <RevisionHistoryModal />
    </div>
  );
}
