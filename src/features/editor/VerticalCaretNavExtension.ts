import { Extension } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { adjacentColumnPoint, resolveCoordsVertical } from "./cursorCoords";

/**
 * VerticalCaretNavExtension — 縦書き (vertical-rl) 時の ←/→ キャレット移動を
 * Chromium のレイアウト規約に合わせて置き換える。
 *
 * 縦書き規約 (CursorOverlayPlugin / ParagraphMoveExtension と一致):
 *   ← = 次の列 (前方 / 左)、→ = 前の列 (後方 / 右)。
 *
 * ── ←/→ (列間 = ブロック軸) ──
 * Chromium は vertical-rl の hardBreak (Shift+Enter の段落内改行) 境界で「視覚的な
 * 列移動」を適用できず横書き論理の前進 (pos+1) にフォールバックする不具合があり、
 * 一行目末尾で → を押すと二行目行頭へ飛ぶ。縦書き時は ←/→ を必ず consume し、実矩形
 * (resolveCoordsVertical) から隣接列の同じインライン位置を posAtCoords で解決して
 * selection を張り替える。移動先が無い (ドキュメント端) 場合も consume して no-op。
 *
 * 修飾つき左右矢印は据え置き。横書きでは素通し。
 */

/** view.dom (contenteditable) の computed writing-mode が縦書きか。 */
function isVerticalView(view: EditorView): boolean {
  return getComputedStyle(view.dom).writingMode.startsWith("vertical");
}

/** 列ピッチ (px) = キャレット位置の親要素の computed line-height。取れなければ fallback。 */
function columnPitch(view: EditorView, pos: number, fallback: number): number {
  try {
    const { node } = view.domAtPos(pos);
    const el = node.nodeType === 1 ? (node as Element) : node.parentElement;
    if (el) {
      const lh = parseFloat(getComputedStyle(el).lineHeight);
      if (Number.isFinite(lh) && lh > 0) return lh;
    }
  } catch {
    // ignore — fallback を使う
  }
  return fallback;
}

/**
 * 縦書きの列移動。dir "next"=左(前方) / "prev"=右(後方)。extend=Shift 選択拡張。
 * 縦書き時は常に true を返して consume する (移動先が無くても no-op consume)。
 * 横書き時のみ false でネイティブに素通し。
 */
function moveColumn(
  view: EditorView,
  dir: "next" | "prev",
  extend: boolean,
): boolean {
  if (!isVerticalView(view)) return false;

  const { selection } = view.state;
  const from = selection.head;
  const rect = resolveCoordsVertical(view, from, 1);
  if (!rect) return false; // 座標が取れないときはネイティブに委譲

  const centerX = (rect.left + rect.right) / 2;
  const y = rect.top;
  const pitch = columnPitch(
    view,
    from,
    Math.max(rect.right - rect.left, 8) * 1.8,
  );

  // 段落端では隣接列が同一段落内に無く posAtCoords が現在 pos を返すことがある。
  // 段落間ギャップ (marginBlock) を跨ぐため段階的にステップを伸ばして探索する。
  let targetPos: number | null = null;
  for (const mult of [1, 2, 3]) {
    const point = adjacentColumnPoint(centerX, y, pitch * mult, dir);
    const found = view.posAtCoords(point);
    if (found && found.pos !== from) {
      targetPos = found.pos;
      break;
    }
  }

  // 移動先が無い = 真のドキュメント端。バグ抑止のため consume して no-op。
  if (targetPos === null) return true;

  const { doc } = view.state;
  const $target = doc.resolve(targetPos);
  const nextSelection = extend
    ? TextSelection.between(selection.$anchor, $target)
    : TextSelection.near($target);
  if (nextSelection.eq(selection)) return true;

  view.dispatch(view.state.tr.setSelection(nextSelection).scrollIntoView());
  return true;
}

export const VerticalCaretNavExtension = Extension.create({
  name: "verticalCaretNav",

  addKeyboardShortcuts() {
    return {
      ArrowLeft: () => moveColumn(this.editor.view, "next", false),
      ArrowRight: () => moveColumn(this.editor.view, "prev", false),
      "Shift-ArrowLeft": () => moveColumn(this.editor.view, "next", true),
      "Shift-ArrowRight": () => moveColumn(this.editor.view, "prev", true),
    };
  },
});
