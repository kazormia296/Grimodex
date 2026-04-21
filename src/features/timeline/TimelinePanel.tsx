import { useCallback, useMemo, useEffect, useRef } from "react";
import { generateKeyBetween } from "fractional-indexing";
import { useTreeStore } from "@/features/tree/treeStore";
import { useLayoutStore } from "@/features/layout/layoutStore";
import { computeGlobalSceneOrder } from "@/features/codex/phaseResolver";
import { cmpKeys } from "@/features/tree/fractionalIndex";
import { usePhaseStore } from "@/features/codex/phaseStore";
import { useCodexStore } from "@/features/codex/codexStore";
import { useTimelineStore } from "./timelineStore";
import { computeFitZoom, ZOOM_STEP, STEP_BASE } from "./timelineZoom";
import { TimelineHeader } from "./TimelineHeader";
import { TimelineViewport, PAD_LEFT, PAD_RIGHT } from "./TimelineViewport";
import { TimelineInspector } from "./TimelineInspector";
import type { PhasePinData } from "./TimelineViewport";

export function TimelinePanel() {
  const nodes = useTreeStore((s) => s.nodes);
  const setActiveScene = useTreeStore((s) => s.setActiveScene);
  const updateStoryTime = useTreeStore((s) => s.updateStoryTime);
  const axisMode = useTimelineStore((s) => s.axisMode);
  const spacingMode = useTimelineStore((s) => s.spacingMode);
  const selectNode = useTimelineStore((s) => s.selectNode);
  const selectedNodeIds = useTimelineStore((s) => s.selectedNodeIds);
  const inspectorOpen = useTimelineStore((s) => s.inspectorOpen);
  const toggleInspector = useTimelineStore((s) => s.toggleInspector);
  const zoom = useTimelineStore((s) => s.zoom);
  const setZoom = useTimelineStore((s) => s.setZoom);
  const viewportRef = useRef<HTMLDivElement>(null);
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

  const handleDropStoryTime = useCallback(
    (
      nodeId: string,
      prevKey: string | null,
      nextKey: string | null,
      toUnscheduled: boolean,
    ) => {
      if (toUnscheduled) {
        void updateStoryTime(nodeId, null);
        return;
      }
      const newKey = generateKeyBetween(prevKey, nextKey);
      void updateStoryTime(nodeId, newKey);
    },
    [updateStoryTime],
  );

  const selectedNode = useMemo(
    () => nodes.find((n) => n.id === selectedNodeIds[0]) ?? null,
    [nodes, selectedNodeIds],
  );

  const handleUpdateStoryTimeLabel = useCallback(
    (id: string, label: string) => {
      void updateStoryTime(
        id,
        nodes.find((n) => n.id === id)?.storyTimeOrder ?? null,
        label,
      );
    },
    [updateStoryTime, nodes],
  );

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

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (!e.ctrlKey && !e.metaKey) return;
      // Don't steal shortcuts while a text input or TipTap editor is focused
      const active = document.activeElement as HTMLElement | null;
      if (
        active &&
        (active.tagName === "INPUT" ||
          active.tagName === "TEXTAREA" ||
          active.isContentEditable)
      )
        return;
      switch (e.key) {
        case "0":
          e.preventDefault();
          if (viewportRef.current) {
            // Proportional mode: SVG width = PAD_LEFT + visibleForWidth*STEP*2 + PAD_RIGHT
            // Uniform mode:      SVG width = PAD_LEFT + scenes.length*STEP + PAD_RIGHT
            const visibleForFit =
              scheduledCount !== null
                ? Math.max(scheduledCount, 1)
                : scenes.length;
            const baseCount =
              weights != null ? visibleForFit * 2 : scenes.length;
            setZoom(
              computeFitZoom(
                baseCount,
                viewportRef.current.clientWidth,
                STEP_BASE,
                PAD_LEFT + PAD_RIGHT,
              ),
            );
          }
          break;
        case "+":
        case "=":
          e.preventDefault();
          setZoom(zoom * ZOOM_STEP);
          break;
        case "-":
          e.preventDefault();
          setZoom(zoom / ZOOM_STEP);
          break;
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [zoom, setZoom, scenes.length, weights, scheduledCount]);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <TimelineHeader
        sceneCount={scenes.length}
        scheduledCount={scheduledCount}
        inspectorOpen={inspectorOpen}
        onToggleInspector={toggleInspector}
      />
      <div className="flex flex-1 overflow-hidden">
        <TimelineViewport
          ref={viewportRef}
          scenes={scenes}
          weights={weights}
          phasePins={phasePins}
          unscheduledStartIndex={
            axisMode === "story" && scheduledCount !== null
              ? scheduledCount
              : undefined
          }
          onDropStoryTime={
            axisMode === "story" ? handleDropStoryTime : undefined
          }
          onSelectScene={handleSelectScene}
        />
        {inspectorOpen && selectedNode && (
          <TimelineInspector
            node={selectedNode}
            onClose={toggleInspector}
            onUpdateStoryTimeLabel={handleUpdateStoryTimeLabel}
          />
        )}
      </div>
    </div>
  );
}
