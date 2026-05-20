import { useCallback } from "react";
import type { RefObject } from "react";
import { useTabStore } from "@/features/editor/tabStore";
import { useLayoutStore } from "@/features/layout/layoutStore";
import { useTreeStore } from "./treeStore";
import type { TreeNodeData } from "./treeStore";

interface KeyboardArgs {
  flatNodes: TreeNodeData[];
  nodeMap: Record<string, TreeNodeData>;
  activeSceneId: string;
  selectedIds: string[];
  expandedIds: string[];
  setActiveScene: (id: string) => void;
  toggleExpand: (id: string) => void;
  setPendingRenameId: (id: string | null) => void;
  initiateDelete: (ids: string[]) => void;
  treeRef: RefObject<HTMLDivElement | null>;
  filterRef: RefObject<HTMLInputElement | null>;
}

function focusEditorPanel() {
  useLayoutStore.getState().requestEditorFocus();
}

/** Keyboard navigation for the Scenes tree (arrows, Enter/Space, F2, Del,
 *  Ctrl+F filter focus, Undo/Redo). */
export function useScenesKeyboard({
  flatNodes,
  nodeMap,
  activeSceneId,
  selectedIds,
  expandedIds,
  setActiveScene,
  toggleExpand,
  setPendingRenameId,
  initiateDelete,
  treeRef,
  filterRef,
}: KeyboardArgs) {
  return useCallback(
    (e: React.KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === "INPUT") return;

      const idx = flatNodes.findIndex((n) => n.id === activeSceneId);
      if (e.key === "ArrowDown") {
        e.preventDefault();
        const next = flatNodes[idx + 1];
        if (next) {
          if (next.nodeType === "scene" || next.nodeType === "note") {
            useTabStore.getState().openPreview(next.id);
            focusEditorPanel();
          }
          useTreeStore.getState().selectNode(next.id, false);
        }
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        const prev = flatNodes[idx - 1];
        if (prev) {
          if (prev.nodeType === "scene" || prev.nodeType === "note") {
            useTabStore.getState().openPreview(prev.id);
            focusEditorPanel();
          }
          useTreeStore.getState().selectNode(prev.id, false);
        }
      } else if (e.key === " ") {
        e.preventDefault();
        const cur = nodeMap[activeSceneId];
        if (cur && (cur.nodeType === "scene" || cur.nodeType === "note")) {
          useTabStore.getState().openPreview(cur.id);
          focusEditorPanel();
        }
      } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        const cur = nodeMap[activeSceneId];
        if (cur && (cur.nodeType === "scene" || cur.nodeType === "note")) {
          useTabStore.getState().openInSecondaryGroup(cur.id);
          setActiveScene(cur.id);
          focusEditorPanel();
        }
      } else if (e.key === "Enter") {
        e.preventDefault();
        const cur = nodeMap[activeSceneId];
        if (cur && (cur.nodeType === "scene" || cur.nodeType === "note")) {
          useTabStore.getState().openPinned(cur.id);
          setActiveScene(cur.id);
          focusEditorPanel();
        } else if (cur) {
          toggleExpand(cur.id);
        }
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        const cur = nodeMap[activeSceneId];
        if (cur && cur.nodeType === "folder") {
          if (!expandedIds.includes(activeSceneId)) toggleExpand(activeSceneId);
        }
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        const cur = nodeMap[activeSceneId];
        if (
          cur &&
          cur.nodeType === "folder" &&
          expandedIds.includes(activeSceneId)
        ) {
          toggleExpand(activeSceneId);
        } else if (cur?.parentId) {
          setActiveScene(cur.parentId);
        }
      } else if (e.key === "F2") {
        e.preventDefault();
        if (activeSceneId) setPendingRenameId(activeSceneId);
      } else if (e.key === "Delete" || e.key === "Backspace") {
        if (document.activeElement === treeRef.current) {
          e.preventDefault();
          const idsToDelete =
            selectedIds.length > 0
              ? selectedIds
              : activeSceneId
                ? [activeSceneId]
                : [];
          if (idsToDelete.length > 0) {
            initiateDelete(idsToDelete);
          }
        }
      } else if (e.key === "f" && e.ctrlKey) {
        e.preventDefault();
        filterRef.current?.focus();
      }
    },
    [
      flatNodes,
      activeSceneId,
      nodeMap,
      expandedIds,
      setActiveScene,
      toggleExpand,
      selectedIds,
      initiateDelete,
      setPendingRenameId,
      treeRef,
      filterRef,
    ],
  );
}
