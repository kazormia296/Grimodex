import { useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { Editor } from "@tiptap/react";
import { BUILTIN_CODEX_TYPES } from "@/features/codex/api";
import { useCodexStore } from "@/features/codex/codexStore";
import { useSnippetStore } from "@/features/snippets/snippetStore";
import { useSceneStore } from "@/features/tree/store";
import { useLayoutStore } from "@/features/layout/layoutStore";
import {
  LintDisablePicker,
  selectionFromEditor,
} from "@/features/lint/LintDisablePicker";

interface Position {
  x: number;
  y: number;
}

interface EditorContextMenuProps {
  editor: Editor | null;
  containerRef: React.RefObject<HTMLElement | null>;
}

/**
 * C-6: Right-click context menu for editor selection.
 * "コデックスに追加" / "スニペットとして保存"
 */
export function EditorContextMenu({
  editor,
  containerRef,
}: EditorContextMenuProps) {
  const { t } = useTranslation();
  const [pos, setPos] = useState<Position | null>(null);
  const [selectedText, setSelectedText] = useState("");
  const [lintDisableOpen, setLintDisableOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const activeSceneId = useSceneStore((s) => s.activeSceneId);
  const codexCreate = useCodexStore((s) => s.create);
  const snippetCreate = useSnippetStore((s) => s.create);

  const close = useCallback(() => {
    setPos(null);
  }, []);

  // Context menu handler
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !editor) return;

    function onContextMenu(e: MouseEvent) {
      if (!editor) return;
      const text = editor.state.selection.empty
        ? ""
        : editor.state.doc.textBetween(
            editor.state.selection.from,
            editor.state.selection.to,
            " ",
          );
      if (!text.trim()) return;

      e.preventDefault();
      setSelectedText(text);
      setPos({ x: e.clientX, y: e.clientY });
    }

    container.addEventListener("contextmenu", onContextMenu);
    return () => container.removeEventListener("contextmenu", onContextMenu);
  }, [editor, containerRef]);

  // Close on outside click or Escape
  useEffect(() => {
    if (!pos) return;

    function onMouseDown(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        close();
      }
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }

    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [pos, close]);

  const handleAddToCodex = async () => {
    close();
    const entry = await codexCreate({
      type: BUILTIN_CODEX_TYPES[0],
      name: selectedText.trim().slice(0, 60),
      summary: "",
    });
    if (entry) {
      useLayoutStore.getState().showPanel("codex");
      useCodexStore.getState().requestSelectEntry(entry.id);
    }
  };

  const handleSaveAsSnippet = () => {
    close();
    snippetCreate({
      title: selectedText.trim().slice(0, 30),
      content: selectedText,
      sceneId: activeSceneId || undefined,
    });
  };

  const handleLintDisable = () => {
    close();
    setLintDisableOpen(true);
  };

  const lintPickerSelection =
    lintDisableOpen && editor ? selectionFromEditor(editor) : null;

  if (!pos && !lintDisableOpen) return null;

  if (!pos) {
    // Menu already closed, picker still open.
    return lintPickerSelection && editor ? (
      <LintDisablePicker
        editor={editor}
        selection={lintPickerSelection}
        onClose={() => setLintDisableOpen(false)}
      />
    ) : null;
  }

  // Adjust position to stay within viewport
  const menuWidth = 220;
  const x = Math.min(pos.x, window.innerWidth - menuWidth - 8);
  const y = pos.y;

  return createPortal(
    <div
      ref={menuRef}
      className="fixed z-50 rounded-md border border-border bg-popover shadow-md"
      style={{ left: x, top: y, minWidth: menuWidth }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="flex flex-col py-1">
        <div className="px-3 py-1 text-xs text-muted-foreground truncate border-b border-border mb-1">
          「{selectedText.slice(0, 30)}
          {selectedText.length > 30 ? "…" : ""}」
        </div>
        <button
          type="button"
          className="px-3 py-1.5 text-sm text-left hover:bg-accent"
          onClick={handleAddToCodex}
        >
          {t("editor.contextMenu.addToCodex")}
        </button>
        <button
          type="button"
          className="px-3 py-1.5 text-sm text-left hover:bg-accent"
          onClick={handleSaveAsSnippet}
        >
          {t("editor.contextMenu.saveAsSnippet")}
        </button>
        <div className="my-1 border-t border-border" />
        <button
          type="button"
          className="px-3 py-1.5 text-sm text-left hover:bg-accent"
          onClick={handleLintDisable}
        >
          選択範囲で Lint ルールを無効化
        </button>
      </div>
    </div>,
    document.body,
  );
}
