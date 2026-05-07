/**
 * Snippet 復元 (設計書 §6, §16.4)。
 * 新 ID。元 sceneId が現存しなければ無効化 (snippet は scene 紐付けが任意)。
 */
import { createSnippet } from "@/features/snippets/api";
import { getNode } from "@/features/tree/api";
import type { SnippetPayload, TrashItemData } from "../types";
import type { RestoreOutcome } from "./types";

export interface SnippetRestoreOptions {
  projectId: string;
  /** Map ペイン等から呼ぶときは sceneId 指定なしで OK。 */
  sceneIdOverride?: string | null;
}

export async function restoreSnippet(
  item: TrashItemData,
  options: SnippetRestoreOptions,
): Promise<RestoreOutcome> {
  if (item.subKind !== "snippet") {
    return { ok: false, reason: "rejected", message: "subKind mismatch" };
  }
  const payload = item.payload as SnippetPayload;
  const newId = crypto.randomUUID();
  const brokenLinks: string[] = [];

  let sceneId: string | null;
  if (options.sceneIdOverride !== undefined) {
    sceneId = options.sceneIdOverride;
  } else if (payload.sceneId) {
    const node = await getNode(payload.sceneId);
    sceneId = node ? payload.sceneId : null;
    if (!node) brokenLinks.push("scene");
  } else {
    sceneId = null;
  }

  try {
    await createSnippet({
      id: newId,
      projectId: options.projectId,
      title: payload.title,
      content: payload.body,
      tagsCache: payload.tags ?? undefined,
      sceneId: sceneId ?? undefined,
      contentSource: payload.contentSource ?? undefined,
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
