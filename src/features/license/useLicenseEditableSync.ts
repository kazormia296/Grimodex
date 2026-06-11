import { useEffect } from "react";
import type { Editor } from "@tiptap/react";
import { useLicenseWriteRestricted } from "./gate";

/**
 * ライセンス制限中（trial_expired / license_stale / revoked）は TipTap
 * エディタを読み取り専用にする（ライセンス認証設計書 §6「本文編集」）。
 *
 * 注意: `setEditable` を無条件に同期するため、独自の editable 制御を持つ
 * エディタ（ChatInput の isStreaming 等）にはこのフックを使わないこと。
 * 導入時点で対象 6 エディタ（EditorPane / LinearSceneBlock /
 * CodexContentEditor / SnippetDetailContent / StickyNode /
 * UnplacedBeatItem）に他の editable 制御が無いことを確認済み。
 */
export function useLicenseEditableSync(editor: Editor | null): boolean {
  const restricted = useLicenseWriteRestricted();
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    // emitUpdate: false — TipTap の setEditable は既定で 'update' を emit し、
    // 各エディタの onUpdate (オートセーブ schedule) を「doc 未変更」のまま
    // 発火させる。mount 時の同期がこれを毎回踏み、未ロードの空 doc に
    // pending を arm して本文消失の引き金になっていた (実機ログで特定)。
    // editable の反映自体は setOptions 経由なので emit 無しでも効く。
    editor.setEditable(!restricted, false);
  }, [editor, restricted]);
  return restricted;
}
