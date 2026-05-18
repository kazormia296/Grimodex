import { useCallback, useMemo, useEffect, useRef } from "react";
import { generateKeyBetween } from "fractional-indexing";
import { useTreeStore } from "@/features/tree/treeStore";
import { computeGlobalSceneOrder } from "@/features/codex/phaseResolver";
import { cmpKeys } from "@/features/tree/fractionalIndex";
import { usePhaseStore } from "@/features/codex/phaseStore";
import { useCodexStore } from "@/features/codex/codexStore";
import { useTimelineStore } from "./timelineStore";
import { useTabStore } from "@/features/editor/tabStore";
import { computeFitZoom, ZOOM_STEP, STEP_BASE } from "./timelineZoom";
import { TimelineHeader } from "./TimelineHeader";
import { TimelineViewport, PAD_LEFT, PAD_RIGHT } from "./TimelineViewport";
import { TimelineInspector } from "./TimelineInspector";
import type { PhasePinData } from "./TimelineViewport";
import { recordMark } from "@/lib/perfLog";

export function TimelinePanel() {
  const __perfStart = performance.now();
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
  const clearSelection = useTimelineStore((s) => s.clearSelection);
  const setAxisMode = useTimelineStore((s) => s.setAxisMode);
  const setPendingEditNodeId = useTimelineStore((s) => s.setPendingEditNodeId);
  const rangeSelectTo = useTimelineStore((s) => s.rangeSelectTo);
  const deleteNode = useTreeStore((s) => s.deleteNode);
  const containerRef = useRef<HTMLDivElement>(null);
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
      useTabStore.getState().openPreview(id);
      setActiveScene(id);
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
    function handlePlainKeyDown(e: KeyboardEvent) {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.shiftKey && e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      if (!containerRef.current?.contains(document.activeElement)) return;
      const active = document.activeElement as HTMLElement | null;
      if (
        active &&
        (active.tagName === "INPUT" ||
          active.tagName === "TEXTAREA" ||
          active.isContentEditable)
      )
        return;

      switch (e.key) {
        case "Escape":
          e.preventDefault();
          clearSelection();
          break;
        case "1":
          e.preventDefault();
          setAxisMode("reading");
          break;
        case "2":
          e.preventDefault();
          setAxisMode("story");
          break;
        case "3":
          e.preventDefault();
          setAxisMode("write");
          break;
        case "Delete": {
          const { selectedNodeIds: ids } = useTimelineStore.getState();
          if (ids.length > 0) {
            e.preventDefault();
            for (const id of [...ids]) void deleteNode(id);
          }
          break;
        }
        case "Enter": {
          const { selectedNodeIds: ids } = useTimelineStore.getState();
          if (ids.length > 0) {
            e.preventDefault();
            useTabStore.getState().openPinned(ids[0]);
            setActiveScene(ids[0]);
          }
          break;
        }
        case "F2": {
          const {
            axisMode: curMode,
            selectedNodeIds: ids,
            inspectorOpen: isOpen,
          } = useTimelineStore.getState();
          if (curMode === "story" && ids.length > 0) {
            const targetId = ids[0];
            if (!nodes.some((n) => n.id === targetId)) break;
            e.preventDefault();
            setPendingEditNodeId(targetId);
            if (!isOpen) toggleInspector();
          }
          break;
        }
        case "ArrowRight": {
          const { selectedNodeIds: ids } = useTimelineStore.getState();
          e.preventDefault();
          if (ids.length === 0 && scenes.length > 0) {
            selectNode(scenes[0].id);
            break;
          }
          const refId = ids[ids.length - 1];
          const idx = scenes.findIndex((s) => s.id === refId);
          if (idx !== -1 && idx < scenes.length - 1) {
            const nextId = scenes[idx + 1].id;
            if (e.shiftKey) {
              rangeSelectTo(
                nextId,
                scenes.map((s) => s.id),
              );
            } else {
              selectNode(nextId);
            }
          }
          break;
        }
        case "ArrowLeft": {
          const { selectedNodeIds: ids } = useTimelineStore.getState();
          e.preventDefault();
          if (ids.length === 0 && scenes.length > 0) {
            selectNode(scenes[scenes.length - 1].id);
            break;
          }
          const refId = ids[0];
          const idx = scenes.findIndex((s) => s.id === refId);
          if (idx > 0) {
            const prevId = scenes[idx - 1].id;
            if (e.shiftKey) {
              rangeSelectTo(
                prevId,
                scenes.map((s) => s.id),
              );
            } else {
              selectNode(prevId);
            }
          }
          break;
        }
      }
    }
    document.addEventListener("keydown", handlePlainKeyDown);
    return () => document.removeEventListener("keydown", handlePlainKeyDown);
  }, [
    nodes,
    scenes,
    clearSelection,
    setAxisMode,
    deleteNode,
    selectNode,
    setActiveScene,
    setPendingEditNodeId,
    rangeSelectTo,
    toggleInspector,
  ]);

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
        case "Enter": {
          if (!containerRef.current?.contains(document.activeElement)) break;
          const { selectedNodeIds: ids } = useTimelineStore.getState();
          if (ids.length > 0) {
            e.preventDefault();
            useTabStore.getState().openInSecondaryGroup(ids[0]);
            setActiveScene(ids[0]);
          }
          break;
        }
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
  }, [zoom, setZoom, scenes.length, weights, scheduledCount, setActiveScene]);

  const __renderResult = (
    <div
      ref={containerRef}
      tabIndex={-1}
      data-testid="timeline-panel"
      className="flex h-full flex-col overflow-hidden"
    >
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
  recordMark(
    "timelinePanel.render",
    performance.now() - __perfStart,
    __perfStart,
  );
  return __renderResult;
}
