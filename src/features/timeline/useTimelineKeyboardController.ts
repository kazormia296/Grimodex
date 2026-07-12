import { useEffect, type RefObject } from "react";
import { cmpKeys } from "@/features/tree/fractionalIndex";
import type { TreeNodeData } from "@/features/tree/treeStore";
import { openEditorDocument } from "@/application/editor/openEditorDocument";
import { defaultEditorNavigationPorts } from "@/features/editor/editorNavigationPorts";
import { usePlotThreadStore } from "@/features/plot-threads/plotThreadStore";
import { useTimelineStore } from "./timelineStore";
import { computeFitZoom, STEP_BASE, ZOOM_STEP } from "./timelineZoom";
import { PAD_LEFT, PAD_RIGHT, SUBWAY_LABEL_GUTTER } from "./TimelineViewport";

export interface TimelineKeyboardControllerOptions {
  containerRef: RefObject<HTMLDivElement | null>;
  viewportRef: RefObject<HTMLDivElement | null>;
  nodes: readonly TreeNodeData[];
  scenes: readonly { id: string }[];
  showThreads: boolean;
  scheduledCount: number | null;
  weights: number[] | null;
  zoom: number;
  setZoom: (zoom: number) => void;
  clearSelection: () => void;
  setAxisMode: (mode: "reading" | "story" | "write") => void;
  deleteNode: (id: string) => Promise<unknown>;
  selectNode: (id: string) => void;
  setPendingEditNodeId: (id: string | null) => void;
  rangeSelectTo: (id: string, orderedIds: string[]) => void;
  toggleInspector: () => void;
  setPendingThreadDelete: (
    value: {
      id: string;
      name: string;
      markerCount: number;
      edgeCount: number;
    } | null,
  ) => void;
}

