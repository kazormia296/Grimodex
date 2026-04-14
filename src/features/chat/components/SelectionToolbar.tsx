import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { FileInput, BookOpen, Bookmark, Copy } from "lucide-react";
import type { SelectionInfo } from "@/features/chat/hooks/useTextSelection";

interface SelectionToolbarProps {
  selectionInfo: SelectionInfo;
  messageId: string;
  onInsertSelection: (text: string, messageId: string) => void;
  onExtractCodex: (messageId: string, selectedText: string) => void;
  onSaveSnippet: (messageId: string, selectedText: string) => void;
  onCopy: (text: string) => void;
}

const TOOLBAR_HEIGHT = 32;
const TOOLBAR_WIDTH = 200;
const OFFSET_ABOVE = 8;
const OFFSET_BELOW = 8;

export function SelectionToolbar({
  selectionInfo,
  messageId,
  onInsertSelection,
  onExtractCodex,
  onSaveSnippet,
  onCopy,
}: SelectionToolbarProps) {
  const { t } = useTranslation();
  const { text, rect } = selectionInfo;

  const vpWidth = window.innerWidth;
  const vpHeight = window.innerHeight;

  // Prefer placing toolbar above the selection
  let top = rect.top - TOOLBAR_HEIGHT - OFFSET_ABOVE;
  if (top < 0) {
    // Not enough space above — place below
    top = rect.bottom + OFFSET_BELOW;
  }
  // Clamp to viewport vertically
  top = Math.max(4, Math.min(top, vpHeight - TOOLBAR_HEIGHT - 4));

  // Center horizontally over selection, then clamp
  let left = rect.left + rect.width / 2 - TOOLBAR_WIDTH / 2;
  left = Math.max(4, Math.min(left, vpWidth - TOOLBAR_WIDTH - 4));

  return createPortal(
    <div
      data-testid="selection-toolbar"
      style={{
        position: "fixed",
        top,
        left,
        zIndex: 9999,
      }}
      // Prevent mousedown from clearing the selection
      onMouseDown={(e) => e.preventDefault()}
      className="flex items-center gap-0.5 rounded border border-border bg-popover px-1 py-0.5 shadow-md"
    >
      <button
        type="button"
        title={t("chat.selectionToolbar.insertToEditor")}
        onClick={() => onInsertSelection(text, messageId)}
        className="flex items-center gap-1 rounded border border-border px-2 py-1 text-xs text-popover-foreground hover:bg-accent hover:text-accent-foreground"
      >
        <FileInput className="h-3 w-3" />
        Insert
      </button>
      <button
        type="button"
        title={t("chat.selectionToolbar.extractToCodex")}
        onClick={() => onExtractCodex(messageId, text)}
        className="flex items-center gap-1 rounded border border-border px-2 py-1 text-xs text-popover-foreground hover:bg-accent hover:text-accent-foreground"
      >
        <BookOpen className="h-3 w-3" />
        Codex
      </button>
      <button
        type="button"
        title={t("chat.selectionToolbar.saveAsSnippet")}
        onClick={() => onSaveSnippet(messageId, text)}
        className="flex items-center gap-1 rounded border border-border px-2 py-1 text-xs text-popover-foreground hover:bg-accent hover:text-accent-foreground"
      >
        <Bookmark className="h-3 w-3" />
        Snippet
      </button>
      <button
        type="button"
        title={t("chat.selectionToolbar.copy")}
        onClick={() => onCopy(text)}
        className="flex items-center gap-1 rounded border border-border px-2 py-1 text-xs text-popover-foreground hover:bg-accent hover:text-accent-foreground"
      >
        <Copy className="h-3 w-3" />
        Copy
      </button>
    </div>,
    document.body,
  );
}
