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
import { sanitiseRules } from "@/features/lint/lintDisableWalker";

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
  /**
   * Snapshot of disable presence at context-menu open time. Captured at
   * open rather than recomputed on render so the menu is stable while
   * the user moves the cursor between actions.
   */
  const [disableState, setDisableState] = useState<{
    hasMark: boolean;
    hasBlockAttr: boolean;
  }>({ hasMark: false, hasBlockAttr: false });
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
      const sel = editor.state.selection;
      const text = sel.empty
        ? ""
        : editor.state.doc.textBetween(sel.from, sel.to, " ");

      const disableSnapshot = detectDisableAtSelection(editor);

      // Show menu when there's a real selection OR when the cursor sits
      // inside an existing disable directive (right-click-to-unset).
      if (
        !text.trim() &&
        !disableSnapshot.hasMark &&
        !disableSnapshot.hasBlockAttr
      ) {
        return;
      }

      e.preventDefault();
      setSelectedText(text);
      setDisableState(disableSnapshot);
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

  const handleLintUnset = () => {
    close();
    if (!editor) return;
    unsetDisableAtSelection(editor);
  };

  // Hide the "選択範囲で Lint ルールを無効化" entry when there is no
  // real text selection (cursor-only right-click meant to unset).
  const canSetDisable = selectedText.trim().length > 0;
  const canUnsetDisable = disableState.hasMark || disableState.hasBlockAttr;

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
        {selectedText.trim().length > 0 && (
          <div className="px-3 py-1 text-xs text-muted-foreground truncate border-b border-border mb-1">
            「{selectedText.slice(0, 30)}
            {selectedText.length > 30 ? "…" : ""}」
          </div>
        )}
        {canSetDisable && (
          <>
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
          </>
        )}
        {canUnsetDisable && (
          <>
            {canSetDisable && <div className="my-1 border-t border-border" />}
            <button
              type="button"
              className="px-3 py-1.5 text-sm text-left hover:bg-accent text-amber-700 dark:text-amber-400"
              onClick={handleLintUnset}
            >
              {disableState.hasMark && disableState.hasBlockAttr
                ? "Lint 無効化を解除（Span + ブロック）"
                : disableState.hasMark
                  ? "Lint 無効化を解除（Span）"
                  : "Lint 無効化を解除（ブロック）"}
            </button>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}

const DISABLE_BLOCK_KINDS = new Set([
  "paragraph",
  "heading",
  "blockquote",
  "listItem",
  "tableCell",
]);

/**
 * Inspect the current selection (or cursor position) for overlapping
 * `lintDisable` Marks and enclosing blocks carrying a `lintDisabled`
 * attribute. Used to decide whether the right-click menu should offer
 * "Lint 無効化を解除".
 */
function detectDisableAtSelection(editor: Editor): {
  hasMark: boolean;
  hasBlockAttr: boolean;
} {
  const { state } = editor;
  const { from, to } = state.selection;

  let hasMark = false;
  state.doc.nodesBetween(from, to, (node) => {
    if (hasMark) return false;
    if (!node.isText) return true;
    for (const m of node.marks) {
      if (m.type.name === "lintDisable") {
        const rules = sanitiseRules(m.attrs.rules);
        if (rules) {
          hasMark = true;
          return false;
        }
      }
    }
    return true;
  });

  // Also catch the cursor-at-edge-of-Mark case: when `from === to`,
  // `nodesBetween` iterates zero-width and may skip the Mark. Use
  // `isActive` as a fallback.
  if (!hasMark && from === to && editor.isActive("lintDisable")) {
    hasMark = true;
  }

  let hasBlockAttr = false;
  state.doc.nodesBetween(from, to, (node) => {
    if (hasBlockAttr) return false;
    if (!DISABLE_BLOCK_KINDS.has(node.type.name)) return true;
    const rules = sanitiseRules(node.attrs.lintDisabled);
    if (rules) {
      hasBlockAttr = true;
      return false;
    }
    return true;
  });

  return { hasMark, hasBlockAttr };
}

/**
 * Remove `lintDisable` Marks overlapping the selection AND clear the
 * `lintDisabled` attribute from every enclosing block. One transaction
 * so undo is a single step.
 */
function unsetDisableAtSelection(editor: Editor): void {
  const { state } = editor;
  const { from, to } = state.selection;
  const tr = state.tr;

  // Mark removal — `removeMark` accepts a range; use the full selection,
  // or grow a zero-width cursor into the enclosing Mark range so the
  // whole Span disappears (the design doc says "解除" should clear the
  // entire directive, not split it).
  const markType = state.schema.marks.lintDisable;
  if (markType) {
    let rangeFrom = from;
    let rangeTo = to;
    if (from === to) {
      const $pos = state.doc.resolve(from);
      // Walk outward from cursor to find the Mark boundaries.
      const marks = $pos.marks();
      if (marks.some((m) => m.type === markType)) {
        // Scan forward / backward for the end of the Mark coverage.
        let start = from;
        let end = from;
        while (start > 0) {
          const $p = state.doc.resolve(start - 1);
          if (!$p.marks().some((m) => m.type === markType)) break;
          start--;
        }
        while (end < state.doc.content.size) {
          const $p = state.doc.resolve(end + 1);
          if (!$p.marks().some((m) => m.type === markType)) break;
          end++;
        }
        rangeFrom = start;
        rangeTo = end;
      }
    }
    if (rangeTo > rangeFrom) {
      tr.removeMark(rangeFrom, rangeTo, markType);
    }
  }

  // Block attr removal — for each enclosing block inside the selection
  // (or containing the cursor), wipe `lintDisabled`.
  state.doc.nodesBetween(from, to, (node, pos) => {
    if (!DISABLE_BLOCK_KINDS.has(node.type.name)) return true;
    if (!sanitiseRules(node.attrs.lintDisabled)) return true;
    tr.setNodeMarkup(
      pos,
      undefined,
      { ...node.attrs, lintDisabled: null },
      node.marks,
    );
    return true;
  });

  editor.view.dispatch(tr);
}
