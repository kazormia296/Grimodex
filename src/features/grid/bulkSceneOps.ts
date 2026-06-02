import { useTreeStore } from "@/features/tree/treeStore";

/**
 * Move multiple scenes to a target chapter, preserving relative order.
 * Uses the same moveNode as single-scene D&D (appended to end of target).
 *
 * moveNode の楽観 set + sortOrder 計算は内部の `await api.updateNode` より前で
 * 同期実行される。各 moveNode を逐次 await すると 2 枚目以降の楽観更新が前の IPC
 * 完了まで走らず、「1 枚ずつ遅れて reflow する」段階 settle になっていた
 * （パフォーマンスレビュー所見#5）。await せず先に全 moveNode を呼べば N 個の楽観 set
 * が同じ tick で一括適用され段階 reflow が消える。.map は同期的に各 moveNode を
 * 呼ぶので、2 枚目は 1 枚目の楽観配置を get().nodes 越しに見て正しく末尾に並ぶ
 * (相対順保持)。永続化 IPC はバックグラウンドで並行実行し、完了を Promise.all で待つ
 * (呼び出し側の完了待ち/エラー伝播を保つ)。各 moveNode は従来どおり個別に undo を
 * push するので per-scene undo 契約は不変。
 *
 * NOTE: Mutex<Connection> を N→1 にする db_execute_batch 化は体感に効かない二次
 * 最適化(楽観 UI は即時反映済み)のため意図的に defer。
 */
export async function moveScenesToChapter(
  orderedSceneIds: string[],
  targetParentId: string | null,
): Promise<void> {
  const { moveNode } = useTreeStore.getState();
  const pending = orderedSceneIds.map((sceneId) =>
    moveNode(sceneId, targetParentId, undefined),
  );
  await Promise.all(pending);
}

/**
 * Delete multiple scenes. Each deletion is recorded individually in undo history.
 */
export async function deleteScenes(sceneIds: string[]): Promise<void> {
  const { deleteNode } = useTreeStore.getState();
  for (const sceneId of sceneIds) {
    await deleteNode(sceneId);
  }
}
