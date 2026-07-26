import type { Editor } from "@tiptap/core";
import { EditorState } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";

/**
 * ProseMirror undo/redo スタックを空にする。doc・selection は保持。
 *
 * エディタインスタンスはシーン/Codex 間で使い回されるため、シーン切替で
 * doc を丸ごと差し替えたあとに履歴を残すと Ctrl+Z が前シーンの内容を
 * 復元したり doc 全体を破壊する。loaded 直後（ユーザーの編集前）に呼ぶ。
 *
 * peer live sync や authorship 適用の途中では呼ばないこと。
 */
export function resetEditorHistory(view: EditorView): void {
  const { state } = view;
  view.updateState(
    EditorState.create({
      doc: state.doc,
      selection: state.selection,
      storedMarks: state.storedMarks,
      plugins: state.plugins,
    }),
  );
}

/** setContent 後に undo 履歴をクリアする（シーン/Codex ロード専用）。 */
export function setEditorContentFreshHistory(
  editor: Editor,
  content: Parameters<Editor["commands"]["setContent"]>[0],
  options?: Parameters<Editor["commands"]["setContent"]>[1],
): boolean {
  const ok = editor.commands.setContent(content, options);
  if (ok) resetEditorHistory(editor.view);
  return ok;
}
