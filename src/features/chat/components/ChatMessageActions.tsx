import { useState, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import {
  MoreVertical,
  FileInput,
  BookOpen,
  Bookmark,
  Copy,
  Pencil,
  Trash2,
  RefreshCw,
  Star,
} from "lucide-react";

interface ChatMessageActionsProps {
  messageId: string;
  messageRole: "user" | "assistant";
  isStarred?: boolean;
  onInsert?: () => void;
  onInsertHover?: (hovering: boolean) => void;
  onExtractCodexQuick?: (messageId: string) => void;
  onExtractCodexDetailed?: (
    messageId: string,
    selectedText: string | null,
  ) => void;
  onSaveSnippetQuick?: (messageId: string) => void;
  onSaveSnippetDetailed?: (
    messageId: string,
    selectedText: string | null,
  ) => void;
  onCopy?: () => void;
  onEdit?: (messageId: string) => void;
  onDelete?: (messageId: string) => void;
  onRegenerate?: (messageId: string) => void;
  onStar?: (messageId: string, starred: boolean) => void;
}

export function ChatMessageActions({
  messageId,
  messageRole,
  isStarred,
  onInsert,
  onInsertHover,
  onExtractCodexQuick,
  onExtractCodexDetailed,
  onSaveSnippetQuick,
  onSaveSnippetDetailed,
  onCopy,
  onEdit,
  onDelete,
  onRegenerate,
  onStar,
}: ChatMessageActionsProps) {
  const { t } = useTranslation();
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

  const handleExtractCodexDetailed = () => {
    setOpen(false);
    onExtractCodexDetailed?.(messageId, getSelectedText());
  };

  const handleSaveSnippetDetailed = () => {
    setOpen(false);
    onSaveSnippetDetailed?.(messageId, getSelectedText());
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

  const hasDropdownItems =
    messageRole === "assistant"
      ? onExtractCodexDetailed ||
        onSaveSnippetDetailed ||
        onRegenerate ||
        onDelete
      : onEdit || onDelete;

  return (
    <div
      className="relative mt-2 flex items-center gap-1"
      ref={menuRef}
      data-testid={`message-actions-wrapper-${messageId}`}
    >
      {/* スターボタン（全ロール共通） */}
      {onStar && (
        <button
          type="button"
          data-testid={`star-message-${messageId}`}
          onClick={() => onStar(messageId, !isStarred)}
          title={isStarred ? t("chat.actions.unstar") : t("chat.actions.star")}
          className={`inline-flex items-center gap-1 rounded border px-1.5 py-1 text-xs transition-colors ${
            isStarred
              ? "border-amber-400 bg-amber-50 text-amber-500 hover:bg-amber-100 dark:bg-amber-900/20 dark:hover:bg-amber-800/30"
              : "border-border text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          }`}
        >
          <Star className={`h-3 w-3 ${isStarred ? "fill-amber-400" : ""}`} />
        </button>
      )}

      {/* アシスタント専用インラインボタン */}
      {messageRole === "assistant" && (
        <>
          {onInsert && (
            <button
              type="button"
              data-testid={`insert-to-editor-${messageId}`}
              onClick={() => onInsert()}
              onMouseEnter={() => onInsertHover?.(true)}
              onMouseLeave={() => onInsertHover?.(false)}
              title={t("chat.actions.insertToEditor")}
              className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            >
              <FileInput className="h-3 w-3" />
              <span>Insert</span>
            </button>
          )}
          {onExtractCodexQuick && (
            <button
              type="button"
              data-testid={`extract-codex-quick-${messageId}`}
              onClick={() => onExtractCodexQuick(messageId)}
              title={t("chat.actions.extractCodexQuick")}
              className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            >
              <BookOpen className="h-3 w-3" />
              <span>Codex</span>
            </button>
          )}
          {onSaveSnippetQuick && (
            <button
              type="button"
              data-testid={`save-snippet-quick-${messageId}`}
              onClick={() => onSaveSnippetQuick(messageId)}
              title={t("chat.actions.saveSnippetQuick")}
              className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            >
              <Bookmark className="h-3 w-3" />
              <span>Snippet</span>
            </button>
          )}
          {onCopy && (
            <button
              type="button"
              data-testid={`copy-message-${messageId}`}
              onClick={onCopy}
              title={t("chat.actions.copyWithAttribution")}
              className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            >
              <Copy className="h-3 w-3" />
              <span>Copy</span>
            </button>
          )}
        </>
      )}

      {/* ⋮ ドロップダウン */}
      {hasDropdownItems && (
        <div className="relative">
          <button
            type="button"
            data-testid={`message-actions-${messageId}`}
            onClick={() => setOpen((v) => !v)}
            className="inline-flex items-center rounded border border-border px-1.5 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          >
            <MoreVertical className="h-3 w-3" />
          </button>

          {open && (
            <div
              data-testid={`message-actions-menu-${messageId}`}
              className="absolute bottom-full right-0 z-10 mb-1 min-w-[180px] rounded-md border border-border bg-popover py-1 shadow-md"
            >
              {messageRole === "assistant" && (
                <>
                  {onExtractCodexDetailed && (
                    <button
                      type="button"
                      data-testid={`extract-codex-detailed-${messageId}`}
                      onClick={handleExtractCodexDetailed}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-popover-foreground hover:bg-accent"
                    >
                      <BookOpen className="h-3 w-3" />
                      {t("chat.actions.extractCodexDetailed")}
                    </button>
                  )}
                  {onSaveSnippetDetailed && (
                    <button
                      type="button"
                      data-testid={`save-snippet-detailed-${messageId}`}
                      onClick={handleSaveSnippetDetailed}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-popover-foreground hover:bg-accent"
                    >
                      <Bookmark className="h-3 w-3" />
                      {t("chat.actions.saveSnippetDetailed")}
                    </button>
                  )}
                  {onRegenerate && (
                    <button
                      type="button"
                      data-testid={`regenerate-${messageId}`}
                      onClick={handleRegenerate}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-popover-foreground hover:bg-accent"
                    >
                      <RefreshCw className="h-3 w-3" />
                      {t("chat.actions.regenerate")}
                    </button>
                  )}
                  {onDelete &&
                    (onExtractCodexDetailed ||
                      onSaveSnippetDetailed ||
                      onRegenerate) && (
                      <div className="my-0.5 border-t border-border" />
                    )}
                </>
              )}

              {messageRole === "user" && onEdit && (
                <button
                  type="button"
                  data-testid={`edit-message-${messageId}`}
                  onClick={handleEdit}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-popover-foreground hover:bg-accent"
                >
                  <Pencil className="h-3 w-3" />
                  {t("chat.actions.edit")}
                </button>
              )}
              {messageRole === "user" && onDelete && onEdit && (
                <div className="my-0.5 border-t border-border" />
              )}

              {onDelete && (
                <button
                  type="button"
                  data-testid={`delete-message-${messageId}`}
                  onClick={handleDelete}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-destructive hover:bg-accent"
                >
                  <Trash2 className="h-3 w-3" />
                  {t("chat.actions.delete")}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
