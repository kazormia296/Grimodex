/**
 * storyContext.ts
 * tree store のノード配列から、grader (review / meta_structure) に渡す
 * 「物語コンテキスト」(synopsis / outline) を組み立てる純関数。
 *
 * - synopsis: 対象シーン自身の synopsis
 * - outline:  直近の親フォルダ(章)の synopsis。親が無い / フォルダでない /
 *             空のときは省略する（直近親のみ参照し、祖先を遡上しない）。
 *
 * 非空フィールドだけを持つオブジェクトを返す。両方とも空なら `{}`。
 * これにより storyContextScopeSuffix("") → 既存キャッシュ不変が保たれる。
 */
import type { TreeNodeData } from "@/features/tree/treeStore";
import type { StoryContext } from "./customInstruction";

type StoryContextNode = Pick<
  TreeNodeData,
  "id" | "parentId" | "nodeType" | "synopsis"
>;

export function selectStoryContext(
  nodes: StoryContextNode[],
  sceneId: string,
): StoryContext {
  const scene = nodes.find((n) => n.id === sceneId);
  if (!scene) return {};

  const ctx: StoryContext = {};

  const synopsis = (scene.synopsis ?? "").trim();
  if (synopsis) ctx.synopsis = synopsis;

  if (scene.parentId) {
    const parent = nodes.find((n) => n.id === scene.parentId);
    if (parent && parent.nodeType === "folder") {
      const outline = (parent.synopsis ?? "").trim();
      if (outline) ctx.outline = outline;
    }
  }

  return ctx;
}
