import type { EditorView } from "@tiptap/pm/view";
import { useCursorSettingsStore } from "./cursorSettingsStore";
import { useBackgroundStudioStore } from "./background/backgroundStudioStore";

const forwardedEscapeEvents = new WeakSet<KeyboardEvent>();

/**
 * ProseMirror consumes every Escape in its built-in key capture, even when no
 * editor command handled it. Forward Escape through the editor's registered
 * handlers first, then use Zen dismissal as the final editor-level fallback.
 */
export function handleZenEscapeKeyDown(
  view: EditorView,
  event: KeyboardEvent,
): boolean {
  if (
    event.key !== "Escape" ||
    event.defaultPrevented ||
    event.isComposing ||
    event.keyCode === 229 ||
    !useCursorSettingsStore.getState().zenMode
  ) {
    return false;
  }

  // This helper itself is installed as the direct handleKeyDown prop. The
  // guard lets someProp re-enter that prop once and continue on to extension
  // handlers without recursively forwarding the same event forever.
  if (forwardedEscapeEvents.has(event)) return false;

  forwardedEscapeEvents.add(event);
  try {
    if (useBackgroundStudioStore.getState().open) {
      event.preventDefault();
      useBackgroundStudioStore.getState().setOpen(false);
      return true;
    }
    const handledByEditor = view.someProp("handleKeyDown", (handler) =>
      handler(view, event),
    );
    if (handledByEditor) return true;

    event.preventDefault();
    useCursorSettingsStore.getState().setZenMode(false);
    return true;
  } finally {
    forwardedEscapeEvents.delete(event);
  }
}
