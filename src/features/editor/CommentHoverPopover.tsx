import { useEffect, useRef, useState, useCallback } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { Editor } from "@tiptap/react";
import type { EditorEvents } from "@tiptap/core";
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
  const { t } = useTranslation();
  const showComments = useCursorSettingsStore((s) => s.showComments);
  const [target, setTarget] = useState<CommentTarget | null>(null);
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState("");
  const popoverRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Escape で閉じた範囲は caret が離れるまで再表示しない
  const suppressedRangeRef = useRef<string | null>(null);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

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

  const showFromElement = useCallback(
    (el: HTMLElement) => {
      clearHideTimer();
      const text = el.getAttribute("data-comment-text") ?? "";
      const from = parseInt(el.getAttribute("data-comment-from") ?? "0", 10);
      const to = parseInt(el.getAttribute("data-comment-to") ?? "0", 10);
      const rect = el.getBoundingClientRect();
      setTarget({ text, from, to, x: rect.left, y: rect.bottom + 6 });
      setEditing(false);
      setEditText(text);
    },
    [clearHideTimer],
  );

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
      showFromElement(el);
    }

    container.addEventListener("mouseover", onMouseOver);
    return () => container.removeEventListener("mouseover", onMouseOver);
  }, [containerRef, showComments, scheduleHide, showFromElement]);

  // キーボードユーザー向け: caret がコメント装飾内に入ったら popover を表示
  useEffect(() => {
    if (!editor) return;
    // テスト用モック editor など emitter を持たない実装では購読しない
    if (typeof editor.on !== "function" || typeof editor.off !== "function") {
      return;
    }
    const onSelectionUpdate = ({
      editor: ed,
      transaction,
    }: EditorEvents["selectionUpdate"]) => {
      // 入力・IME 由来の selection 変化では反応しない（執筆の妨害防止）
      if (transaction.docChanged || ed.view.composing) return;
      let el: HTMLElement | null = null;
      const { selection } = ed.state;
      if (selection.empty) {
        try {
          const { node } = ed.view.domAtPos(selection.from);
          const base = node instanceof Element ? node : node.parentElement;
          el =
            (base?.closest?.("[data-comment-text]") as HTMLElement | null) ??
            null;
        } catch {
          el = null;
        }
      }
      if (!el) {
        suppressedRangeRef.current = null;
        scheduleHide();
        return;
      }
      const key = `${el.getAttribute("data-comment-from")}:${el.getAttribute("data-comment-to")}`;
      if (suppressedRangeRef.current === key) return;
      suppressedRangeRef.current = null;
      showFromElement(el);
    };
    editor.on("selectionUpdate", onSelectionUpdate);
    return () => {
      editor.off("selectionUpdate", onSelectionUpdate);
    };
  }, [editor, scheduleHide, showFromElement]);

  // Escape で閉じる（編集中は input 側の Escape が編集のみ取り消す）
  useEffect(() => {
    if (!target || editing) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.isComposing) return;
      // 最上層のこのポップオーバーだけを閉じ、下層の Escape 動作へ波及させない
      e.stopPropagation();
      suppressedRangeRef.current = `${target.from}:${target.to}`;
      clearHideTimer();
      setTarget(null);
      setEditing(false);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [target, editing, clearHideTimer]);

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
      role="dialog"
      aria-label={t("editor.comment.popoverLabel")}
      className="fixed z-50 rounded-md border border-border bg-popover shadow-md"
      style={{ left: x, top: y, minWidth: menuWidth, maxWidth: menuWidth }}
      onMouseEnter={clearHideTimer}
      onMouseLeave={scheduleHide}
    >
      {editing ? (
        <div className="flex flex-col gap-2 p-3">
          <input
            ref={inputRef}
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
              {t("common.save")}
            </button>
            <button
              type="button"
              className="flex-1 rounded border border-border px-2 py-1 text-xs hover:bg-accent"
              onClick={() => setEditing(false)}
            >
              {t("common.cancel")}
            </button>
          </div>
        </div>
      ) : (
        <div className="p-3">
          <p className="mb-2 text-sm leading-snug text-popover-foreground">
            {target.text || (
              <span className="text-muted-foreground italic">
                {t("editor.comment.empty")}
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
              {t("common.edit")}
            </button>
            <button
              type="button"
              className="rounded border border-border px-2 py-1 text-xs text-destructive hover:bg-destructive/10"
              onClick={handleDelete}
            >
              {t("common.delete")}
            </button>
          </div>
        </div>
      )}
    </div>,
    document.body,
  );
}
