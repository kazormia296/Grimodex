import { useCallback } from "react";
import type { RefObject } from "react";
import { useLayoutStore } from "@/features/layout/layoutStore";
import { openEditorDocument } from "@/application/editor/openEditorDocument";
import { defaultEditorNavigationPorts } from "@/features/editor/editorNavigationPorts";
import { useTreeStore } from "./treeStore";
import type { TreeNodeData } from "./treeStore";
import {
  getMergedBindings,
  matchesBinding,
} from "@/features/settings/keybindings";

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

/**
 * エディタへ DOM フォーカスを移す。ツリー(tabIndex=0 コンテナ)から focus が
 * 外れるので、矢印 / Space のプレビュー遷移では呼ばない — 呼ぶと 1 手ごとに
 * フォーカスがエディタへ奪われ、連続ナビゲーションが止まる（"フォーカス
 * バイパス" が無効化される）。明示的に「開いて編集」する Enter / Ctrl+Enter
 * でのみフォーカスを移す。
 */
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
            openEditorDocument(
              {
                target: { kind: "scene", documentId: next.id },
                mode: "preview",
                revealEditor: false,
                focusEditor: false,
                syncSceneContext: false,
              },
              defaultEditorNavigationPorts,
            );
          }
          useTreeStore.getState().selectNode(next.id, false);
        }
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        const prev = flatNodes[idx - 1];
        if (prev) {
          if (prev.nodeType === "scene" || prev.nodeType === "note") {
            openEditorDocument(
              {
                target: { kind: "scene", documentId: prev.id },
                mode: "preview",
                revealEditor: false,
                focusEditor: false,
                syncSceneContext: false,
              },
              defaultEditorNavigationPorts,
            );
          }
          useTreeStore.getState().selectNode(prev.id, false);
        }
      } else if (e.key === " ") {
        e.preventDefault();
        const cur = nodeMap[activeSceneId];
        if (cur && (cur.nodeType === "scene" || cur.nodeType === "note")) {
          openEditorDocument(
            {
              target: { kind: "scene", documentId: cur.id },
              mode: "preview",
              revealEditor: false,
              focusEditor: false,
              syncSceneContext: false,
            },
            defaultEditorNavigationPorts,
          );
        }
      } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        const cur = nodeMap[activeSceneId];
        if (cur && (cur.nodeType === "scene" || cur.nodeType === "note")) {
          openEditorDocument(
            {
              target: { kind: "scene", documentId: cur.id },
              group: 1,
              mode: "pinned",
              revealEditor: true,
              focusEditor: true,
              syncSceneContext: true,
            },
            defaultEditorNavigationPorts,
          );
          focusEditorPanel();
        }
      } else if (e.key === "Enter") {
        e.preventDefault();
        const cur = nodeMap[activeSceneId];
        if (cur && (cur.nodeType === "scene" || cur.nodeType === "note")) {
          setActiveScene(cur.id);
          openEditorDocument(
            {
              target: { kind: "scene", documentId: cur.id },
              mode: "pinned",
              revealEditor: true,
              focusEditor: true,
              syncSceneContext: true,
            },
            defaultEditorNavigationPorts,
          );
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
      } else if (matchesBinding(e, getMergedBindings().find ?? "")) {
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
