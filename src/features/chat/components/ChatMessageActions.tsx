import { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
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
  ScrollText,
} from "lucide-react";

interface ChatMessageActionsProps {
  messageId: string;
  messageRole: "user" | "assistant";
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
  /** 送信時に保存した system プロンプトのスナップショットを表示する。 */
  onViewPrompt?: (messageId: string) => void;
}

export function ChatMessageActions({
  messageId,
  messageRole,
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
  onViewPrompt,
}: ChatMessageActionsProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const [menuPos, setMenuPos] = useState<{
    top?: number;
    bottom?: number;
    right: number;
  } | null>(null);

  // 仮想化リストの各行は transform で独立した stacking context を作るため、
  // 行内に absolute 配置したメニューは後続 DOM（入力エリア等）の下に潜って
  // しまう。z-index では行の stacking context を越えられないので、body へ
  // portal して fixed 配置することで重なり順の罠を回避する。
  const openMenu = () => {
    const el = triggerRef.current;
    if (el) {
      const r = el.getBoundingClientRect();
      const right = Math.max(8, window.innerWidth - r.right);
      // 上に十分な余白があれば上方向、なければ下方向に開く。
      setMenuPos(
        r.top > 220
          ? { bottom: window.innerHeight - r.top + 4, right }
          : { top: r.bottom + 4, right },
      );
    }
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (popupRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    // fixed 配置はスクロール / リサイズで追従しないため、その間は閉じる。
    const close = () => setOpen(false);
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
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

  const handleViewPrompt = () => {
    setOpen(false);
    onViewPrompt?.(messageId);
  };

  const hasDropdownItems =
    messageRole === "assistant"
      ? onExtractCodexDetailed ||
        onSaveSnippetDetailed ||
        onRegenerate ||
        onDelete
      : onViewPrompt || onEdit || onDelete;

  return (
    <div
      className="relative mt-2 flex items-center gap-1"
      data-testid={`message-actions-wrapper-${messageId}`}
    >
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
              <span>{t("chat.actions.insertLabel")}</span>
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
              <span>{t("chat.actions.codexLabel")}</span>
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
              <span>{t("chat.actions.snippetLabel")}</span>
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
              <span>{t("chat.actions.copyLabel")}</span>
            </button>
          )}
        </>
      )}

      {/* ⋮ ドロップダウン */}
      {hasDropdownItems && (
        <div className="relative">
          <button
            type="button"
            ref={triggerRef}
            data-testid={`message-actions-${messageId}`}
            onClick={() => (open ? setOpen(false) : openMenu())}
            className="inline-flex items-center rounded border border-border px-1.5 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          >
            <MoreVertical className="h-3 w-3" />
          </button>

          {open &&
            menuPos &&
            createPortal(
              <div
                ref={popupRef}
                data-testid={`message-actions-menu-${messageId}`}
                className="fixed z-50 min-w-[180px] rounded-md border border-border bg-popover py-1 shadow-md"
                style={{
                  top: menuPos.top,
                  bottom: menuPos.bottom,
                  right: menuPos.right,
                }}
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

                {messageRole === "user" && onViewPrompt && (
                  <button
                    type="button"
                    data-testid={`view-prompt-${messageId}`}
                    onClick={handleViewPrompt}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-popover-foreground hover:bg-accent"
                  >
                    <ScrollText className="h-3 w-3" />
                    {t("chat.actions.viewPrompt")}
                  </button>
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
                {messageRole === "user" &&
                  onDelete &&
                  (onEdit || onViewPrompt) && (
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
              </div>,
              document.body,
            )}
        </div>
      )}
    </div>
  );
}
