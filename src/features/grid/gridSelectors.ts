import { useMemo } from "react";
import { useTreeStore, type TreeNodeData } from "@/features/tree/treeStore";
import { cmpKeys } from "@/features/tree/fractionalIndex";
import { useGridStore } from "./gridStore";

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
  collapsedFolderIds: Set<string>,
  acc: GridDescendant[],
): void {
  const children = nodes
    .filter((n) => n.parentId === parentId)
    .sort(sortByOrder);
  for (const child of children) {
    acc.push({ node: child, depth });
    // Default-expanded: recurse unless the user explicitly collapsed this folder.
    // Top-level chapter folders are entered unconditionally by the caller.
    if (child.nodeType === "folder" && !collapsedFolderIds.has(child.id)) {
      flattenSubtree(child.id, nodes, depth + 1, collapsedFolderIds, acc);
    }
  }
}

export function useGridDerivedData(
  containerId: string | null,
): GridDerivedData {
  const nodes = useTreeStore((s) => s.nodes);
  const collapsedFolderIds = useGridStore((s) => s.collapsedFolderIds);

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
      flattenSubtree(folder.id, nodes, 0, collapsedFolderIds, descendants);
      return { folder, descendants };
    });

    // Count ALL scene descendants for status (not just expanded ones), so the
    // total stays meaningful regardless of expand state.
    const countAllSceneDescendants = (folderId: string): number => {
      let n = 0;
      for (const child of nodes.filter((c) => c.parentId === folderId)) {
        if (child.nodeType === "scene") n++;
        else n += countAllSceneDescendants(child.id);
      }
      return n;
    };
    const totalScenes =
      chapterFolders.reduce(
        (acc, ch) => acc + countAllSceneDescendants(ch.id),
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
    // Show the loose column when:
    //   - there are direct scenes to display, OR
    //   - the container is a folder with no chapter sub-folders. In that case
    //     the loose column doubles as the "entered folder" column itself, so
    //     an empty folder still appears as one empty column rather than a
    //     blank panel (mirrors how the folder shows up from the outer view).
    const shouldShowLooseColumn =
      looseScenes.length > 0 ||
      (containerId !== null && chapterFolders.length === 0);
    if (shouldShowLooseColumn) {
      orderedColumns.push({
        kind: "loose" as const,
        scenes: looseScenes,
        sortOrder: looseScenes[0]?.sortOrder ?? "",
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
  }, [nodes, containerId, collapsedFolderIds]);
}

/** Flat ordered list of all folder nodes for the container selector dropdown */
export function useContainerTree(): TreeNodeData[] {
  const nodes = useTreeStore((s) => s.nodes);
  return useMemo(
    () => nodes.filter((n) => n.nodeType === "folder").sort(sortByOrder),
    [nodes],
  );
}
