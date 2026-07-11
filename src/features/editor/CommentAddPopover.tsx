import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { Editor } from "@tiptap/react";
import { useCursorSettingsStore } from "./cursorSettingsStore";
import { COMMENT_REBUILD_META } from "./CommentDecorationPlugin";

interface Props {
  editor: Editor | null;
}

/**
 * A-2: Floating input for adding an inline CommentMark to the current
 * selection. Opened via Ctrl+Shift+M or the editor context menu.
 * Positioned just below the selection end.
 */
export function CommentAddPopover({ editor }: Props) {
  const { t } = useTranslation();
  const open = useCursorSettingsStore((s) => s.commentPickerOpen);
  const setOpen = useCursorSettingsStore((s) => s.setCommentPickerOpen);
  const [text, setText] = useState("");
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // When opened, calculate position from selection end and capture selection.
  useEffect(() => {
    if (!open || !editor) {
      setText("");
      setPos(null);
      return;
    }

    const { from, to } = editor.state.selection;
    if (from === to) {
      setOpen(false);
      return;
    }

    const coords = editor.view.coordsAtPos(to);
    setPos({ x: coords.left, y: coords.bottom + 6 });
    setText("");
    setTimeout(() => inputRef.current?.focus(), 0);
  }, [open, editor, setOpen]);

  const close = useCallback(() => {
    setOpen(false);
    // ポップオーバーを開いた位置は既に画面内 — スクロールは動かさない
    // （既定の scrollIntoView:true は現在位置を変える可能性がある）。
    editor?.commands.focus(null, { scrollIntoView: false });
  }, [setOpen, editor]);

  const confirm = () => {
    if (!editor || !text.trim()) {
      close();
      return;
    }

    const { from, to } = editor.state.selection;
    editor
      .chain()
      .setTextSelection({ from, to })
      .setMark("comment", {
        text: text.trim(),
        createdAt: new Date().toISOString(),
      })
      .command(({ tr }) => {
        tr.setMeta(COMMENT_REBUILD_META, true);
        return true;
      })
      .run();

    // Ensure comments are visible after adding one
    if (!useCursorSettingsStore.getState().showComments) {
      useCursorSettingsStore.getState().toggleShowComments();
      editor.view.dispatch(editor.state.tr.setMeta(COMMENT_REBUILD_META, true));
    }

    close();
  };

  // ESC or outside click closes
  useEffect(() => {
    if (!open) return;

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    function onMouseDown(e: MouseEvent) {
      const target = e.target as Node;
      if (
        inputRef.current &&
        !inputRef.current.closest("[data-comment-popover]")?.contains(target)
      ) {
        close();
      }
    }
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onMouseDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onMouseDown);
    };
  }, [open, close]);

  if (!open || !pos) return null;

  // Clamp to viewport
  const menuWidth = 280;
  const x = Math.min(pos.x, window.innerWidth - menuWidth - 8);
  const y = Math.min(pos.y, window.innerHeight - 80);

  return createPortal(
    <div
      data-comment-popover="add"
      className="fixed z-50 flex items-center gap-2 rounded-md border border-border bg-popover px-3 py-2 shadow-md"
      style={{ left: x, top: y, minWidth: menuWidth }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <input
        ref={inputRef}
        type="text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            confirm();
          }
        }}
        placeholder={t("editor.comment.inputPlaceholder")}
        className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
      />
      <button
        type="button"
        className="shrink-0 rounded px-2 py-0.5 text-xs bg-primary text-primary-foreground hover:opacity-90"
        onClick={confirm}
      >
        {t("codex.relation.add")}
      </button>
    </div>,
    document.body,
  );
}
