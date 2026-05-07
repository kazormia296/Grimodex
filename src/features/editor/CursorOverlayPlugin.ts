import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorState } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import {
  resolveCoords,
  resolveVerticalBias,
  toContainerRelative,
} from "./cursorCoords";

export const cursorOverlayKey = new PluginKey("cursorOverlay");

/**
 * Creates a ProseMirror plugin that renders a custom typewriter-style cursor
 * overlay with:
 * - Fade-based blink animation (530ms on → 200ms fade → 270ms off)
 * - Smooth 80ms slide transition on cursor movement
 * - Transition disabled during IME composition and deletion
 *
 * Soft-wrap affinity is resolved by tracking the last user action as a
 * `bias` value (-1 = line-end, 1 = line-start) and passing it directly to
 * `coordsAtPos(from, bias)`.  At non-wrap positions both sides return the
 * same coordinates so the bias has no effect.  This avoids reading the DOM
 * Selection after ProseMirror has re-set it (which loses affinity context).
 */
export function createCursorOverlayPlugin(
  getEnabled: () => boolean,
  getBlink: () => boolean = () => true,
): Plugin {
  let overlayView: CursorOverlayView | null = null;

  return new Plugin({
    key: cursorOverlayKey,

    view(editorView) {
      overlayView = new CursorOverlayView(editorView, getEnabled, getBlink);
      return overlayView;
    },

    props: {
      // Capture-phase so bias is set before ProseMirror processes the key.
      handleKeyDown(_view, event) {
        overlayView?.updateBiasFromKey(event);
        return false;
      },

      handleDOMEvents: {
        mousedown(view, event) {
          overlayView?.updateBiasFromClick(view, event as MouseEvent);
          return false;
        },
        mouseup(view) {
          // At soft-wrap boundaries the "end of visual line N" and
          // "start of visual line N+1" share the same document position.
          // ProseMirror skips the transaction when the position doesn't
          // change, so update() is never called and the pending bias
          // from mousedown is never consumed.  Force re-evaluation here.
          overlayView?.updateCursor(view);
          return false;
        },
        focus(view) {
          overlayView?.updateCursor(view);
          return false;
        },
        blur() {
          overlayView?.hide();
          return false;
        },
        compositionstart() {
          overlayView?.setComposing(true);
          return false;
        },
        compositionend(view) {
          overlayView?.setComposing(false);
          requestAnimationFrame(() => overlayView?.updateCursor(view));
          return false;
        },
      },
    },
  });
}

/** Keys that should not alter soft-wrap bias (modifiers, locks, etc.). */
const IGNORE_KEYS = new Set([
  "Shift",
  "Control",
  "Alt",
  "Meta",
  "CapsLock",
  "NumLock",
  "ScrollLock",
  "Escape",
  "ContextMenu",
]);

class CursorOverlayView {
  private el: HTMLDivElement;
  private wrapper: HTMLElement;
  private prevDocSize: number;
  private noTransitionTimer = 0;
  private rafHandle = 0;
  /**
   * Soft-wrap affinity bias.
   *   -1  line-end side  (End, Backspace)
   *    1  line-start side (Home, ArrowLeft, ArrowRight, typing, default)
   */
  private bias: -1 | 1 = 1;
  /**
   * Y coordinate of the most recent mousedown (viewport-relative).
   * Used once in the next updateCursor call to resolve wrap affinity,
   * then cleared.
   */
  private pendingClickY: number | null = null;
  /**
   * Wrapper-content-relative top of the last rendered cursor position.
   * Stored as `viewportY - wrapperRect.top + wrapper.scrollTop` so
   * the value is stable across scroll changes.
   */
  private prevTop: number | null = null;
  /**
   * Set by ArrowUp/Down in updateBiasFromKey, consumed by updateCursor.
   * When non-null, updateCursor resolves bias by comparing candidate
   * coordinates against prevTop rather than using the preserved bias.
   */
  private pendingVertical: "up" | "down" | null = null;

  constructor(
    private view: EditorView,
    private getEnabled: () => boolean,
    private getBlink: () => boolean,
  ) {
    const wrapper = view.dom.parentElement;
    if (!wrapper) throw new Error("CursorOverlayView: editor has no parent");
    this.wrapper = wrapper;
    this.wrapper.style.position = "relative";

    this.el = document.createElement("div");
    this.el.className = "typewriter-cursor blinking";
    this.wrapper.appendChild(this.el);

    this.prevDocSize = view.state.doc.content.size;
    this.updateCursor(view);
  }

  update(view: EditorView, _prevState: EditorState) {
    this.view = view;
    this.updateCursor(view);
  }

  destroy() {
    clearTimeout(this.noTransitionTimer);
    cancelAnimationFrame(this.rafHandle);
    this.el.remove();
    this.view.dom.style.caretColor = "";
  }

