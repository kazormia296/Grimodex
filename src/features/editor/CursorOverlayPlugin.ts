import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorState } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { resolveCoords, toContainerRelative } from "./cursorCoords";

export const cursorOverlayKey = new PluginKey("cursorOverlay");

/**
 * Creates a ProseMirror plugin that renders a custom typewriter-style cursor
 * overlay with:
 * - Fade-based blink animation (530ms on → 200ms fade → 270ms off)
 * - Smooth 80ms slide transition on cursor movement
 * - Transition disabled during IME composition and deletion
 *
 * Using the Plugin `view()` lifecycle (constructor / update / destroy) gives a
 * timing guarantee that the DOM Selection is already synced when `update()` is
 * called, avoiding the race conditions that exist with React event listeners.
 *
 * @param getEnabled - Callback to read the current enabled state. Called on
 *   every update so that toggling the setting takes effect without
 *   re-registering the plugin.
 */
export function createCursorOverlayPlugin(getEnabled: () => boolean): Plugin {
  // Shared reference between view() factory and handleDOMEvents handlers.
  // view() is called synchronously during plugin registration, so this is
  // always set before any DOM event can fire.
  let overlayView: CursorOverlayView | null = null;

  return new Plugin({
    key: cursorOverlayKey,

    view(editorView) {
      overlayView = new CursorOverlayView(editorView, getEnabled);
      return overlayView;
    },

    props: {
      handleDOMEvents: {
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
          // Defer one frame so the editor state reflects the committed text
          requestAnimationFrame(() => overlayView?.updateCursor(view));
          return false;
        },
      },
    },
  });
}

class CursorOverlayView {
  private el: HTMLDivElement;
  private wrapper: HTMLElement;
  private prevDocSize: number;
  private noTransitionTimer = 0;
  private rafHandle = 0;

  constructor(
    private view: EditorView,
    private getEnabled: () => boolean,
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

  updateCursor(view: EditorView) {
    // Manage native caret visibility based on enabled state
    if (!this.getEnabled()) {
      view.dom.style.caretColor = "";
      this.el.style.visibility = "hidden";
      return;
    }
    // Overlay is active: hide native caret
    view.dom.style.caretColor = "transparent";

    if (!view.hasFocus() || !view.state.selection.empty) {
      this.hide();
      return;
    }

    // Disable transition during rapid typing/deletion; re-enable after 200ms
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
    const coords = resolveCoords(view, from);
    if (!coords) {
      this.hide();
      return;
    }

    const pos = toContainerRelative(
      coords,
      this.wrapper.getBoundingClientRect(),
    );
    this.el.style.visibility = "visible";
    this.el.style.left = `${pos.left}px`;
    this.el.style.top = `${pos.top}px`;
    this.el.style.height = `${pos.height}px`;

    // Restart blink: render solid cursor for one frame, then resume blinking
    this.el.classList.remove("blinking");
    cancelAnimationFrame(this.rafHandle);
    this.rafHandle = requestAnimationFrame(() => {
      this.el.classList.add("blinking");
    });
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
}
