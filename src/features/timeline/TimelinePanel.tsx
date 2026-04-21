import { useCallback, useMemo } from "react";
import { useTreeStore } from "@/features/tree/treeStore";
import { useLayoutStore } from "@/features/layout/layoutStore";
import { computeGlobalSceneOrder } from "@/features/codex/phaseResolver";
import { cmpKeys } from "@/features/tree/fractionalIndex";
import { usePhaseStore } from "@/features/codex/phaseStore";
import { useCodexStore } from "@/features/codex/codexStore";
import { useTimelineStore } from "./timelineStore";
import { TimelineHeader } from "./TimelineHeader";
import { TimelineViewport } from "./TimelineViewport";
import type { PhasePinData } from "./TimelineViewport";

export function TimelinePanel() {
  const nodes = useTreeStore((s) => s.nodes);
  const setActiveScene = useTreeStore((s) => s.setActiveScene);
  const axisMode = useTimelineStore((s) => s.axisMode);
  const spacingMode = useTimelineStore((s) => s.spacingMode);
  const selectNode = useTimelineStore((s) => s.selectNode);
  const phasesByEntry = usePhaseStore((s) => s.phasesByEntry);
  const entries = useCodexStore((s) => s.entries);

  const sceneNodes = useMemo(
    () => nodes.filter((n) => n.nodeType === "scene"),
    [nodes],
  );

  // Build sorted scene list and optional position weights per axis mode
  const { scenes, weights } = useMemo(() => {
    if (axisMode === "reading") {
      const order = computeGlobalSceneOrder(nodes);
      const sorted = [...sceneNodes].sort(
        (a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0),
      );
      return { scenes: sorted, weights: null };
    }

    if (axisMode === "story") {
      const scheduled = sceneNodes.filter((n) => n.storyTimeOrder !== null);
      const unscheduled = sceneNodes.filter((n) => n.storyTimeOrder === null);
      scheduled.sort((a, b) => cmpKeys(a.storyTimeOrder!, b.storyTimeOrder!));
      // reading-order fallback for unscheduled
      const readOrder = computeGlobalSceneOrder(nodes);
      unscheduled.sort(
        (a, b) => (readOrder.get(a.id) ?? 0) - (readOrder.get(b.id) ?? 0),
      );
      const sorted = [...scheduled, ...unscheduled];
      // For proportional spacing: use index within scheduled portion
      const ws =
        spacingMode === "proportional" && scheduled.length > 1
          ? scheduled.map((_, i) => i / (scheduled.length - 1))
          : null;
      return { scenes: sorted, weights: ws, scheduledCount: scheduled.length };
    }

    // write-order: sort by createdAt
    const sorted = [...sceneNodes].sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    );
    const ws =
      spacingMode === "proportional" && sorted.length > 1
        ? (() => {
            const t0 = Date.parse(sorted[0].createdAt);
            const t1 = Date.parse(sorted[sorted.length - 1].createdAt);
            const span = t1 - t0 || 1;
            return sorted.map((n) => (Date.parse(n.createdAt) - t0) / span);
          })()
        : null;
    return { scenes: sorted, weights: ws };
  }, [axisMode, spacingMode, sceneNodes, nodes]);

  // Build phase pins from phaseStore + codexStore
  const phasePins = useMemo<PhasePinData[]>(() => {
    const entryMap = new Map(entries.map((e) => [e.id, e.name]));
    const pins: PhasePinData[] = [];
    for (const [entryId, phases] of Object.entries(phasesByEntry)) {
      const entryName = entryMap.get(entryId) ?? entryId;
      for (const phase of phases) {
        if (phase.anchorNodeId) {
          pins.push({
            nodeId: phase.anchorNodeId,
            label: phase.label,
            entryName,
          });
        }
      }
    }
    return pins;
  }, [phasesByEntry, entries]);

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

  // For story-time: how many scenes have story_time_order set
  const scheduledCount = useMemo(
    () =>
      axisMode === "story"
        ? sceneNodes.filter((n) => n.storyTimeOrder !== null).length
        : null,
    [axisMode, sceneNodes],
  );

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <TimelineHeader
        sceneCount={scenes.length}
        scheduledCount={scheduledCount}
      />
      <TimelineViewport
        scenes={scenes}
        weights={weights}
        phasePins={phasePins}
        unscheduledStartIndex={
          axisMode === "story" && scheduledCount !== null
            ? scheduledCount
            : undefined
        }
        onSelectScene={handleSelectScene}
      />
    </div>
  );
}
