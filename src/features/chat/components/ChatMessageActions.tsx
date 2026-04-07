import { useState, useRef, useEffect } from "react";
import {
  MoreVertical,
  FileInput,
  BookOpen,
  Bookmark,
  Pencil,
  Trash2,
  RefreshCw,
} from "lucide-react";

interface ChatMessageActionsProps {
  messageId: string;
  messageRole: "user" | "assistant";
  onInsert?: () => void;
  onExtractCodex?: (messageId: string, selectedText: string | null) => void;
  onSaveSnippet?: (messageId: string, selectedText: string | null) => void;
  onEdit?: (messageId: string) => void;
  onDelete?: (messageId: string) => void;
  onRegenerate?: (messageId: string) => void;
}

export function ChatMessageActions({
  messageId,
  messageRole,
  onInsert,
  onExtractCodex,
  onSaveSnippet,
  onEdit,
  onDelete,
  onRegenerate,
}: ChatMessageActionsProps) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  const getSelectedText = (): string | null => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return null;
    const text = sel.toString().trim();
    return text.length > 0 ? text : null;
  };

  const handleExtractCodex = () => {
    setOpen(false);
    onExtractCodex?.(messageId, getSelectedText());
  };

  const handleSaveSnippet = () => {
    setOpen(false);
    onSaveSnippet?.(messageId, getSelectedText());
  };

  const handleInsert = () => {
    setOpen(false);
    onInsert?.();
  };

  const handleEdit = () => {
    setOpen(false);
    onEdit?.(messageId);
  };

  const handleDelete = () => {
    setOpen(false);
    onDelete?.(messageId);
  };

  const handleRegenerate = () => {
    setOpen(false);
    onRegenerate?.(messageId);
  };

  return (
    <div className="relative mt-2 inline-flex" ref={menuRef}>
      <button
        type="button"
        data-testid={`message-actions-${messageId}`}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground"
      >
        <MoreVertical className="h-3 w-3" />
      </button>

      {open && (
        <div
          data-testid={`message-actions-menu-${messageId}`}
          className="absolute bottom-full left-0 z-10 mb-1 min-w-[160px] rounded-md border border-border bg-popover py-1 shadow-md"
        >
          {/* アシスタントメッセージ専用 */}
          {messageRole === "assistant" && onInsert && (
            <button
              type="button"
              data-testid={`insert-to-editor-${messageId}`}
              onClick={handleInsert}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-popover-foreground hover:bg-accent"
            >
              <FileInput className="h-3 w-3" />
              エディタに挿入
            </button>
          )}
          {messageRole === "assistant" && onExtractCodex && (
            <button
              type="button"
              data-testid={`extract-codex-${messageId}`}
              onClick={handleExtractCodex}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-popover-foreground hover:bg-accent"
            >
              <BookOpen className="h-3 w-3" />
              Codexに抽出
            </button>
          )}
          {messageRole === "assistant" && onSaveSnippet && (
            <button
              type="button"
              data-testid={`save-snippet-${messageId}`}
              onClick={handleSaveSnippet}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-popover-foreground hover:bg-accent"
            >
              <Bookmark className="h-3 w-3" />
              Snippetとして保存
            </button>
          )}
          {messageRole === "assistant" && onRegenerate && (
            <button
              type="button"
              data-testid={`regenerate-${messageId}`}
              onClick={handleRegenerate}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-popover-foreground hover:bg-accent"
            >
              <RefreshCw className="h-3 w-3" />
              再生成
            </button>
          )}

          {/* ユーザーメッセージ専用 */}
          {messageRole === "user" && onEdit && (
            <button
              type="button"
              data-testid={`edit-message-${messageId}`}
              onClick={handleEdit}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-popover-foreground hover:bg-accent"
            >
              <Pencil className="h-3 w-3" />
              編集
            </button>
          )}

          {/* 共通: 削除 */}
          {onDelete && (
            <>
              {(messageRole === "assistant"
                ? onInsert || onRegenerate
                : onEdit) && <div className="my-0.5 border-t border-border" />}
              <button
                type="button"
                data-testid={`delete-message-${messageId}`}
                onClick={handleDelete}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-destructive hover:bg-accent"
              >
                <Trash2 className="h-3 w-3" />
                削除
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
