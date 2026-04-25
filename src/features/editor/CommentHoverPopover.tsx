import { useEffect, useRef, useState, useCallback } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/react";
import { useCursorSettingsStore } from "./cursorSettingsStore";
import { COMMENT_REBUILD_META } from "./CommentDecorationPlugin";

interface CommentTarget {
  text: string;
  from: number;
  to: number;
  x: number;
  y: number;
}

interface Props {
  editor: Editor | null;
  containerRef: React.RefObject<HTMLElement | null>;
}

/**
 * A-2: Hover popover that shows the comment body when the user mouses
 * over a `.comment-deco` span. Provides Edit and Delete actions.
 */
export function CommentHoverPopover({ editor, containerRef }: Props) {
  const showComments = useCursorSettingsStore((s) => s.showComments);
  const setCommentPickerOpen = useCursorSettingsStore(
    (s) => s.setCommentPickerOpen,
  );
  const [target, setTarget] = useState<CommentTarget | null>(null);
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState("");
  const popoverRef = useRef<HTMLDivElement>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearHideTimer = useCallback(() => {
    if (hideTimer.current !== null) {
      clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
  }, []);

  const scheduleHide = useCallback(() => {
    clearHideTimer();
    hideTimer.current = setTimeout(() => {
      setTarget(null);
      setEditing(false);
    }, 200);
  }, [clearHideTimer]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !showComments) return;

    function onMouseOver(e: MouseEvent) {
      const el = (e.target as Element).closest(
        "[data-comment-text]",
      ) as HTMLElement | null;
      if (!el) {
        scheduleHide();
        return;
      }
      clearHideTimer();
      const text = el.getAttribute("data-comment-text") ?? "";
      const from = parseInt(el.getAttribute("data-comment-from") ?? "0", 10);
      const to = parseInt(el.getAttribute("data-comment-to") ?? "0", 10);
      const rect = el.getBoundingClientRect();
      setTarget({ text, from, to, x: rect.left, y: rect.bottom + 6 });
      setEditing(false);
      setEditText(text);
    }

    container.addEventListener("mouseover", onMouseOver);
    return () => container.removeEventListener("mouseover", onMouseOver);
  }, [containerRef, showComments, scheduleHide, clearHideTimer]);

  // Hide on showComments toggle off
  useEffect(() => {
    if (!showComments) {
      setTarget(null);
      setEditing(false);
    }
  }, [showComments]);

  const handleDelete = useCallback(() => {
    if (!editor || !target) return;
    editor
      .chain()
      .setTextSelection({ from: target.from, to: target.to })
      .unsetMark("comment")
      .command(({ tr }) => {
        tr.setMeta(COMMENT_REBUILD_META, true);
        return true;
      })
      .run();
    setTarget(null);
  }, [editor, target]);

  const handleEditConfirm = useCallback(() => {
    if (!editor || !target) return;
    editor
      .chain()
      .setTextSelection({ from: target.from, to: target.to })
      .setMark("comment", {
        text: editText.trim(),
        createdAt: new Date().toISOString(),
      })
      .command(({ tr }) => {
        tr.setMeta(COMMENT_REBUILD_META, true);
        return true;
      })
      .run();
    setEditing(false);
    setTarget((prev) => (prev ? { ...prev, text: editText.trim() } : null));
  }, [editor, target, editText]);

  if (!target) return null;

  const menuWidth = 260;
  const x = Math.min(target.x, window.innerWidth - menuWidth - 8);
  const y = Math.min(target.y, window.innerHeight - 120);

  return createPortal(
    <div
      ref={popoverRef}
      className="fixed z-50 rounded-md border border-border bg-popover shadow-md"
      style={{ left: x, top: y, minWidth: menuWidth, maxWidth: menuWidth }}
      onMouseEnter={clearHideTimer}
      onMouseLeave={scheduleHide}
    >
      {editing ? (
        <div className="flex flex-col gap-2 p-3">
          <input
            autoFocus
            type="text"
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                handleEditConfirm();
              }
              if (e.key === "Escape") setEditing(false);
            }}
            className="w-full rounded border border-border bg-background px-2 py-1 text-sm outline-none"
          />
          <div className="flex gap-2">
            <button
              type="button"
              className="flex-1 rounded bg-primary px-2 py-1 text-xs text-primary-foreground hover:opacity-90"
              onClick={handleEditConfirm}
            >
              保存
            </button>
            <button
              type="button"
              className="flex-1 rounded border border-border px-2 py-1 text-xs hover:bg-accent"
              onClick={() => setEditing(false)}
            >
              キャンセル
            </button>
          </div>
        </div>
      ) : (
        <div className="p-3">
          <p className="mb-2 text-sm leading-snug text-popover-foreground">
            {target.text || (
              <span className="text-muted-foreground italic">
                （コメントなし）
              </span>
            )}
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              className="rounded border border-border px-2 py-1 text-xs hover:bg-accent"
              onClick={() => {
                setEditing(true);
                setEditText(target.text);
              }}
            >
              編集
            </button>
            <button
              type="button"
              className="rounded border border-border px-2 py-1 text-xs text-destructive hover:bg-destructive/10"
              onClick={handleDelete}
            >
              削除
            </button>
            <button
              type="button"
              className="rounded border border-border px-2 py-1 text-xs hover:bg-accent"
              onClick={() => {
                setTarget(null);
                setCommentPickerOpen(true);
              }}
            >
              置換
            </button>
          </div>
        </div>
      )}
    </div>,
    document.body,
  );
}
