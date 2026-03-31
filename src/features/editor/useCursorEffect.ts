import { useEffect, useRef } from "react";
import type { Editor } from "@tiptap/react";

/**
 * Renders a custom typewriter-style cursor overlay with:
 * - Fade-based blink animation (530ms on → 200ms fade → 270ms off)
 * - Smooth 80ms slide transition on cursor movement
 * - Transition disabled during IME composition and deletion
 */
export function useCursorEffect(editor: Editor | null) {
  const cursorRef = useRef<HTMLDivElement | null>(null);
  const rafRef = useRef(0);

  useEffect(() => {
    if (!editor) return;

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

    // Track previous doc size to detect deletion
    let prevDocSize = editor.view.state.doc.content.size;

    function update() {
      const el = cursorRef.current;
      if (!el || !editor) return;

      if (!editor.isFocused || !editor.view.state.selection.empty) {
        el.style.visibility = "hidden";
        return;
      }

      // Disable transition on deletion (doc got shorter)
      const docSize = editor.view.state.doc.content.size;
      if (docSize < prevDocSize) {
        el.classList.add("no-transition");
      } else {
        el.classList.remove("no-transition");
      }
      prevDocSize = docSize;

      const { from } = editor.view.state.selection;
      try {
        const coords = editor.view.coordsAtPos(from);
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

    editor.on("selectionUpdate", update);
    editor.on("update", update);
    editor.on("focus", update);
    editor.on("blur", update);
    dom.addEventListener("compositionstart", onCompositionStart);
    dom.addEventListener("compositionend", onCompositionEnd);

    update();

    return () => {
      editor.off("selectionUpdate", update);
      editor.off("update", update);
      editor.off("focus", update);
      editor.off("blur", update);
      dom.removeEventListener("compositionstart", onCompositionStart);
      dom.removeEventListener("compositionend", onCompositionEnd);
      dom.style.caretColor = "";
      cancelAnimationFrame(rafRef.current);
      cursor.remove();
      cursorRef.current = null;
    };
  }, [editor]);
}
