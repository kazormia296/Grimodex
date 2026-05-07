/**
 * Scene 復元 (設計書 §6, §16.2)。
 *
 * 新 ID 発行。folderHintId が現存しなければルート (parentId=null) に置く。
 * povCharacterId / locationId 等は payload に保持されるが、参照先 Codex が
 * 削除済みの可能性があるため復元時に validate して broken-link 警告に積む。
 */
import { createNode, saveSceneContent, getNode } from "@/features/tree/api";
import { getCodexEntry } from "@/features/codex/api";
import type { ScenePayload, TrashItemData } from "../types";
import type { RestoreOutcome } from "./types";

export interface SceneRestoreOptions {
  /** ドロップ先フォルダ (Scenes パネル上で指定された場合)。null/undefined ならルート。 */
  parentIdOverride?: string | null;
  /** sortOrder 上書き (ドロップ位置から計算)。未指定なら元の sortOrder。 */
  sortOrderOverride?: string;
  projectId: string;
}

export async function restoreScene(
  item: TrashItemData,
  options: SceneRestoreOptions,
): Promise<RestoreOutcome> {
  if (item.subKind !== "scene") {
    return { ok: false, reason: "rejected", message: "subKind mismatch" };
  }
  const payload = item.payload as ScenePayload;
  const newId = crypto.randomUUID();
  const brokenLinks: string[] = [];

  // 親フォルダの解決
  let parentId: string | null;
  if (options.parentIdOverride !== undefined) {
    parentId = options.parentIdOverride;
  } else if (payload.folderHintId) {
    const exists = await getNode(payload.folderHintId);
    parentId = exists ? payload.folderHintId : null;
    if (!exists) brokenLinks.push("folder");
  } else {
    parentId = null;
  }

  // POV キャラクター参照の検証 (broken-link 検知のみ、復元はせず Scene 本体は作る)
  if (payload.povCharacterId) {
    const exists = await getCodexEntry(payload.povCharacterId);
    if (!exists) brokenLinks.push("povCharacter");
  }

  try {
    await createNode({
      id: newId,
      projectId: options.projectId,
      parentId: parentId ?? undefined,
      nodeType: "scene",
      title: payload.title,
      synopsis: payload.metadata.synopsis ?? undefined,
      sortOrder: options.sortOrderOverride ?? payload.metadata.sortOrder,
      status: payload.metadata.status ?? undefined,
    });
    await saveSceneContent(newId, payload.body);
  } catch (e) {
    return {
      ok: false,
      reason: "internal-error",
      message: e instanceof Error ? e.message : String(e),
    };
  }

  return { ok: true, newId, brokenLinks };
}
