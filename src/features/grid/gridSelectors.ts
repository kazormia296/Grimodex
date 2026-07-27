import { useMemo } from "react";
import { useTreeStore, type TreeNodeData } from "@/features/tree/treeStore";
import { cmpKeys } from "@/features/tree/fractionalIndex";
import { getTreeIndex } from "@/features/tree/treeIndex";
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
  nodeById: ReadonlyMap<string, TreeNodeData>;
  chapters: GridChapterData[];
  looseScenes: TreeNodeData[];
  /** Chapters + loose group merged and sorted by sortOrder, ready for rendering. */
  orderedColumns: GridColumnEntry[];
  totalScenes: number;
  totalChapters: number;
  /** Scene ids in the exact rendered column/row order. */
  flatOrder: string[];
  /** Nested folders below the rendered chapter roots (chapter roots excluded). */
  nestedFolderIds: string[];
  /** Scene metadata used by drag calculations, derived with flatOrder. */
  orderedScenes: Array<{ id: string; parentId: string | null }>;
  /** Visible scene rows used by filtering and the status bar. */
  allDisplayedScenes: TreeNodeData[];
}

function sortByOrder(a: TreeNodeData, b: TreeNodeData) {
  return cmpKeys(a.sortOrder, b.sortOrder);
}

export function useGridDerivedData(
  containerId: string | null,
): GridDerivedData {
  const nodes = useTreeStore((s) => s.nodes);
  const collapsedFolderIds = useGridStore((s) => s.collapsedFolderIds);

  return useMemo(() => {
    const index = getTreeIndex(nodes);
    const containerChildren = index.childrenByParent.get(containerId) ?? [];

    const chapterFolders = containerChildren.filter(
      (n) => n.nodeType === "folder",
    );
    const looseScenes = containerChildren.filter((n) => n.nodeType === "scene");

    const nestedFolderIds: string[] = [];
    const chapters: GridChapterData[] = chapterFolders.map((folder) => {
      const descendants: GridDescendant[] = [];
      const visiting = new Set<string>();
      const walk = (
        parentId: string,
        depth: number,
        visible: boolean,
      ): void => {
        if (visiting.has(parentId)) return;
        visiting.add(parentId);
        for (const child of index.childrenByParent.get(parentId) ?? []) {
          if (visible) descendants.push({ node: child, depth });
          if (child.nodeType !== "folder") continue;
          nestedFolderIds.push(child.id);
          walk(
            child.id,
            depth + 1,
            visible && !collapsedFolderIds.has(child.id),
          );
        }
        visiting.delete(parentId);
      };
      walk(folder.id, 0, true);
      return { folder, descendants };
    });

    // Count ALL scene descendants for status (not just expanded ones), so the
    // total stays meaningful regardless of expand state.
    const totalScenes =
      chapterFolders.reduce(
        (total, chapter) =>
          total + (index.descendantSceneCount.get(chapter.id) ?? 0),
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
      containerId !== null ? index.nodeById.get(containerId) : null;
    if (containerNode?.nodeType === "folder") {
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

    const flatOrder: string[] = [];
    const allDisplayedScenes: TreeNodeData[] = [];
    for (const column of orderedColumns) {
      const scenes =
        column.kind === "chapter"
          ? column.data.descendants
              .filter((descendant) => descendant.node.nodeType === "scene")
              .map((descendant) => descendant.node)
          : column.scenes;
      for (const scene of scenes) {
        flatOrder.push(scene.id);
        allDisplayedScenes.push(scene);
      }
    }

    return {
      nodeById: index.nodeById,
      chapters,
      looseScenes,
      orderedColumns,
      totalScenes,
      totalChapters: chapters.length,
      flatOrder,
      nestedFolderIds,
      orderedScenes: flatOrder.map((id) => {
        const scene = index.nodeById.get(id);
        return { id, parentId: scene?.parentId ?? null };
      }),
      allDisplayedScenes,
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
