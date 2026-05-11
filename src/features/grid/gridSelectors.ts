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
 * Ordered column entry for rendering. Chapters と直下シーン群を sortOrder で
 * マージして1列に並べる（Scenes パネル順と一致）。
 *
 * 直下シーン群は 2 種類に分かれる:
 * - "container": containerId が folder のときの直下シーン。folder 自身の
 *   表現（実線・folder アイコン・folder.title）。outline は GridContainerOutline
 *   bar 側で表示される。
 * - "loose": project root (containerId === null) で folder にぶら下がってない
 *   orphan シーン。点線・「未分類シーン」タイトル。
 */
export type GridColumnEntry =
  | { kind: "chapter"; data: GridChapterData; sortOrder: string }
  | {
      kind: "container";
      scenes: TreeNodeData[];
      folder: TreeNodeData;
      sortOrder: string;
    }
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

    // Merge chapters + 直下シーン群 を sortOrder 順に1列に並べる。
    const orderedColumns: GridColumnEntry[] = chapters.map((ch) => ({
      kind: "chapter" as const,
      data: ch,
      sortOrder: ch.folder.sortOrder,
    }));

    // 直下シーン群の表現を決める:
    // - containerId が folder のとき: "container" 列として実線で folder を表現。
    //   直下シーンが空でも、子に chapter が無いなら空の container 列を1つ出す
    //   （leaf folder への dive-in 時に「空のフォルダ」を視覚化するため）。
    // - containerId === null (project root) のとき: orphan シーンを "loose"
    //   列として点線で表示。chapter のみで orphan が無い場合は何も足さない。
    const containerNode =
      containerId !== null
        ? nodes.find((n) => n.id === containerId && n.nodeType === "folder")
        : null;
    if (containerNode) {
      const shouldEmit = looseScenes.length > 0 || chapterFolders.length === 0;
      if (shouldEmit) {
        orderedColumns.push({
          kind: "container" as const,
          scenes: looseScenes,
          folder: containerNode,
          sortOrder: looseScenes[0]?.sortOrder ?? "",
        });
      }
    } else if (looseScenes.length > 0) {
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

/**
 * Flat list of scene IDs in Grid display order:
 * chapter columns (top-to-bottom) → loose column last.
 * Used as the flat order for Shift+Click range selection and Cmd+A.
 */
export function useGridFlatSceneOrder(containerId: string | null): string[] {
  const { orderedColumns } = useGridDerivedData(containerId);
  return useMemo(() => {
    const ids: string[] = [];
    for (const col of orderedColumns) {
      if (col.kind === "chapter") {
        for (const d of col.data.descendants) {
          if (d.node.nodeType === "scene") ids.push(d.node.id);
        }
      } else {
        for (const s of col.scenes) ids.push(s.id);
      }
    }
    return ids;
  }, [orderedColumns]);
}

/** Flat ordered list of all folder nodes for the container selector dropdown */
export function useContainerTree(): TreeNodeData[] {
  const nodes = useTreeStore((s) => s.nodes);
  return useMemo(
    () => nodes.filter((n) => n.nodeType === "folder").sort(sortByOrder),
    [nodes],
  );
}
