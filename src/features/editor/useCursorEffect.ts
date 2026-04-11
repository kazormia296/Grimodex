import { useEffect, useRef } from "react";
import type { Editor } from "@tiptap/react";

/**
 * Renders a custom typewriter-style cursor overlay with:
 * - Fade-based blink animation (530ms on → 200ms fade → 270ms off)
 * - Smooth 80ms slide transition on cursor movement
 * - Transition disabled during IME composition and deletion
 *
 * At soft-wrap boundaries the same model position maps to two visual
 * positions (end-of-line vs start-of-next-line).  Rather than trying to
 * reverse-engineer the browser's caret affinity from coordsAtPos alone,
 * we track the last navigation key (Home/End/Arrow) and choose the
 * appropriate side.  For clicks and other actions we read the DOM
 * Selection's getClientRects() which preserves the browser's native
 * affinity.
 */
export function useCursorEffect(editor: Editor | null, enabled: boolean) {
  const cursorRef = useRef<HTMLDivElement | null>(null);
  const rafRef = useRef(0);

  useEffect(() => {
    if (!editor || !enabled) return;

    const dom = editor.view.dom;
    const wrapper = dom.parentElement;
    if (!wrapper) return;

    // Ensure wrapper is a positioning context
    wrapper.style.position = "relative";

    // Create the fake cursor element
    const cursor = document.createElement("div");
    cursor.className = "typewriter-cursor blinking";
    wrapper.appendChild(cursor);
    cursorRef.current = cursor;

    // Hide native caret
    dom.style.caretColor = "transparent";

    // Track previous doc size to detect rapid typing/deletion
    let prevDocSize = editor.view.state.doc.content.size;
    let noTransitionTimer = 0;

    // Track last navigation key to determine caret affinity at wrap points.
    type NavAction =
      | "home"
      | "end"
      | "left"
      | "right"
      | "up"
      | "down"
      | "other";
    let lastNavAction: NavAction = "other";
    // Track last cursor X coordinate (viewport space) so that ArrowUp/Down
    // at a wrap point can pick the visually closest side (line-end vs line-start).
    let lastX = 0;

    function onKeyDown(e: KeyboardEvent) {
      switch (e.key) {
        case "Home":
          lastNavAction = "home";
          break;
        case "End":
          lastNavAction = "end";
          break;
        case "ArrowLeft":
          lastNavAction = "left";
          break;
        case "ArrowRight":
          lastNavAction = "right";
          break;
        case "ArrowUp":
          lastNavAction = "up";
          break;
        case "ArrowDown":
          lastNavAction = "down";
          break;
        default:
          lastNavAction = "other";
          break;
      }
    }

    function onMouseDown() {
      lastNavAction = "other";
    }

    function update() {
      const el = cursorRef.current;
      if (!el || !editor) return;

      if (!editor.isFocused || !editor.view.state.selection.empty) {
        el.style.visibility = "hidden";
        return;
      }

      // Disable transition on any doc size change (insertion or deletion);
      // re-enable after 200ms of inactivity so the cursor slides again once
      // the user pauses.
      const docSize = editor.view.state.doc.content.size;
      if (docSize !== prevDocSize) {
        el.classList.add("no-transition");
        clearTimeout(noTransitionTimer);
        noTransitionTimer = window.setTimeout(() => {
          el.classList.remove("no-transition");
        }, 200);
      }
      prevDocSize = docSize;

      const { from } = editor.view.state.selection;
      try {
        let coords: { left: number; top: number; bottom: number };

        // Detect soft-wrap point: side=-1 (line end) and side=1 (line start)
        // give different Y positions at a wrap boundary.
        let isWrapPoint = false;
        let lineEndCoords: typeof coords | null = null;
        let lineStartCoords: typeof coords | null = null;
        try {
          lineEndCoords = editor.view.coordsAtPos(from, -1);
          lineStartCoords = editor.view.coordsAtPos(from, 1);
          isWrapPoint = Math.abs(lineEndCoords.top - lineStartCoords.top) > 2;
        } catch {
          // coordsAtPos can throw near inline atom nodes — not a wrap point
        }

        if (isWrapPoint && lineEndCoords && lineStartCoords) {
          // At a wrap point: choose visual position based on navigation action
          if (lastNavAction === "end" || lastNavAction === "right") {
            coords = lineEndCoords; // end of current visual line
          } else if (lastNavAction === "home" || lastNavAction === "left") {
            coords = lineStartCoords; // start of next visual line
          } else if (lastNavAction === "up" || lastNavAction === "down") {
            // Vertical movement: pick the side whose X is closest to the
            // previous cursor X position (mimics the browser's column-memory).
            const distToEnd = Math.abs(lineEndCoords.left - lastX);
            const distToStart = Math.abs(lineStartCoords.left - lastX);
            coords = distToEnd < distToStart ? lineEndCoords : lineStartCoords;
          } else {
            // Clicks, typing, etc: read browser's caret position
            coords = getDomSelectionCoords(editor) ?? lineStartCoords;
          }
        } else {
          // Not a wrap point: coordsAtPos is unambiguous
          coords = editor.view.coordsAtPos(from);
        }

        lastX = coords.left;

        const rect = wrapper!.getBoundingClientRect();

        el.style.visibility = "visible";
        el.style.left = `${coords.left - rect.left}px`;
        el.style.top = `${coords.top - rect.top}px`;
        el.style.height = `${coords.bottom - coords.top}px`;

        // Restart blink: show solid cursor, then resume blinking
        el.classList.remove("blinking");
        cancelAnimationFrame(rafRef.current);
        rafRef.current = requestAnimationFrame(() => {
          el.classList.add("blinking");
        });
      } catch {
        el.style.visibility = "hidden";
      }
    }

    // IME composition: disable smooth transition during input
    function onCompositionStart() {
      cursorRef.current?.classList.add("composing");
    }
    function onCompositionEnd() {
      cursorRef.current?.classList.remove("composing");
      requestAnimationFrame(update);
    }

    // Capture-phase keydown so lastNavAction is set before ProseMirror
    // processes the event and dispatches a transaction.
    dom.addEventListener("keydown", onKeyDown, true);
    dom.addEventListener("mousedown", onMouseDown);
    editor.on("selectionUpdate", update);
    editor.on("update", update);
    editor.on("focus", update);
    editor.on("blur", update);
    dom.addEventListener("compositionstart", onCompositionStart);
    dom.addEventListener("compositionend", onCompositionEnd);

    update();

    return () => {
      dom.removeEventListener("keydown", onKeyDown, true);
      dom.removeEventListener("mousedown", onMouseDown);
      editor.off("selectionUpdate", update);
      editor.off("update", update);
      editor.off("focus", update);
      editor.off("blur", update);
      dom.removeEventListener("compositionstart", onCompositionStart);
      dom.removeEventListener("compositionend", onCompositionEnd);
      dom.style.caretColor = "";
      cancelAnimationFrame(rafRef.current);
      clearTimeout(noTransitionTimer);
      cursor.remove();
      cursorRef.current = null;
    };
  }, [editor, enabled]);
}

/** Read caret coordinates from the DOM Selection's client rects. */
function getDomSelectionCoords(
  editor: Editor,
): { left: number; top: number; bottom: number } | null {
  const win = editor.view.dom.ownerDocument.defaultView;
  const domSel = win?.getSelection();
  if (!domSel?.isCollapsed || !domSel.rangeCount) return null;
  const rects = domSel.getRangeAt(0).getClientRects();
  if (!rects.length) return null;
  const r = rects[0];
  return { left: r.left, top: r.top, bottom: r.bottom };
}
