import { useMemo } from "react";
import { useTreeStore, type TreeNodeData } from "@/features/tree/treeStore";
import { cmpKeys } from "@/features/tree/fractionalIndex";

export interface GridDescendant {
  node: TreeNodeData;
  /** 0 = direct child of the chapter folder; +1 per nesting level */
  depth: number;
}

export interface GridChapterData {
  folder: TreeNodeData;
  /** All descendants (scenes + folders), depth-first in sortOrder, with depth metadata. */
  descendants: GridDescendant[];
}

/**
 * Ordered column entry for rendering. Chapters and the loose scene group are
 * merged into one list ordered by sortOrder, so the loose group is positioned
 * to match the Scenes-panel order (e.g. Part-direct scenes appear before the
 * chapter sub-folder when their sortOrder precedes it).
 */
export type GridColumnEntry =
  | { kind: "chapter"; data: GridChapterData; sortOrder: string }
  | { kind: "loose"; scenes: TreeNodeData[]; sortOrder: string };

export interface GridDerivedData {
  chapters: GridChapterData[];
  looseScenes: TreeNodeData[];
  /** Chapters + loose group merged and sorted by sortOrder, ready for rendering. */
  orderedColumns: GridColumnEntry[];
  totalScenes: number;
  totalChapters: number;
}

function sortByOrder(a: TreeNodeData, b: TreeNodeData) {
  return cmpKeys(a.sortOrder, b.sortOrder);
}

function flattenSubtree(
  parentId: string,
  nodes: TreeNodeData[],
  depth: number,
  acc: GridDescendant[],
): void {
  const children = nodes
    .filter((n) => n.parentId === parentId)
    .sort(sortByOrder);
  for (const child of children) {
    acc.push({ node: child, depth });
    if (child.nodeType === "folder") {
      flattenSubtree(child.id, nodes, depth + 1, acc);
    }
  }
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

    const chapters: GridChapterData[] = chapterFolders.map((folder) => {
      const descendants: GridDescendant[] = [];
      flattenSubtree(folder.id, nodes, 0, descendants);
      return { folder, descendants };
    });

    const totalScenes =
      chapters.reduce(
        (acc, ch) =>
          acc +
          ch.descendants.filter((d) => d.node.nodeType === "scene").length,
        0,
      ) + looseScenes.length;

    // Merge chapters + loose group into one sortOrder-ordered list. The loose
    // group's representative sortOrder is the first loose scene's sortOrder, so
    // it slots between chapter columns at the right tree position.
    const orderedColumns: GridColumnEntry[] = chapters.map((ch) => ({
      kind: "chapter" as const,
      data: ch,
      sortOrder: ch.folder.sortOrder,
    }));
    if (looseScenes.length > 0) {
      orderedColumns.push({
        kind: "loose" as const,
        scenes: looseScenes,
        sortOrder: looseScenes[0].sortOrder,
      });
    }
    orderedColumns.sort((a, b) => cmpKeys(a.sortOrder, b.sortOrder));

    return {
      chapters,
      looseScenes,
      orderedColumns,
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
