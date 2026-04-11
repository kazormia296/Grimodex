import { Extension } from "@tiptap/core";
import {
  Plugin,
  PluginKey,
  Selection,
  TextSelection,
  NodeSelection,
} from "prosemirror-state";

const pluginKey = new PluginKey("inlineAtomNavigation");

/**
 * Ctrl+Home/End キー処理。ドキュメントの先頭/末尾に移動する。
 *
 * ProseMirror の captureKeyDown は Ctrl+Home/End を処理しないため、
 * ブラウザのネイティブ処理に依存する。通常は正しく動作するが、
 * 明示的にハンドルすることで確実な挙動を保証する。
 */
function handleCtrlEndHome(
  view: import("prosemirror-view").EditorView,
  dir: "left" | "right",
  extending: boolean,
): boolean {
  const { state } = view;
  const { doc } = state;

  const targetPos =
    dir === "right" ? Selection.atEnd(doc).to : Selection.atStart(doc).from;

  const { selection } = state;
  const anchorPos =
    selection instanceof TextSelection
      ? selection.$anchor.pos
      : selection instanceof NodeSelection
        ? selection.$from.pos
        : targetPos;

  const newSel = extending
    ? TextSelection.create(doc, anchorPos, targetPos)
    : TextSelection.create(doc, targetPos);
  view.dispatch(state.tr.setSelection(newSel).scrollIntoView());
  return true;
}

/**
 * InlineAtomNavigationExtension — Ctrl+Home/End によるドキュメント端移動
 *
 * ルビ等のインラインatom周辺のカーソル移動問題は、RubyNode の NodeView で
 * display:inline-block の wrapper を使うことで根本解決している。
 * ブラウザは inline-block + contenteditable="false" を画像と同様に扱い、
 * End/Home/矢印キーで正しくスキップする。
 *
 * 本 Extension は Ctrl+Home/End のみをハンドルする。
 */
export const InlineAtomNavigationExtension = Extension.create({
  name: "inlineAtomNavigation",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: pluginKey,
        props: {
          handleKeyDown(view, event) {
            const ctrl = event.ctrlKey || event.metaKey;
            if (!ctrl) return false;

            switch (event.key) {
              case "End":
                return handleCtrlEndHome(view, "right", event.shiftKey);
              case "Home":
                return handleCtrlEndHome(view, "left", event.shiftKey);
              default:
                return false;
            }
          },
        },
      }),
    ];
  },
});
