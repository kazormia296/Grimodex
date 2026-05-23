import { useEffect } from "react";
import type { Editor } from "@tiptap/core";
import { isEditorViewReady } from "@/features/editor/isEditorViewReady";
import {
  createTrashBinCapturePlugin,
  trashBinCaptureKey,
  META_ORIGIN,
  META_PAUSED,
} from "./TrashBinCapturePlugin";
import type { TrashOrigin } from "@/features/trash-bin/types";

/**
 * `TrashBinCapturePlugin` を冪等に登録し、origin / paused を meta 経由で
 * 同期するフック。`useAttribution` のパターンを踏襲。
 *
 * @param editor      対象の TipTap エディタ (null 可)
 * @param origin      キャプチャ対象の出自。null のときキャプチャを skip
 * @param paused      true の間はキャプチャ停止 (Codex の externalContent プレビュー等)
 */
export function useTrashBinCapture(
  editor: Editor | null,
  origin: TrashOrigin | null,
  paused = false,
) {
  // Plugin 冪等登録 + cleanup
  useEffect(() => {
    if (!isEditorViewReady(editor)) return;
    const exists = editor.view.state.plugins.find(
      (p) => p.spec.key === trashBinCaptureKey,
    );
    if (!exists) {
      editor.registerPlugin(createTrashBinCapturePlugin());
    }
    return () => {
      try {
        editor.unregisterPlugin(trashBinCaptureKey);
      } catch {
        // editor がすでに destroy 済みなら無視
      }
    };
  }, [editor]);

  // origin / paused 変化を meta dispatch
  useEffect(() => {
    if (!isEditorViewReady(editor)) return;
    const tr = editor.state.tr;
    tr.setMeta(META_ORIGIN, origin);
    tr.setMeta(META_PAUSED, paused);
    tr.setMeta("addToHistory", false);
    editor.view.dispatch(tr);
  }, [editor, origin, paused]);
}
