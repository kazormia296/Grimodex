import { useState } from "react";
import { useTreeStore } from "@/features/tree/treeStore";
import { useGridStore } from "./gridStore";

export interface ChapterColumnMenu {
  diveIn: () => void;
  addScene: () => Promise<void>;
  requestRename: () => void;
  commitDelete: () => Promise<void>;
  deleteOpen: boolean;
  setDeleteOpen: (open: boolean) => void;
  busy: boolean;
  folderTitle: string;
}

/**
 * Shared handlers + delete-dialog state for the chapter column menu pair
 * (`GridChapterColumnMenu` dropdown / `GridChapterColumnContextMenu`).
 * The menu primitives stay in each component; only the logic is shared.
 */
export function useChapterColumnMenu(folderId: string): ChapterColumnMenu {
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const folder = useTreeStore((s) => s.nodes.find((n) => n.id === folderId));
  const projectId = useTreeStore((s) => s.projectId);
  const createNode = useTreeStore((s) => s.createNode);
  const setContainerId = useGridStore((s) => s.setContainerId);

  function diveIn() {
    void setContainerId(projectId, folderId);
  }

  async function addScene() {
    await createNode({ nodeType: "scene", parentId: folderId });
  }

  function requestRename() {
    useTreeStore.getState().setPendingRenameId(folderId);
  }

  async function commitDelete() {
    if (busy) return;
    setBusy(true);
    try {
      await useTreeStore.getState().deleteNode(folderId);
      setDeleteOpen(false);
    } finally {
      setBusy(false);
    }
  }

  return {
    diveIn,
    addScene,
    requestRename,
    commitDelete,
    deleteOpen,
    setDeleteOpen,
    busy,
    folderTitle: folder?.title ?? "",
  };
}
