import { db } from "@/db/client";
import { treeNodes } from "@/db/schema";
import { eq } from "drizzle-orm";

export interface ProjectDataStats {
  sceneCount: number;
  totalChars: number;
}

function extractCharCount(node: {
  text?: string;
  content?: unknown[];
}): number {
  if (node.text) return node.text.length;
  if (!node.content) return 0;
  return node.content.reduce(
    (sum: number, child) =>
      sum + extractCharCount(child as Parameters<typeof extractCharCount>[0]),
    0,
  );
}

export async function getProjectDataStats(
  projectId: string,
): Promise<ProjectDataStats> {
  const scenes = await db
    .select({ content: treeNodes.content })
    .from(treeNodes)
    .where(eq(treeNodes.projectId, projectId));

  return scenes.reduce<ProjectDataStats>(
    (stats, scene) => {
      if (!scene.content || scene.content === "{}") return stats;
      stats.sceneCount += 1;
      try {
        stats.totalChars += extractCharCount(JSON.parse(scene.content));
      } catch {
        // Preserve the visible row count while excluding malformed content
        // from the character total.
      }
      return stats;
    },
    { sceneCount: 0, totalChars: 0 },
  );
}
