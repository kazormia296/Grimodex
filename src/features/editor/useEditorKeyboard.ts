import { useEffect } from "react";
import type { Editor } from "@tiptap/react";

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
 * Pane-scoped keyboard shortcuts:
 *   Ctrl+S       → save
 *   Ctrl+F       → find
 *   Ctrl+H       → find/replace
 *   Ctrl+Shift+H → revision history
 *   Ctrl+Shift+Space → inline AI palette
 *   Ctrl+K       → link dialog
 *   Ctrl+Shift+R → ruby dialog
 *
 * Extracted from EditorPane verbatim — behaviour is unchanged.
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
      if (e.ctrlKey && e.key === "s" && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        handleManualSave();
      } else if (e.ctrlKey && e.key === "f" && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        setFindOpen(true);
        setFindShowReplace(false);
      } else if (e.ctrlKey && e.key === "h" && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        setFindOpen(true);
        setFindShowReplace(true);
      } else if (e.ctrlKey && e.shiftKey && e.key === "H") {
        e.preventDefault();
        const id = saveSceneIdRef.current;
        const ed = editorRef.current;
        if (id && ed) {
          const content = JSON.stringify(ed.getJSON());
          useRevisionStore.getState().openHistory("scene", id, content);
        }
      } else if (e.ctrlKey && e.shiftKey && e.key === " ") {
        e.preventDefault();
        setPalettePreselect(null);
        setPaletteOpen(true);
      } else if (e.ctrlKey && e.key === "k" && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        toolbarActionsRef.current?.openLink();
      } else if (e.ctrlKey && e.shiftKey && e.key === "R") {
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
