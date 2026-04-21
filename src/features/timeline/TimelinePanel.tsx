import { useCallback } from "react";
import { useTreeStore } from "@/features/tree/treeStore";
import { useLayoutStore } from "@/features/layout/layoutStore";
import { computeGlobalSceneOrder } from "@/features/codex/phaseResolver";
import { useTimelineStore } from "./timelineStore";
import { TimelineHeader } from "./TimelineHeader";
import { TimelineViewport } from "./TimelineViewport";

export function TimelinePanel() {
  const nodes = useTreeStore((s) => s.nodes);
  const setActiveScene = useTreeStore((s) => s.setActiveScene);
  const selectNode = useTimelineStore((s) => s.selectNode);

  // Build reading-order scene list (DFS, scenes only, sorted by sortOrder)
  const sceneOrder = computeGlobalSceneOrder(nodes);
  const scenes = nodes
    .filter((n) => n.nodeType === "scene")
    .sort((a, b) => {
      const ia = sceneOrder.get(a.id) ?? 0;
      const ib = sceneOrder.get(b.id) ?? 0;
      return ia - ib;
    });

  const handleSelectScene = useCallback(
    (id: string) => {
      selectNode(id);
      setActiveScene(id);
      const { dockviewApi } = useLayoutStore.getState();
      if (!dockviewApi) return;
      const panel = dockviewApi.getPanel("editor");
      if (panel) {
        panel.api.setActive();
      } else {
        dockviewApi.addPanel({
          id: "editor",
          component: "editor",
          title: "Editor",
        });
      }
    },
    [selectNode, setActiveScene],
  );

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <TimelineHeader sceneCount={scenes.length} />
      <TimelineViewport scenes={scenes} onSelectScene={handleSelectScene} />
    </div>
  );
}
