import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import {
  FileInput,
  BookOpen,
  Bookmark,
  Copy,
  Pencil,
  Trash2,
  RefreshCw,
} from "lucide-react";

interface ChatMessageContextMenuProps {
  messageId: string;
  messageRole: "user" | "assistant";
  messageContent: string;
  selectedText: string | null;
  x: number;
  y: number;
  onClose: () => void;
  onInsert: (content: string, messageId: string) => void;
  onExtractCodexQuick: (messageId: string) => void;
  onExtractCodexDetailed: (
    messageId: string,
    selectedText: string | null,
  ) => void;
  onSaveSnippetQuick: (messageId: string) => void;
  onSaveSnippetDetailed: (
    messageId: string,
    selectedText: string | null,
  ) => void;
  onCopy: (text: string, messageId: string) => void;
  onEdit: (messageId: string) => void;
  onDelete: (messageId: string) => void;
  onRegenerate: (messageId: string) => void;
}

export function ChatMessageContextMenu({
  messageId,
  messageRole,
  messageContent,
  selectedText,
  x,
  y,
  onClose,
  onInsert,
  onExtractCodexQuick,
  onExtractCodexDetailed,
  onSaveSnippetQuick,
  onSaveSnippetDetailed,
  onCopy,
  onEdit,
  onDelete,
  onRegenerate,
}: ChatMessageContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  // Close on pointer down outside or Escape key
  useEffect(() => {
    const handlePointerDown = (e: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  // Viewport clamping
  const estimatedHeight =
    selectedText != null ? 160 : messageRole === "assistant" ? 290 : 120;
  const clampedX = Math.min(x, window.innerWidth - 220);
  const clampedY = Math.min(y, window.innerHeight - estimatedHeight);

  const handleInsert = (content: string) => {
    onInsert(content, messageId);
    onClose();
  };

  const handleExtractCodexQuick = () => {
    onExtractCodexQuick(messageId);
    onClose();
  };

  const handleExtractCodexDetailed = () => {
    onExtractCodexDetailed(messageId, selectedText);
    onClose();
  };

  const handleSaveSnippetQuick = () => {
    onSaveSnippetQuick(messageId);
    onClose();
  };

  const handleSaveSnippetDetailed = () => {
    onSaveSnippetDetailed(messageId, selectedText);
    onClose();
  };

  const handleCopy = () => {
    const text = selectedText ?? messageContent;
    onCopy(text, messageId);
    onClose();
  };

  const handleEdit = () => {
    onEdit(messageId);
    onClose();
  };

  const handleDelete = () => {
    onDelete(messageId);
    onClose();
  };

  const handleRegenerate = () => {
    onRegenerate(messageId);
    onClose();
  };

  const menuItem = (
    testId: string,
    icon: React.ReactNode,
    label: string,
    onClick: () => void,
    destructive = false,
  ) => (
    <button
      key={testId}
      type="button"
      data-testid={testId}
      onClick={onClick}
      className={`flex w-full items-center gap-2 px-3 py-1.5 text-xs hover:bg-accent ${
        destructive ? "text-destructive" : "text-popover-foreground"
      }`}
    >
      {icon}
      {label}
    </button>
  );

  const separator = (key: string) => (
    <div key={key} className="my-0.5 border-t border-border" />
  );

  return createPortal(
    <div
      ref={menuRef}
      data-testid="chat-message-context-menu"
      className="fixed z-50 min-w-[200px] rounded-md border border-border bg-popover py-1 shadow-md"
      style={{ left: clampedX, top: clampedY }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {selectedText != null ? (
        // テキスト選択モード: 4項目
        <>
          {menuItem(
            "ctx-insert-selection",
            <FileInput className="h-3 w-3" />,
            "選択テキストをエディタに挿入",
            () => handleInsert(selectedText),
          )}
          {menuItem(
            "ctx-extract-codex-selection",
            <BookOpen className="h-3 w-3" />,
            "Codexに抽出",
            handleExtractCodexDetailed,
          )}
          {menuItem(
            "ctx-save-snippet-selection",
            <Bookmark className="h-3 w-3" />,
            "Snippetとして保存",
            handleSaveSnippetDetailed,
          )}
          {menuItem(
            "ctx-copy",
            <Copy className="h-3 w-3" />,
            "コピー",
            handleCopy,
          )}
        </>
      ) : messageRole === "assistant" ? (
        // アシスタントメッセージ（選択なし）: 8項目
        <>
          {menuItem(
            "ctx-insert",
            <FileInput className="h-3 w-3" />,
            "エディタに挿入",
            () => handleInsert(messageContent),
          )}
          {menuItem(
            "ctx-extract-codex-quick",
            <BookOpen className="h-3 w-3" />,
            "Codex即時抽出",
            handleExtractCodexQuick,
          )}
          {menuItem(
            "ctx-extract-codex-detailed",
            <BookOpen className="h-3 w-3" />,
            "Codex詳細抽出",
            handleExtractCodexDetailed,
          )}
          {menuItem(
            "ctx-save-snippet-quick",
            <Bookmark className="h-3 w-3" />,
            "Snippet即時保存",
            handleSaveSnippetQuick,
          )}
          {menuItem(
            "ctx-save-snippet-detailed",
            <Bookmark className="h-3 w-3" />,
            "Snippet詳細保存",
            handleSaveSnippetDetailed,
          )}
          {menuItem(
            "ctx-copy",
            <Copy className="h-3 w-3" />,
            "コピー",
            handleCopy,
          )}
          {menuItem(
            "ctx-regenerate",
            <RefreshCw className="h-3 w-3" />,
            "再生成",
            handleRegenerate,
          )}
          {separator("sep-delete")}
          {menuItem(
            "ctx-delete",
            <Trash2 className="h-3 w-3" />,
            "削除",
            handleDelete,
            true,
          )}
        </>
      ) : (
        // ユーザーメッセージ（選択なし）: 3項目
        <>
          {menuItem(
            "ctx-edit",
            <Pencil className="h-3 w-3" />,
            "編集",
            handleEdit,
          )}
          {menuItem(
            "ctx-copy",
            <Copy className="h-3 w-3" />,
            "コピー",
            handleCopy,
          )}
          {separator("sep-delete")}
          {menuItem(
            "ctx-delete",
            <Trash2 className="h-3 w-3" />,
            "削除",
            handleDelete,
            true,
          )}
        </>
      )}
    </div>,
    document.body,
  );
}
