// ────────────────────────────────────────────────────────────────────
// ダイアログを開いたときに読み込む書き出し素材（本文 + プロジェクト情報）。
// ExportDialog の loadContentMap / getProject 呼び出し部と同じ流儀
// （DB + liveContent オーバーレイ）。テストで丸ごと mock できるよう分離。
// ────────────────────────────────────────────────────────────────────

import { db } from "@/db/client";
import { treeNodes } from "@/db/schema";
import { eq } from "drizzle-orm";
import { useSceneContentStore } from "@/features/editor/sceneContentStore";
import { getProject } from "@/features/project/api";
import { getCurrentProjectId } from "@/features/project/projectStore";

export interface VivliostyleExportSources {
  /** sceneId → ProseMirror JSON 文字列 */
  contentMap: Record<string, string>;
  projectTitle: string;
  projectLanguage: string;
}

export async function loadVivliostyleExportSources(): Promise<VivliostyleExportSources> {
  const projectId = getCurrentProjectId();

  const rows = await db
    .select({ id: treeNodes.id, content: treeNodes.content })
    .from(treeNodes)
    .where(eq(treeNodes.projectId, projectId));

  const contentMap: Record<string, string> = {};
  for (const row of rows) {
    contentMap[row.id] = row.content;
  }

  // liveContent でオーバーレイ（現在編集中のシーンの最新状態）
  const live = useSceneContentStore.getState().liveContent;
  for (const [id, content] of Object.entries(live)) {
    if (content) {
      contentMap[id] = JSON.stringify(content);
    }
  }

  const project = await getProject(projectId);
  return {
    contentMap,
    projectTitle: project?.title || "Untitled Project",
    projectLanguage: project?.language || "ja",
  };
}
