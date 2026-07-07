import { useEffect } from "react";
import type { Editor } from "@tiptap/core";
import type { EditorView } from "@tiptap/pm/view";
import type { RefObject } from "react";
import { resolveCoordsVertical } from "./cursorCoords";

/**
 * 縦書き (vertical-rl) でキャレットが属する列の中心 x (viewport 座標)。
 *
 * coordsAtPos は縦書きで矩形を「left=right のゼロ幅」に潰す (= 列の端) ため、
 * そのまま使うと列が半列ぶん中央からずれる。resolveCoordsVertical は列幅を
 * 保つので (left+right)/2 で列中心を得る。取れなければ coordsAtPos の左端へ
 * フォールバック (null = 座標解決不能)。
 */
export function verticalColumnCenterX(
  view: EditorView,
  from: number,
): number | null {
  const v = resolveCoordsVertical(view, from, 1);
  if (v) return (v.left + v.right) / 2;
  try {
    return view.coordsAtPos(from).left;
  } catch {
    return null;
  }
}

/**
 * Pure calculation: given cursor and container geometry, returns the target
 * scrollTop to center the cursor vertically in the scroll container
 * (横書き: 行は縦に積まれるので縦スクロールで行をセンタリング)。
 */
export function computeTypewriterScrollTop(
  cursorAbsoluteTop: number,
  containerAbsoluteTop: number,
  currentScrollTop: number,
  containerHeight: number,
): number {
  const cursorRelativeY = cursorAbsoluteTop - containerAbsoluteTop;
  return currentScrollTop + cursorRelativeY - containerHeight / 2;
}

/**
 * 縦書き (vertical-rl) 版: 列は横に積まれ右→左に流れるので、水平スクロール
 * (scrollLeft) でキャレットの属する列を水平中央へ寄せる。
 *
 * `currentScrollLeft + delta` の相対式は scrollLeft の符号規約に依存しない
 * (Chromium の vertical-rl は 0 起点・負方向だが、現在値に delta を足すだけ
 * なのでそのまま成立する)。負の scrollLeft も許容するため呼び出し側で
 * Math.max(0, …) のクランプはしない (ブラウザが有効域へクランプする)。
 */
export function computeTypewriterScrollLeft(
  cursorAbsoluteLeft: number,
  containerAbsoluteLeft: number,
  currentScrollLeft: number,
  containerWidth: number,
): number {
  const cursorRelativeX = cursorAbsoluteLeft - containerAbsoluteLeft;
  return currentScrollLeft + cursorRelativeX - containerWidth / 2;
}

/**
 * When enabled, scrolls the editor container so the cursor line/column stays
 * centered on every selection update. `vertical` で軸を切り替える:
 * 横書き=縦スクロール(行を縦中央)、縦書き=横スクロール(列を横中央)。
 */
export function useTypewriterScroll(
  editor: Editor | null,
  enabled: boolean,
  scrollContainerRef: RefObject<HTMLDivElement | null>,
  vertical = false,
) {
  useEffect(() => {
    if (!editor || !enabled) return;

    function scrollToCenter() {
      const container = scrollContainerRef.current;
      if (!container || !editor) return;

      const { from } = editor.view.state.selection;
      const containerRect = container.getBoundingClientRect();
      if (vertical) {
        const cursorX = verticalColumnCenterX(editor.view, from);
        if (cursorX == null) return;
        const targetScrollLeft = computeTypewriterScrollLeft(
          cursorX,
          containerRect.left,
          container.scrollLeft,
          containerRect.width,
        );
        container.scrollTo({ left: targetScrollLeft, behavior: "smooth" });
      } else {
        let cursorTop: number;
        try {
          cursorTop = editor.view.coordsAtPos(from).top;
        } catch {
          return;
        }
        const targetScrollTop = computeTypewriterScrollTop(
          cursorTop,
          containerRect.top,
          container.scrollTop,
          containerRect.height,
        );
        container.scrollTo({
          top: Math.max(0, targetScrollTop),
          behavior: "smooth",
        });
      }
    }

    editor.on("selectionUpdate", scrollToCenter);
    return () => {
      editor.off("selectionUpdate", scrollToCenter);
    };
  }, [editor, enabled, scrollContainerRef, vertical]);
}
