import { Extension } from "@tiptap/core";
import { TextSelection } from "prosemirror-state";
import type { Node as ProseMirrorNode } from "prosemirror-model";
import type { EditorView } from "prosemirror-view";

/**
 * テキストブロックノードがインラインatomの子を持つか判定する。
 * 矢印キーハンドラでブラウザネイティブ処理をバイパスするか否かの判定に使用。
 */
export function textblockHasInlineAtom(node: ProseMirrorNode): boolean {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    // テキストノードはleafのためisAtom===trueだが対象外
    if (!child.isText && child.isAtom && child.isInline) return true;
  }
  return false;
}

/**
 * 視覚行の端位置をcoordAtPosで走査して返す。
 *
 * @param view - ProseMirror EditorView
 * @param startPos - 走査開始のdoc位置
 * @param dir - "right"で行末、"left"で行頭を探す
 * @returns 同一視覚行にある最端のdoc位置
 */
export function findVisualLineEdge(
  view: EditorView,
  startPos: number,
  dir: "left" | "right",
): number {
  const $start = view.state.doc.resolve(startPos);
  const parentStart = $start.start();
  const parentEnd = $start.end();

  // 折り返し点での座標取得: 行末は -1 side（前の文字寄り）、行頭は +1 side（次の文字寄り）
  const startSide =
    dir === "right"
      ? startPos === parentStart
        ? 1
        : -1
      : startPos === parentEnd
        ? -1
        : 1;

  let startCoords: { top: number };
  try {
    startCoords = view.coordsAtPos(startPos, startSide);
  } catch {
    return startPos;
  }
  const refTop = startCoords.top;

  const step = dir === "right" ? 1 : -1;
  const checkSide = dir === "right" ? -1 : 1;
  const limit = dir === "right" ? parentEnd : parentStart;

  let bestPos = startPos;
  let pos = startPos + step;

  while (dir === "right" ? pos <= limit : pos >= limit) {
    let coords: { top: number };
    try {
      coords = view.coordsAtPos(pos, checkSide);
    } catch {
      break;
    }
    // 4px以上ずれたら別の視覚行
    if (Math.abs(coords.top - refTop) >= 4) break;
    bestPos = pos;
    pos += step;
  }

  return bestPos;
}

/**
 * InlineAtomNavigationExtension — インラインatom周辺のカーソル移動修正
 *
 * ProseMirrorはインラインatomノード（ルビなど）に contenteditable="false" を付与するため、
 * ブラウザのネイティブカーソル処理が以下の問題を起こす：
 *   1. End/Homeキー: ProseMirrorにバインドなし → ブラウザが誤動作
 *   2. 矢印キー: テキスト内（textOffset > 0）ではProseMirrorがブラウザに委譲 → 誤動作
 *   3. 折り返し行のEnd: 視覚行末でなく次行頭へ移動する
 *
 * 修正: End/Homeを座標ベースで視覚行の端を検出して移動。
 *       矢印キーはatom含有テキストブロック内でのみ自前処理。
 */
