/**
 * Grid Chapter (folder TreeNode) 復元 (設計書 §6, §16.8)。
 *
 * 新 ID 発行。parentId が現存しなければルート。子要素は復元しない (各子は
 * 個別の trash アイテムとして残っているはず)。
 */
import { createNode, getNode } from "@/features/tree/api";
import type { GridChapterPayload, TrashItemData } from "../types";
import type { RestoreOutcome } from "./types";

export interface GridChapterRestoreOptions {
  projectId: string;
  parentIdOverride?: string | null;
  sortOrderOverride?: string;
}

export async function restoreGridChapter(
  item: TrashItemData,
  options: GridChapterRestoreOptions,
): Promise<RestoreOutcome> {
  if (item.subKind !== "grid-chapter") {
    return { ok: false, reason: "rejected", message: "subKind mismatch" };
  }
  const payload = item.payload as GridChapterPayload;
  const newId = crypto.randomUUID();
  const brokenLinks: string[] = [];

  let parentId: string | null;
  if (options.parentIdOverride !== undefined) {
    parentId = options.parentIdOverride;
  } else if (payload.parentId) {
    const exists = await getNode(payload.parentId);
    parentId = exists ? payload.parentId : null;
    if (!exists) brokenLinks.push("parent");
  } else {
    parentId = null;
  }

  try {
    await createNode({
      id: newId,
      projectId: options.projectId,
      parentId: parentId ?? undefined,
      nodeType: "folder",
      title: payload.title,
      sortOrder: options.sortOrderOverride ?? payload.sortOrder,
    });
  } catch (e) {
    return {
      ok: false,
      reason: "internal-error",
      message: e instanceof Error ? e.message : String(e),
    };
  }

  return { ok: true, newId, brokenLinks };
}
