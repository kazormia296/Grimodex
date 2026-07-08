import { isMac } from "@/lib/platform";

/**
 * True when keyboard focus is inside a TipTap / contenteditable editor surface.
 * Used to scope Windows system-menu suppression to active editing sessions.
 */
export function isEditorTextFocus(): boolean {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return false;
  if (active.isContentEditable) return true;
  return active.closest(".ProseMirror") !== null;
}

/**
 * Whether to call preventDefault on this keydown to block the OS window menu
 * (Alt mnemonic / Alt+Space) while editing. macOS has no equivalent behavior.
 */
export function shouldSuppressSystemMenuOnAlt(
  e: KeyboardEvent,
  mac = isMac(),
): boolean {
  if (mac) return false;
  if (!isEditorTextFocus()) return false;
  // AltGr (e.g. €) is Ctrl+Alt on Windows — must not be swallowed.
  if (e.ctrlKey || e.metaKey) return false;
  if (e.key === "Alt" || e.code === "AltLeft" || e.code === "AltRight") {
    return true;
  }
  if (e.altKey && e.key === " ") return true;
  return false;
}

let installed = false;

/** Install a capture-phase listener that suppresses Windows system menu on Alt. */
export function installSuppressSystemMenuOnAlt(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;
  document.addEventListener(
    "keydown",
    (e) => {
      if (shouldSuppressSystemMenuOnAlt(e)) e.preventDefault();
    },
    true,
  );
}
