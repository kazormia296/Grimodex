import { useMemo } from "react";
import { useTreeStore, type TreeNodeData } from "@/features/tree/treeStore";
import { cmpKeys } from "@/features/tree/fractionalIndex";

export interface GridChapterData {
  folder: TreeNodeData;
  scenes: TreeNodeData[];
}

export interface GridDerivedData {
  chapters: GridChapterData[];
  looseScenes: TreeNodeData[];
  totalScenes: number;
  totalChapters: number;
}

function sortByOrder(a: TreeNodeData, b: TreeNodeData) {
  return cmpKeys(a.sortOrder, b.sortOrder);
}

export function useGridDerivedData(
  containerId: string | null,
): GridDerivedData {
  const nodes = useTreeStore((s) => s.nodes);

  return useMemo(() => {
    const containerChildren = nodes
      .filter((n) => n.parentId === containerId)
      .sort(sortByOrder);

    const chapterFolders = containerChildren.filter(
      (n) => n.nodeType === "folder",
    );
    const looseScenes = containerChildren.filter((n) => n.nodeType === "scene");

    const chapters: GridChapterData[] = chapterFolders.map((folder) => ({
      folder,
      scenes: nodes.filter((n) => n.parentId === folder.id).sort(sortByOrder),
    }));

    const totalScenes =
      chapters.reduce((acc, ch) => acc + ch.scenes.length, 0) +
      looseScenes.length;

    return {
      chapters,
      looseScenes,
      totalScenes,
      totalChapters: chapters.length,
    };
  }, [nodes, containerId]);
}

/** Flat ordered list of all folder nodes for the container selector dropdown */
export function useContainerTree(): TreeNodeData[] {
  const nodes = useTreeStore((s) => s.nodes);
  return useMemo(
    () => nodes.filter((n) => n.nodeType === "folder").sort(sortByOrder),
    [nodes],
  );
}
