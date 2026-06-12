import { useEffect } from "react";
import type { Editor } from "@tiptap/core";
import {
  createImeDiagnosticsPlugin,
  imeDiagnosticsKey,
} from "./ImeDiagnosticsPlugin";

/**
 * IME composition 診断プラグインを登録する (enableImeLog() で opt-in)。
 * 設定購読は不要 — ゲートは localStorage で、plugin がイベントごとに
 * call-time チェックする。常時登録の OFF コストは boolean チェックのみ。
 * useCursorOverlay と同じく editor インスタンスごとに mount 時 1 回登録。
 */
export function useImeDiagnostics(editor: Editor | null) {
  useEffect(() => {
    if (!editor) return;
    editor.registerPlugin(createImeDiagnosticsPlugin());
    return () => {
      editor.unregisterPlugin(imeDiagnosticsKey);
    };
  }, [editor]);
}
