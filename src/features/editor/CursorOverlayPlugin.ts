import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorState } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import {
  caretBox,
  lineAxisContentCoord,
  resolveCoords,
  resolveCoordsVertical,
  resolveVerticalBias,
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
  getVertical: () => boolean = () => false,
): Plugin {
  let overlayView: CursorOverlayView | null = null;

  return new Plugin({
    key: cursorOverlayKey,

    view(editorView) {
      overlayView = new CursorOverlayView(
        editorView,
        getEnabled,
        getBlink,
        getVertical,
      );
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
  /**
   * Parent of `view.dom` at the time of writing. TipTap's React EditorContent
   * moves `view.dom` (and all its sibling childNodes — including this cursor
   * element) into a new wrapper div on unmount/remount. When that happens the
   * cursor element follows the tree, but a captured wrapper reference would go
   * stale: `getBoundingClientRect()` on the detached old wrapper returns 0,0
   * and `position: relative` is only set on the old node. `syncWrapper()`
   * re-acquires the current parent before each cursor update.
   */
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
   * Coordinates of the most recent mousedown (viewport-relative).
   * Used once in the next updateCursor call to resolve wrap affinity,
   * then cleared. The axis read depends on writing mode (Y when horizontal,
   * X when vertical-rl).
   */
  private pendingClick: { x: number; y: number } | null = null;
  /**
   * Wrapper-content-relative line-axis coordinate of the last rendered
   * cursor position (lineAxisContentCoord — forward-positive in both
   * writing modes), stable across scroll changes.
   */
  private prevLineCoord: number | null = null;
  /**
   * Set by line-crossing keys in updateBiasFromKey, consumed by
   * updateCursor. When non-null, updateCursor resolves bias by comparing
   * candidate coordinates against prevLineCoord rather than using the
   * preserved bias. "down" = forward (next line), "up" = backward.
   */
  private pendingVertical: "up" | "down" | null = null;

  /**
   * One-shot flag: the next cursor update should snap (no slide) instead of
   * the 80ms transition. Set for Alt+Arrow (paragraph move) where the caret
   * jumps to a relocated block and a slide would read as a flicker.
   */
  private pendingSnap = false;

  constructor(
    private view: EditorView,
    private getEnabled: () => boolean,
    private getBlink: () => boolean,
    private getVertical: () => boolean = () => false,
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

  /**
   * Re-acquire the current `view.dom` parent. See `wrapper` field doc.
   * Called from `updateCursor` so every render uses the live wrapper rect.
   */
  private syncWrapper() {
    const current = this.view.dom.parentElement;
    if (!current || current === this.wrapper) return;
    this.wrapper = current;
    this.wrapper.style.position = "relative";
    if (this.el.parentElement !== this.wrapper) {
      this.wrapper.appendChild(this.el);
    }
  }

  destroy() {
    clearTimeout(this.noTransitionTimer);
    cancelAnimationFrame(this.rafHandle);
    this.el.remove();
    this.view.dom.style.caretColor = "";
  }

  updateBiasFromKey(event: KeyboardEvent) {
    // Alt+矢印は段落移動ショートカット (ParagraphMoveExtension) で、行内/行跨ぎの
    // カーソル移動ではない。bias を変えず、キャレットが別ブロックへ大きく飛ぶので
    // スライド遷移を 1 回抑止 (snap) して「飛ぶ」ちらつきを防ぐ。
    if (event.altKey && event.key.startsWith("Arrow")) {
      this.pendingSnap = true;
      return;
    }
    // 行を跨ぐキーと行内移動キーは writing-mode で入れ替わる:
    // 横書きは ↑/↓ が行跨ぎ・←/→ が行内、縦書き (vertical-rl) は ←/→ が
    // 行跨ぎ (← = 次の行 = 前方)・↑/↓ が行内。
    const vertical = this.getVertical();
    const prevLineKey = vertical ? "ArrowRight" : "ArrowUp";
    const nextLineKey = vertical ? "ArrowLeft" : "ArrowDown";
    switch (event.key) {
      case "End":
      case "Backspace":
        this.bias = -1;
        this.pendingVertical = null;
        break;
      case prevLineKey:
      case "PageUp":
        this.pendingVertical = "up";
        break;
      case nextLineKey:
      case "PageDown":
        this.pendingVertical = "down";
        break;
      case "Home":
      case "ArrowLeft":
      case "ArrowRight":
      case "ArrowUp":
      case "ArrowDown":
        // 上の case で拾われなかった矢印 = 行内移動
        this.bias = 1;
        this.pendingVertical = null;
        break;
      default:
        if (IGNORE_KEYS.has(event.key)) break;
        this.bias = 1;
        this.pendingVertical = null;
        break;
    }
  }

  /**
   * For mouse clicks: store the click coordinates so updateCursor can
   * compare them against the two candidate line positions at a wrap
   * boundary (Y axis when horizontal, X axis when vertical-rl).
   */
  updateBiasFromClick(_view: EditorView, event: MouseEvent) {
    this.pendingClick = { x: event.clientX, y: event.clientY };
    this.pendingVertical = null;
    this.bias = 1; // will be refined in updateCursor if wrap point
  }

  updateCursor(view: EditorView) {
    this.syncWrapper();
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

    // Disable slide transition during rapid typing/deletion, and when a
    // paragraph move (Alt+Arrow) relocated the caret to a moved block —
    // sliding the caret across the editor reads as a flicker.
    const docSize = view.state.doc.content.size;
    if (docSize !== this.prevDocSize || this.pendingSnap) {
      this.el.classList.add("no-transition");
      clearTimeout(this.noTransitionTimer);
      this.noTransitionTimer = window.setTimeout(() => {
        this.el.classList.remove("no-transition");
      }, 200);
    }
    // 挿入 (docSize 増加 = 入力 / hardBreak / IME 確定 / ペースト) 直後のキャレットは
    // 常に新しい内容の直後 = 折り返し・改行境界では「行頭側」(bias=1)。hardBreak
    // (Shift+Enter) と IME 確定は keymap/composition が keydown を消費して
    // updateBiasFromKey に届かないため、Backspace (bias=-1) の後に再改行すると
    // bias=-1 が残り、縦書きで一行目行末にキャレットが取り残される。ここで補正する。
    if (docSize > this.prevDocSize) {
      this.bias = 1;
      this.pendingVertical = null;
    }
    this.pendingSnap = false;
    this.prevDocSize = docSize;

    const { from } = view.state.selection;
    const vertical = this.getVertical();

    // For mouse clicks: refine bias using the click position vs. the two
    // candidate line positions at a soft-wrap boundary. The line axis is
    // Y when horizontal, X when vertical-rl (lines stack leftward).
    if (this.pendingClick !== null) {
      const click = this.pendingClick;
      this.pendingClick = null;
      try {
        const endCoords = view.coordsAtPos(from, -1);
        const startCoords = view.coordsAtPos(from, 1);
        const lineGap = vertical
          ? Math.abs(endCoords.left - startCoords.left)
          : Math.abs(endCoords.top - startCoords.top);
        if (lineGap > 2) {
          const mid = (c: {
            left: number;
            right: number;
            top: number;
            bottom: number;
          }) => (vertical ? (c.left + c.right) / 2 : (c.top + c.bottom) / 2);
          const clickCoord = vertical ? click.x : click.y;
          const distToEnd = Math.abs(clickCoord - mid(endCoords));
          const distToStart = Math.abs(clickCoord - mid(startCoords));
          this.bias = distToEnd <= distToStart ? -1 : 1;
        }
      } catch {
        // Not a wrap point or atom node — keep default bias.
      }
    }

    // Resolve wrap affinity after line-crossing keys using the previous
    // line-axis position. Coordinates are converted to a forward-positive
    // wrapper-content-relative axis (lineAxisContentCoord) so the same
    // resolveVerticalBias logic works for both writing modes and stays
    // stable across scrolls between frames.
    if (this.pendingVertical !== null && this.prevLineCoord !== null) {
      try {
        const endCoord = this.toContentLineCoord(
          view.coordsAtPos(from, -1),
          vertical,
        );
        const startCoord = this.toContentLineCoord(
          view.coordsAtPos(from, 1),
          vertical,
        );
        const resolved = resolveVerticalBias(
          endCoord,
          startCoord,
          this.prevLineCoord,
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

    // hardBreak の直後の位置は、折り返しではなく「常に次の行の行頭」であり、
    // 前行の行末という解釈は存在しない (行末は hardBreak の直前 = pos_before_br)。
    // Backspace で hardBreak を消して空行の行頭 (= 残った hardBreak の直後) へ来ると
    // bias=-1 のまま前の hardBreak の矩形 = 一行目行末を選んでしまう。ここで
    // 行頭側 (bias=1) を最終確定し、click/矢印由来の bias より優先する。
    if (view.state.selection.$from.nodeBefore?.type.name === "hardBreak") {
      this.bias = 1;
    }

    // 縦書きは DOM Range ベースのリゾルバで列幅とインライン位置を再構成する
    // (PM の coordsAtPos は flattenV で横書き前提に潰すため)。失敗時は
    // flatten 版へフォールバック (点になるが非表示よりまし)。
    const coords = vertical
      ? (resolveCoordsVertical(view, from, this.bias) ??
        resolveCoords(view, from, this.bias))
      : resolveCoords(view, from, this.bias);
    if (!coords) {
      this.hide();
      return;
    }

    this.prevLineCoord = this.toContentLineCoord(coords, vertical);

    const box = caretBox(
      coords,
      this.wrapper.getBoundingClientRect(),
      vertical,
    );
    this.el.style.visibility = "visible";
    this.el.style.left = `${box.left}px`;
    this.el.style.top = `${box.top}px`;
    this.el.style.width = `${box.width}px`;
    this.el.style.height = `${box.height}px`;

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

  /**
   * Convert viewport coords to a wrapper-content-relative line-axis
   * coordinate (forward-positive in both writing modes).
   */
  private toContentLineCoord(
    coords: { left: number; top: number },
    vertical: boolean,
  ): number {
    return lineAxisContentCoord(
      coords,
      this.wrapper.getBoundingClientRect(),
      this.wrapper,
      vertical,
    );
  }
}
