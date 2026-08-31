import { useEffect, useSyncExternalStore } from "react";
import type { Editor } from "@tiptap/react";
import { useLicenseWriteRestricted } from "./gate";
import {
  isQuiescenceLeaseActive,
  subscribeQuiescenceLease,
} from "@/application/lifecycle/quiescenceLease";
import type { DocumentKey } from "@/features/editor/document/documentKey";
import {
  isExclusiveDocumentLeaseActive,
  subscribeExclusiveDocumentLease,
} from "@/features/editor/document/documentSaveCoordinator";
import {
  isTimelapseReplacementFenceActiveForDocument,
  subscribeTimelapseReplacementFence,
} from "@/features/timelapse/documentCoverage";

/**
 * ライセンス制限中（trial_expired / license_stale / revoked）は TipTap
 * エディタを読み取り専用にする（ライセンス認証設計書 §6「本文編集」）。
 *
 * 注意: `setEditable` を無条件に同期するため、独自の editable 制御を持つ
 * エディタ（ChatInput の isStreaming 等）にはこのフックを使わないこと。
 * 導入時点で対象の編集面（EditorPane / LinearSceneBlock /
 * CodexContentEditor / SnippetDetailContent / StickyBodyEditor /
 * UnplacedBeatItem）に他の editable 制御が無いことを確認済み。
 *
 * `forceReadOnly`: ライセンス以外の read-only 要因（マルチウインドウの advisory
 * lock で別窓が同一 entry を編集中など）。editable 制御を 1 箇所に集約するため、
 * ここで OR して反映する（呼び出し側で別途 setEditable しないこと）。
 * Project/Workspace/window の destructive lifecycle lease もここで自動購読し、
 * strict flush 開始後に新しい TipTap transaction が入るのを全対象面で防ぐ。
 */
export function useLicenseEditableSync(
  editor: Editor | null,
  forceReadOnly = false,
  documentKey: DocumentKey | null = null,
  /**
   * Immutable Project authority of the document that has actually finished
   * loading.  Do not fall back to the render-time current Project here: a
   * stale editor must never observe (or release) a fence belonging to the
   * replacement workspace.
   */
  loadedProjectId: string | null = null,
): boolean {
  const restricted = useLicenseWriteRestricted();
  const quiescenceLeaseActive = useSyncExternalStore(
    subscribeQuiescenceLease,
    isQuiescenceLeaseActive,
    () => false,
  );
  const timelapseReplacementFenceActive = useSyncExternalStore(
    subscribeTimelapseReplacementFence,
    () =>
      loadedProjectId !== null && documentKey !== null
        ? isTimelapseReplacementFenceActiveForDocument(
            loadedProjectId,
            documentKey,
          )
        : false,
    () => false,
  );
  const readOnly =
    restricted ||
    forceReadOnly ||
    quiescenceLeaseActive ||
    isExclusiveDocumentLeaseActive(documentKey) ||
    timelapseReplacementFenceActive;
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    // emitUpdate: false — TipTap の setEditable は既定で 'update' を emit し、
    // 各エディタの onUpdate (オートセーブ schedule) を「doc 未変更」のまま
    // 発火させる。mount 時の同期がこれを毎回踏み、未ロードの空 doc に
    // pending を arm して本文消失の引き金になっていた (実機ログで特定)。
    // editable の反映自体は setOptions 経由なので emit 無しでも効く。
    editor.setEditable(!readOnly, false);
    // React の再描画を待つ窓にも transaction を通さないよう、lease state
    // transition では同じ制御を同期適用する。既存の onUpdate scheduling gate
    // と合わせて acquisition〜commit の TOCTOU を閉じる。
    const syncEditable = () => {
      if (editor.isDestroyed) return;
      editor.setEditable(
        !(
          restricted ||
          forceReadOnly ||
          isQuiescenceLeaseActive() ||
          isExclusiveDocumentLeaseActive(documentKey) ||
          (loadedProjectId !== null && documentKey !== null
            ? isTimelapseReplacementFenceActiveForDocument(
                loadedProjectId,
                documentKey,
              )
            : false)
        ),
        false,
      );
    };
    const unsubscribeQuiescence = subscribeQuiescenceLease(syncEditable);
    const unsubscribeDocument = subscribeExclusiveDocumentLease(
      documentKey,
      syncEditable,
    );
    // useSyncExternalStore schedules a React update, but that update is too
    // late for a replacement fence: acquireTimelapseReplacementFence can be
    // followed by a same-stack TipTap transaction. Subscribe directly so the
    // editor becomes non-editable during the fence notification itself.
    const unsubscribeTimelapse =
      subscribeTimelapseReplacementFence(syncEditable);
    return () => {
      unsubscribeQuiescence();
      unsubscribeDocument();
      unsubscribeTimelapse();
    };
  }, [
    documentKey,
    editor,
    forceReadOnly,
    loadedProjectId,
    readOnly,
    restricted,
  ]);
  return readOnly;
}
