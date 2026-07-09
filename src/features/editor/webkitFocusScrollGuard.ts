import { Selection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { isWebKitGtk } from "@/lib/platform";

/**
 * WebKitGTK の contenteditable は blur→再 focus で DOM selection を文書先頭へ
 * リセットする（Chromium は元位置を保持）。prosemirror-view はこのリセットを
 * 検出すると focus 後 200ms 以内なら selection を state へ同期して
 * view.scrollToSelection() を呼ぶため、「クリックせず読み進めた位置で
 * ポップオーバー等がフォーカスを揺らす → 先頭へスクロール」というジャンプに
 * なる（縦書きの Codex ホバーポップオーバーで顕在化。縦書きではスクロール軸が
 * 水平なので、先頭 = 右端へ吹っ飛ぶ）。
 *
 * このガードは editorProps.handleScrollToSelection に挿し、
 * 「focus 直後の時間窓内」かつ「selection が文書先頭の空選択」のときだけ
 * scrollToSelection を抑止する（true を返すと PM は既定スクロールをしない）。
 * Ctrl+Home 等のキーボード先頭移動は focus イベントを伴わず、先頭クリックは
 * 既に先頭が見えているため、抑止しても実害はない。
 */

/** focus からこの時間内の「先頭 selection への scrollToSelection」を抑止する。
 *  prosemirror-view の focus 後リセット検出窓 (200ms) より少し広く取る。 */
const SUPPRESS_WINDOW_MS = 250;

/** 判定本体（純関数・テスト対象）。 */
export function shouldSuppressScrollToSelection(args: {
  webkitGtk: boolean;
  selectionEmpty: boolean;
  selectionFrom: number;
  /** doc の「最初のカーソル可能位置」(Selection.atStart(doc).from)。
   *  先頭が blockquote/リスト/Beat の doc では 1 より大きくなるため、
   *  定数 1 との比較では抑止漏れになる (PM 側のリセット検出も同じ動的
   *  位置と比較している)。 */
  docStartPos: number;
  msSinceFocus: number;
}): boolean {
  if (!args.webkitGtk) return false;
  // 空選択で文書先頭のときだけ疑う
  if (!args.selectionEmpty || args.selectionFrom > args.docStartPos)
    return false;
  return args.msSinceFocus >= 0 && args.msSinceFocus < SUPPRESS_WINDOW_MS;
}

export interface WebKitFocusScrollGuard {
  /** エディタの onFocus で呼ぶ（focus 時刻を記録する）。 */
  noteFocus: () => void;
  /** editorProps.handleScrollToSelection に渡す。true = スクロール抑止。 */
  handleScrollToSelection: (view: EditorView) => boolean;
}

export function createWebKitFocusScrollGuard(
  now: () => number = () => Date.now(),
): WebKitFocusScrollGuard {
  let lastFocusAt = Number.NEGATIVE_INFINITY;
  return {
    noteFocus() {
      lastFocusAt = now();
    },
    handleScrollToSelection(view: EditorView): boolean {
      const sel = view.state.selection;
      return shouldSuppressScrollToSelection({
        webkitGtk: isWebKitGtk(),
        selectionEmpty: sel.empty,
        selectionFrom: sel.from,
        docStartPos: Selection.atStart(view.state.doc).from,
        msSinceFocus: now() - lastFocusAt,
      });
    },
  };
}
