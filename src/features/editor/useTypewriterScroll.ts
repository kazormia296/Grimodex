import { useEffect } from "react";
import type { Editor } from "@tiptap/core";
import type { RefObject } from "react";

/**
 * Pure calculation: given cursor and container geometry, returns the target
 * scrollTop to center the cursor vertically in the scroll container.
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
 * When enabled, scrolls the editor container so the cursor line stays at
 * the vertical center on every selection update.
 */
export function useTypewriterScroll(
  editor: Editor | null,
  enabled: boolean,
  scrollContainerRef: RefObject<HTMLDivElement | null>,
) {
  useEffect(() => {
    if (!editor || !enabled) return;

    function scrollToCenter() {
      const container = scrollContainerRef.current;
      if (!container || !editor) return;

      const { from } = editor.view.state.selection;
      let coordsTop: number;
      try {
        coordsTop = editor.view.coordsAtPos(from).top;
      } catch {
        return;
      }

      const containerRect = container.getBoundingClientRect();
      const targetScrollTop = computeTypewriterScrollTop(
        coordsTop,
        containerRect.top,
        container.scrollTop,
        containerRect.height,
      );

      container.scrollTo({
        top: Math.max(0, targetScrollTop),
        behavior: "smooth",
      });
    }

    editor.on("selectionUpdate", scrollToCenter);
    return () => {
      editor.off("selectionUpdate", scrollToCenter);
    };
  }, [editor, enabled, scrollContainerRef]);
}