export const InlineAtomNavigationExtension = Extension.create({
  name: "inlineAtomNavigation",
  priority: 200,

  addKeyboardShortcuts() {
    return {
      // End: 視覚行末へ移動
      End: () => {
        const { view } = this.editor;
        const { state } = view;
        const { selection } = state;
        if (!(selection instanceof TextSelection)) return false;
        const { $head } = selection;
        if (!$head.parent.isTextblock) return false;

        const targetPos = findVisualLineEdge(view, $head.pos, "right");
        if (targetPos === $head.pos) return false;
        view.dispatch(
          state.tr
            .setSelection(TextSelection.create(state.doc, targetPos))
            .scrollIntoView(),
        );
        return true;
      },

      // Home: 視覚行頭へ移動
      Home: () => {
        const { view } = this.editor;
        const { state } = view;
        const { selection } = state;
        if (!(selection instanceof TextSelection)) return false;
        const { $head } = selection;
        if (!$head.parent.isTextblock) return false;

        const targetPos = findVisualLineEdge(view, $head.pos, "left");
        if (targetPos === $head.pos) return false;
        view.dispatch(
          state.tr
            .setSelection(TextSelection.create(state.doc, targetPos))
            .scrollIntoView(),
        );
        return true;
      },

      // Shift-End: 視覚行末まで選択拡張
      "Shift-End": () => {
        const { view } = this.editor;
        const { state } = view;
        const { selection } = state;
        if (!(selection instanceof TextSelection)) return false;
        const { $head, $anchor } = selection;
        if (!$head.parent.isTextblock) return false;

        const targetPos = findVisualLineEdge(view, $head.pos, "right");
        if (targetPos === $head.pos) return false;
        view.dispatch(
          state.tr
            .setSelection(
              TextSelection.create(state.doc, $anchor.pos, targetPos),
            )
            .scrollIntoView(),
        );
        return true;
      },

      // Shift-Home: 視覚行頭まで選択拡張
      "Shift-Home": () => {
        const { view } = this.editor;
        const { state } = view;
        const { selection } = state;
        if (!(selection instanceof TextSelection)) return false;
        const { $head, $anchor } = selection;
        if (!$head.parent.isTextblock) return false;

        const targetPos = findVisualLineEdge(view, $head.pos, "left");
        if (targetPos === $head.pos) return false;
        view.dispatch(
          state.tr
            .setSelection(
              TextSelection.create(state.doc, $anchor.pos, targetPos),
            )
            .scrollIntoView(),
        );
        return true;
      },

      // ArrowRight: atom含有テキストブロック内でブラウザ処理をバイパス
      // textOffset === 0 の場合はProseMirrorのselectHorizontallyが正しく処理するため委譲
      ArrowRight: () => {
        const { view } = this.editor;
        const { state } = view;
        const { selection } = state;
        if (!(selection instanceof TextSelection)) return false;
        if (!selection.empty) return false;
        const { $head } = selection;
        if (!$head.parent.isTextblock) return false;
        if ($head.textOffset === 0) return false;
        if (!textblockHasInlineAtom($head.parent)) return false;
        if ($head.parentOffset >= $head.parent.content.size) return false;

        view.dispatch(
          state.tr
            .setSelection(TextSelection.create(state.doc, $head.pos + 1))
            .scrollIntoView(),
        );
        return true;
      },

      // ArrowLeft: atom含有テキストブロック内でブラウザ処理をバイパス
      ArrowLeft: () => {
        const { view } = this.editor;
        const { state } = view;
        const { selection } = state;
        if (!(selection instanceof TextSelection)) return false;
        if (!selection.empty) return false;
        const { $head } = selection;
        if (!$head.parent.isTextblock) return false;
        if ($head.textOffset === 0) return false;
        if (!textblockHasInlineAtom($head.parent)) return false;
        if ($head.parentOffset <= 0) return false;

        view.dispatch(
          state.tr
            .setSelection(TextSelection.create(state.doc, $head.pos - 1))
            .scrollIntoView(),
        );
        return true;
      },

      // Shift-ArrowRight: atom含有テキストブロック内で選択拡張
      "Shift-ArrowRight": () => {
        const { view } = this.editor;
        const { state } = view;
        const { selection } = state;
        if (!(selection instanceof TextSelection)) return false;
        const { $head, $anchor } = selection;
        if (!$head.parent.isTextblock) return false;
        if ($head.textOffset === 0) return false;
        if (!textblockHasInlineAtom($head.parent)) return false;
        if ($head.parentOffset >= $head.parent.content.size) return false;

        view.dispatch(
          state.tr
            .setSelection(
              TextSelection.create(state.doc, $anchor.pos, $head.pos + 1),
            )
            .scrollIntoView(),
        );
        return true;
      },

      // Shift-ArrowLeft: atom含有テキストブロック内で選択拡張
      "Shift-ArrowLeft": () => {
        const { view } = this.editor;
        const { state } = view;
        const { selection } = state;
        if (!(selection instanceof TextSelection)) return false;
        const { $head, $anchor } = selection;
        if (!$head.parent.isTextblock) return false;
        if ($head.textOffset === 0) return false;
        if (!textblockHasInlineAtom($head.parent)) return false;
        if ($head.parentOffset <= 0) return false;

        view.dispatch(
          state.tr
            .setSelection(
              TextSelection.create(state.doc, $anchor.pos, $head.pos - 1),
            )
            .scrollIntoView(),
        );
        return true;
      },
    };
  },
});
