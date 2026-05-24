import type { TreeNodeData } from "@/features/tree/treeStore";
import { cmpKeys } from "@/features/tree/fractionalIndex";
import { getDescendantScenesInOrder } from "@/features/tree/treeStore";
import type { ScenePathInfo } from "./types";
import { padIndex, resolveUniqueSlug } from "./slug";

export interface ChapterGroup {
  chapterIndex: number;
  chapterSlug: string;
  folderId: string | null;
  folderTitle: string;
  scenes: TreeNodeData[];
}

/** Build chapter/scene path index for zip layout. */
export function buildScenePathIndex(nodes: TreeNodeData[]): {
  chapters: ChapterGroup[];
  scenePathById: Map<string, ScenePathInfo>;
} {
  const activeNodes = nodes.filter((n) => !n.archivedAt);
  const topLevel = activeNodes
    .filter((n) => n.parentId === null && n.nodeType === "folder")
    .sort((a, b) => cmpKeys(a.sortOrder, b.sortOrder));

  const rootScenes = activeNodes
    .filter((n) => n.parentId === null && n.nodeType === "scene")
    .sort((a, b) => cmpKeys(a.sortOrder, b.sortOrder));

  const chapters: ChapterGroup[] = [];
  const scenePathById = new Map<string, ScenePathInfo>();

  const chapterSlugsUsed = new Set<string>();

  topLevel.forEach((folder, idx) => {
    const chapterSlug = resolveUniqueSlug(folder.title, chapterSlugsUsed);
    const scenes = getDescendantScenesInOrder(activeNodes, folder.id);
    chapters.push({
      chapterIndex: idx + 1,
      chapterSlug,
      folderId: folder.id,
      folderTitle: folder.title,
      scenes,
    });
  });

  if (rootScenes.length > 0) {
    const chapterSlug = resolveUniqueSlug("root", chapterSlugsUsed);
    chapters.unshift({
      chapterIndex: 0,
      chapterSlug,
      folderId: null,
      folderTitle: "root",
      scenes: rootScenes,
    });
  }

  for (let chapterIdx = 0; chapterIdx < chapters.length; chapterIdx++) {
    const chapter = chapters[chapterIdx];
    const sceneSlugsUsed = new Set<string>();
    const chapterPrefix = padIndex(chapterIdx + 1);

    chapter.scenes.forEach((scene, sceneIdx) => {
      const sceneSlug = resolveUniqueSlug(scene.title, sceneSlugsUsed);
      const scenePrefix = padIndex(sceneIdx + 1);
      const relativePath = `chapters/${chapterPrefix}-${chapter.chapterSlug}/${scenePrefix}-${sceneSlug}.md`;
      scenePathById.set(scene.id, {
        sceneId: scene.id,
        relativePath,
        slug: sceneSlug,
      });
    });
  }

  return { chapters, scenePathById };
}

export function sceneSlugById(
  scenePathById: Map<string, ScenePathInfo>,
  sceneId: string | null | undefined,
): string | null {
  if (!sceneId) return null;
  return scenePathById.get(sceneId)?.slug ?? null;
}