/** Owns Timeline keyboard shortcuts and keeps destructive plot actions out of the panel view. */
export function useTimelineKeyboardController({
  containerRef,
  viewportRef,
  nodes,
  scenes,
  showThreads,
  scheduledCount,
  weights,
  zoom,
  setZoom,
  clearSelection,
  setAxisMode,
  deleteNode,
  selectNode,
  setPendingEditNodeId,
  rangeSelectTo,
  toggleInspector,
  setPendingThreadDelete,
}: TimelineKeyboardControllerOptions): void {
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

      function plotNav(dir: "up" | "down" | "left" | "right"): boolean {
        const tl = useTimelineStore.getState();
        if (!tl.showThreads) return false;
        const ts = usePlotThreadStore.getState().threads;
        const ls = usePlotThreadStore.getState().links;
        if (ts.length === 0) return false;
        const horizontal = dir === "left" || dir === "right";
        const hasSel = !!(tl.selectedPlotLinkId || tl.selectedPlotThreadId);
        if (horizontal && !hasSel) return false;
        const ordered = [...ts].sort((a, b) => {
          const c = cmpKeys(a.sortOrder, b.sortOrder);
          return c !== 0 ? c : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
        });
        const colOf = (nodeId: string) =>
          scenes.findIndex((scene) => scene.id === nodeId);
        const markersOf = (tid: string) =>
          ls
            .filter((link) => link.threadId === tid && colOf(link.nodeId) >= 0)
            .sort((a, b) => colOf(a.nodeId) - colOf(b.nodeId));
        const select = (next: { threadId?: string; linkId?: string }) => {
          if (next.linkId) {
            const threadId =
              ls.find((link) => link.id === next.linkId)?.threadId ?? null;
            tl.setSelectedPlotThreadId(threadId);
            tl.setSelectedPlotLinkId(next.linkId);
          } else {
            tl.setSelectedPlotThreadId(next.threadId ?? null);
            tl.setSelectedPlotLinkId(null);
          }
          if (!tl.inspectorOpen) toggleInspector();
          containerRef.current?.focus();
        };
        const curLink = tl.selectedPlotLinkId
          ? ls.find((link) => link.id === tl.selectedPlotLinkId)
          : undefined;
        const curThreadId = curLink?.threadId ?? tl.selectedPlotThreadId;
        const curCol = curLink ? colOf(curLink.nodeId) : null;

        if (horizontal) {
          if (!curThreadId) return false;
          const markers = markersOf(curThreadId);
          if (markers.length === 0) return true;
          if (!curLink) {
            select({
              linkId:
                dir === "right"
                  ? markers[0].id
                  : markers[markers.length - 1].id,
            });
            return true;
          }
          const index = markers.findIndex((marker) => marker.id === curLink.id);
          const nextIndex = Math.min(
            markers.length - 1,
            Math.max(0, index + (dir === "right" ? 1 : -1)),
          );
          select({ linkId: markers[nextIndex].id });
          return true;
        }

        const currentIndex = curThreadId
          ? ordered.findIndex((thread) => thread.id === curThreadId)
          : -1;
        const delta = dir === "down" ? 1 : -1;
        const nextIndex =
          currentIndex === -1
            ? delta === 1
              ? 0
              : ordered.length - 1
            : Math.min(ordered.length - 1, Math.max(0, currentIndex + delta));
        const nextThread = ordered[nextIndex];
        if (!nextThread) return true;
        const markers = markersOf(nextThread.id);
        if (markers.length === 0) {
          select({ threadId: nextThread.id });
          return true;
        }
        if (curCol == null) {
          select({ linkId: markers[0].id });
          return true;
        }
        let best = markers[0];
        let bestDistance = Math.abs(colOf(best.nodeId) - curCol);
        for (const marker of markers) {
          const distance = Math.abs(colOf(marker.nodeId) - curCol);
          if (distance < bestDistance) {
            best = marker;
            bestDistance = distance;
          }
        }
        select({ linkId: best.id });
        return true;
      }

      switch (e.key) {
        case "Escape":
          e.preventDefault();
          clearSelection();
          useTimelineStore.getState().setSelectedPlotThreadId(null);
          useTimelineStore.getState().setSelectedPlotLinkId(null);
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
          if (e.repeat) {
            e.preventDefault();
            break;
          }
          const ps = useTimelineStore.getState();
          if (ps.selectedPlotLinkId) {
            e.preventDefault();
            const linkId = ps.selectedPlotLinkId;
            useTimelineStore.getState().setSelectedPlotLinkId(null);
            void usePlotThreadStore.getState().deleteMarker(linkId);
            break;
          }
          if (ps.selectedPlotThreadId) {
            e.preventDefault();
            const threadId = ps.selectedPlotThreadId;
            const plotThreads = usePlotThreadStore.getState();
            const markerCount = plotThreads.links.filter(
              (link) => link.threadId === threadId,
            ).length;
            const edgeCount = plotThreads.branches.filter(
              (branch) =>
                branch.fromThreadId === threadId ||
                branch.toThreadId === threadId,
            ).length;
            if (markerCount > 0 || edgeCount > 0) {
              const thread = plotThreads.threads.find(
                (item) => item.id === threadId,
              );
              setPendingThreadDelete({
                id: threadId,
                name: thread?.name ?? "",
                markerCount,
                edgeCount,
              });
            } else {
              clearSelection();
              void plotThreads.deleteThread(threadId);
            }
            break;
          }
          const { selectedNodeIds: ids } = ps;
          if (ids.length > 0) {
            e.preventDefault();
            for (const id of [...ids]) void deleteNode(id);
          }
          break;
        }
        case "Enter": {
          const {
            selectedNodeIds: ids,
            selectedPlotLinkId,
            selectedPlotThreadId,
          } = useTimelineStore.getState();
          if (selectedPlotLinkId || selectedPlotThreadId) break;
          if (ids.length > 0) {
            e.preventDefault();
            openEditorDocument(
              {
                target: { kind: "scene", documentId: ids[0] },
                mode: "pinned",
                revealEditor: true,
                focusEditor: false,
                syncSceneContext: true,
              },
              defaultEditorNavigationPorts,
            );
          }
          break;
        }
        case "F2": {
          const state = useTimelineStore.getState();
          if (state.selectedPlotLinkId || state.selectedPlotThreadId) break;
          if (state.axisMode === "story" && state.selectedNodeIds.length > 0) {
            const targetId = state.selectedNodeIds[0];
            if (!nodes.some((node) => node.id === targetId)) break;
            e.preventDefault();
            setPendingEditNodeId(targetId);
            if (!state.inspectorOpen) toggleInspector();
          }
          break;
        }
        case "ArrowRight":
        case "ArrowLeft": {
          if (plotNav(e.key === "ArrowRight" ? "right" : "left")) {
            e.preventDefault();
            break;
          }
          const ids = useTimelineStore.getState().selectedNodeIds;
          e.preventDefault();
          if (ids.length === 0 && scenes.length > 0) {
            selectNode(
              e.key === "ArrowRight"
                ? scenes[0].id
                : scenes[scenes.length - 1].id,
            );
            break;
          }
          const refId = e.key === "ArrowRight" ? ids[ids.length - 1] : ids[0];
          const index = scenes.findIndex((scene) => scene.id === refId);
          const nextIndex = e.key === "ArrowRight" ? index + 1 : index - 1;
          if (index !== -1 && nextIndex >= 0 && nextIndex < scenes.length) {
            const nextId = scenes[nextIndex].id;
            if (e.shiftKey)
              rangeSelectTo(
                nextId,
                scenes.map((scene) => scene.id),
              );
            else selectNode(nextId);
          }
          break;
        }
        case "ArrowUp":
          if (plotNav("up")) e.preventDefault();
          break;
        case "ArrowDown":
          if (plotNav("down")) e.preventDefault();
          break;
      }
    }
    document.addEventListener("keydown", handlePlainKeyDown);
    return () => document.removeEventListener("keydown", handlePlainKeyDown);
  }, [
    containerRef,
    nodes,
    scenes,
    clearSelection,
    setAxisMode,
    deleteNode,
    selectNode,
    setPendingEditNodeId,
    rangeSelectTo,
    toggleInspector,
    setPendingThreadDelete,
  ]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (!e.ctrlKey && !e.metaKey) return;
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
          const ids = useTimelineStore.getState().selectedNodeIds;
          if (ids.length > 0) {
            e.preventDefault();
            openEditorDocument(
              {
                target: { kind: "scene", documentId: ids[0] },
                group: 1,
                mode: "pinned",
                revealEditor: true,
                focusEditor: false,
                syncSceneContext: true,
              },
              defaultEditorNavigationPorts,
            );
          }
          break;
        }
        case "0":
          e.preventDefault();
          if (viewportRef.current) {
            const visibleForFit =
              scheduledCount !== null
                ? Math.max(scheduledCount, 1)
                : scenes.length;
            const baseCount =
              weights != null ? visibleForFit * 2 : scenes.length;
            const padLeftForFit = showThreads ? SUBWAY_LABEL_GUTTER : PAD_LEFT;
            setZoom(
              computeFitZoom(
                baseCount,
                viewportRef.current.clientWidth,
                STEP_BASE,
                padLeftForFit + PAD_RIGHT,
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
        case "ArrowLeft":
        case "ArrowRight":
        case "ArrowUp":
        case "ArrowDown": {
          if (!containerRef.current?.contains(document.activeElement)) break;
          const element = viewportRef.current;
          if (!element) break;
          e.preventDefault();
          const step = 80;
          if (e.key === "ArrowLeft") element.scrollLeft -= step;
          else if (e.key === "ArrowRight") element.scrollLeft += step;
          else if (e.key === "ArrowUp") element.scrollTop -= step;
          else element.scrollTop += step;
          break;
        }
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [
    containerRef,
    viewportRef,
    zoom,
    setZoom,
    scenes.length,
    weights,
    scheduledCount,
    showThreads,
  ]);
}
