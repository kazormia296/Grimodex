import { useEffect } from "react";
import type { Editor } from "@tiptap/react";

import { isMac, matchesMod } from "@/lib/platform";
import {
  getMergedBindings,
  matchesBinding,
} from "@/features/settings/keybindings";

import { useRevisionStore } from "@/features/revision/revisionStore";
import type { ToolbarActions } from "@/features/editor/Toolbar";
import type { InlineAiCommand } from "@/features/editor/inlineAi/inlineAiTypes";

interface UseEditorKeyboardArgs {
  /** Pane root — keystrokes are only handled when focus is inside this subtree. */
  paneRef: React.RefObject<HTMLDivElement | null>;
  /** Latest active scene id for revision-history opening. */
  saveSceneIdRef: React.MutableRefObject<string>;
  /** Latest editor instance for getJSON when opening history. */
  editorRef: React.MutableRefObject<Editor | null>;
  /** Toolbar actions ref (link/ruby invocation). */
  toolbarActionsRef: React.MutableRefObject<ToolbarActions | null>;
  /** Manual save (Ctrl+S). */
  handleManualSave: () => void;
  setFindOpen: (open: boolean) => void;
  setFindShowReplace: (show: boolean) => void;
  setPalettePreselect: (cmd: InlineAiCommand | null) => void;
  setPaletteOpen: (open: boolean) => void;
}

/**
 * Pane-scoped keyboard shortcuts (only fire when focus is inside this pane):
 *   save / find / findReplace / inlineAiPalette → user-configurable via
 *     Settings → Keys (matched against the merged bindings registry).
 *   revision history / link dialog / ruby dialog → fixed (not in the registry).
 *
 * findReplace (Ctrl+H) is Windows/Linux only — ⌘H is macOS "Hide".
 */
export function useEditorKeyboard({
  paneRef,
  saveSceneIdRef,
  editorRef,
  toolbarActionsRef,
  handleManualSave,
  setFindOpen,
  setFindShowReplace,
  setPalettePreselect,
  setPaletteOpen,
}: UseEditorKeyboardArgs) {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (!paneRef.current?.contains(document.activeElement)) return;
      // Configurable commands (Settings → Keys) match against the merged
      // bindings; the editor-niche ones (history/link/ruby) stay hardcoded.
      const merged = getMergedBindings();
      const mac = isMac();
      if (matchesBinding(e, merged.save ?? "", mac)) {
        e.preventDefault();
        handleManualSave();
      } else if (matchesBinding(e, merged.find ?? "", mac)) {
        e.preventDefault();
        setFindOpen(true);
        setFindShowReplace(false);
      } else if (!mac && matchesBinding(e, merged.findReplace ?? "", mac)) {
        // findReplace defaults to Ctrl+H, Windows/Linux only — ⌘H is the macOS
        // "Hide Application" shortcut, so it is excluded on macOS (see
        // CommandDef.macUnavailable). Replace is reached via the find bar toggle.
        e.preventDefault();
        setFindOpen(true);
        setFindShowReplace(true);
      } else if (matchesMod(e) && e.shiftKey && e.key === "H") {
        e.preventDefault();
        const id = saveSceneIdRef.current;
        const ed = editorRef.current;
        if (id && ed) {
          const content = JSON.stringify(ed.getJSON());
          useRevisionStore.getState().openHistory("scene", id, content);
        }
      } else if (matchesBinding(e, merged.inlineAiPalette ?? "", mac)) {
        e.preventDefault();
        setPalettePreselect(null);
        setPaletteOpen(true);
      } else if (matchesMod(e) && e.key === "k" && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        toolbarActionsRef.current?.openLink();
      } else if (matchesMod(e) && e.shiftKey && e.key === "R") {
        e.preventDefault();
        toolbarActionsRef.current?.openRuby();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    paneRef,
    saveSceneIdRef,
    editorRef,
    toolbarActionsRef,
    handleManualSave,
    setFindOpen,
    setFindShowReplace,
    setPalettePreselect,
    setPaletteOpen,
  ]);
}
