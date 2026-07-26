import { useEffect, type RefObject } from "react";
import type { TreeNodeData } from "@/features/tree/treeStore";
import { useForeshadowStore } from "@/features/foreshadow/foreshadowStore";
import { useLabelStore } from "@/features/labels/labelStore";
import { useGridStore } from "./gridStore";
import { resolveContainerForScene } from "./gridReveal";

export interface GridPanelLifecycleOptions {
  projectId: string;
  loadForProject(projectId: string): Promise<void>;
  pendingRevealSceneId: string | null;
  nodes: readonly TreeNodeData[];
  flatOrder: readonly string[];
  setContainerId(projectId: string, containerId: string | null): Promise<void>;
  clearSelection(): void;
  selectAll(ids: readonly string[]): void;
  panelRef: RefObject<HTMLDivElement | null>;
  deleteConfirmOpen: boolean;
}

/** Coordinates Grid's project snapshot, cross-panel reveal, and panel shortcuts. */
export function useGridPanelLifecycle({
  projectId,
  loadForProject,
  pendingRevealSceneId,
  nodes,
  flatOrder,
  setContainerId,
  clearSelection,
  selectAll,
  panelRef,
  deleteConfirmOpen,
}: GridPanelLifecycleOptions): void {
  useEffect(() => {
    void loadForProject(projectId);
    void useLabelStore.getState().load(projectId);
    void useForeshadowStore.getState().load(projectId);
  }, [projectId, loadForProject]);

  useEffect(() => {
    function isEditableTarget(): boolean {
      const element = document.activeElement;
      if (!element) return false;
      if (
        element.tagName === "INPUT" ||
        element.tagName === "TEXTAREA" ||
        element.tagName === "SELECT"
      )
        return true;
      return (element as HTMLElement).isContentEditable;
    }

    function handleKey(event: KeyboardEvent) {
      if (isEditableTarget()) return;
      if (event.key === "Escape" && !deleteConfirmOpen) clearSelection();
      if (
        (event.key === "a" || event.key === "A") &&
        (event.metaKey || event.ctrlKey) &&
        !event.shiftKey
      ) {
        const panel = panelRef.current;
        if (
          panel &&
          (panel.contains(document.activeElement) ||
            panel === document.activeElement)
        ) {
          event.preventDefault();
          selectAll(flatOrder);
        }
      }
    }

    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [clearSelection, selectAll, flatOrder, deleteConfirmOpen, panelRef]);

  useEffect(() => {
    if (!pendingRevealSceneId) return;
    useGridStore.getState().clearPendingReveal();

    const nodesById = Object.fromEntries(nodes.map((node) => [node.id, node]));
    const resolution = resolveContainerForScene(
      pendingRevealSceneId,
      nodesById,
    );
    if (resolution.type === "not_found") {
      console.warn("[Grid] reveal: scene not found", pendingRevealSceneId);
      return;
    }
    if (resolution.type === "set") {
      void setContainerId(projectId, resolution.containerId);
    }

    const sceneId = pendingRevealSceneId;
    let attempts = 0;
    function tryScroll() {
      const element = document.querySelector(
        `[data-grid-scene-id="${sceneId}"]`,
      );
      if (element) {
        element.scrollIntoView({ block: "center", behavior: "smooth" });
        useGridStore.getState().setRevealedSceneId(sceneId);
        useGridStore.getState().selectOnly(sceneId);
        setTimeout(() => useGridStore.getState().clearRevealedSceneId(), 1200);
      } else if (attempts < 15) {
        attempts += 1;
        requestAnimationFrame(tryScroll);
      }
    }
    requestAnimationFrame(tryScroll);
  }, [pendingRevealSceneId, nodes, projectId, setContainerId]);
}