  updateBiasFromKey(event: KeyboardEvent) {
    switch (event.key) {
      case "End":
      case "Backspace":
        this.bias = -1;
        this.pendingVertical = null;
        break;
      case "Home":
      case "ArrowLeft":
      case "ArrowRight":
        this.bias = 1;
        this.pendingVertical = null;
        break;
      case "ArrowUp":
      case "PageUp":
        this.pendingVertical = "up";
        break;
      case "ArrowDown":
      case "PageDown":
        this.pendingVertical = "down";
        break;
      default:
        if (IGNORE_KEYS.has(event.key)) break;
        this.bias = 1;
        this.pendingVertical = null;
        break;
    }
  }

  /**
   * For mouse clicks: store the click Y so updateCursor can compare it
   * against the two candidate line positions at a wrap boundary.
   */
  updateBiasFromClick(_view: EditorView, event: MouseEvent) {
    this.pendingClickY = event.clientY;
    this.pendingVertical = null;
    this.bias = 1; // will be refined in updateCursor if wrap point
  }

  updateCursor(view: EditorView) {
    if (!this.getEnabled()) {
      view.dom.style.caretColor = "";
      this.el.style.visibility = "hidden";
      return;
    }
    view.dom.style.caretColor = "transparent";

    if (!view.hasFocus() || !view.state.selection.empty) {
      this.hide();
      return;
    }

    // Disable slide transition during rapid typing/deletion.
    const docSize = view.state.doc.content.size;
    if (docSize !== this.prevDocSize) {
      this.el.classList.add("no-transition");
      clearTimeout(this.noTransitionTimer);
      this.noTransitionTimer = window.setTimeout(() => {
        this.el.classList.remove("no-transition");
      }, 200);
    }
    this.prevDocSize = docSize;

    const { from } = view.state.selection;

    // For mouse clicks: refine bias using click Y vs. the two candidate
    // line positions at a soft-wrap boundary.
    if (this.pendingClickY !== null) {
      const clickY = this.pendingClickY;
      this.pendingClickY = null;
      try {
        const endCoords = view.coordsAtPos(from, -1);
        const startCoords = view.coordsAtPos(from, 1);
        if (Math.abs(endCoords.top - startCoords.top) > 2) {
          const endMid = (endCoords.top + endCoords.bottom) / 2;
          const startMid = (startCoords.top + startCoords.bottom) / 2;
          const distToEnd = Math.abs(clickY - endMid);
          const distToStart = Math.abs(clickY - startMid);
          this.bias = distToEnd <= distToStart ? -1 : 1;
        }
      } catch {
        // Not a wrap point or atom node — keep default bias.
      }
    }

    // Resolve wrap affinity after ArrowUp/Down using previous Y position.
    // Coordinates are converted to wrapper-content-relative to stay stable
    // across scrolls that may occur between the previous and current frame.
    if (this.pendingVertical !== null && this.prevTop !== null) {
      try {
        const endTop = this.toContentY(view.coordsAtPos(from, -1).top);
        const startTop = this.toContentY(view.coordsAtPos(from, 1).top);
        const resolved = resolveVerticalBias(
          endTop,
          startTop,
          this.prevTop,
          this.pendingVertical,
        );
        if (resolved !== null) this.bias = resolved;
      } catch {
        // Not a wrap point or atom node — keep current bias.
      }
      this.pendingVertical = null;
    } else if (this.pendingVertical !== null) {
      this.pendingVertical = null;
    }

    const coords = resolveCoords(view, from, this.bias);
    if (!coords) {
      this.hide();
      return;
    }

    this.prevTop = this.toContentY(coords.top);

    const pos = toContainerRelative(
      coords,
      this.wrapper.getBoundingClientRect(),
    );
    this.el.style.visibility = "visible";
    this.el.style.left = `${pos.left}px`;
    this.el.style.top = `${pos.top}px`;
    this.el.style.height = `${pos.height}px`;

    // Restart blink: solid for one frame, then resume blinking.
    // When blink is disabled, keep the cursor solid (no class added).
    this.el.classList.remove("blinking");
    cancelAnimationFrame(this.rafHandle);
    if (this.getBlink()) {
      this.rafHandle = requestAnimationFrame(() => {
        this.el.classList.add("blinking");
      });
    }
  }

  hide() {
    this.el.style.visibility = "hidden";
  }

  setComposing(composing: boolean) {
    if (composing) {
      this.el.classList.add("composing");
    } else {
      this.el.classList.remove("composing");
    }
  }

  /** Convert a viewport-relative Y to wrapper-content-relative Y. */
  private toContentY(viewportY: number): number {
    return (
      viewportY -
      this.wrapper.getBoundingClientRect().top +
      this.wrapper.scrollTop
    );
  }
}
