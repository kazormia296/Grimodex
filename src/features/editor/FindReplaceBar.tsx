import { useState, useEffect, useRef } from "react";
import type { Editor } from "@tiptap/react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { FindReplaceStorage } from "./FindReplaceExtension";

interface FindReplaceBarProps {
  editor: Editor | null;
  open: boolean;
  showReplace: boolean;
  onClose: () => void;
}

/**
 * C-7: VS Code-style Find & Replace bar rendered above editor content.
 */
export function FindReplaceBar({ editor, open, showReplace, onClose }: FindReplaceBarProps) {
  const [query, setQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [useRegex, setUseRegex] = useState(false);
  const findInputRef = useRef<HTMLInputElement>(null);

  // Focus on open
  useEffect(() => {
    if (open) {
      setTimeout(() => findInputRef.current?.focus(), 0);
    }
  }, [open]);

  // Clear decorations on close
  useEffect(() => {
    if (!open && editor) {
      editor.commands.clearFind();
      setQuery("");
    }
  }, [open, editor]);

  // Update search when query or options change
  useEffect(() => {
    if (!editor || !open) return;
    editor.commands.setFindQuery(query);
  }, [query, editor, open]);

  useEffect(() => {
    if (!editor || !open) return;
    editor.commands.setFindOptions({ caseSensitive, useRegex });
  }, [caseSensitive, useRegex, editor, open]);

  if (!open || !editor) return null;

  const storage = editor.storage.findReplace as FindReplaceStorage;
  const matchCount = storage?.matches?.length ?? 0;
  const currentIdx = (storage?.currentIndex ?? 0) + 1;
  const regexError = storage?.regexError ?? false;

  const matchLabel = regexError
    ? "無効な正規表現"
    : matchCount === 0
      ? query ? "一致なし" : ""
      : `${currentIdx} / ${matchCount}`;

  function handleFindKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.shiftKey ? editor?.commands.findPrev() : editor?.commands.findNext();
    } else if (e.key === "Escape") {
      onClose();
    }
  }

  function handleReplaceKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") onClose();
  }

  return (
    <div className="flex-shrink-0 border-b border-border bg-background px-2 py-1.5 shadow-sm">
      {/* Find row */}
      <div className="flex items-center gap-1">
        <div className="relative flex items-center flex-1">
          <input
            ref={findInputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleFindKeyDown}
            placeholder="検索…"
            className={`w-full rounded border bg-background px-2 py-0.5 pr-20 text-xs focus:outline-none focus:ring-1 focus:ring-primary ${regexError ? "border-destructive text-destructive" : "border-border"}`}
          />
          <span className="absolute right-2 text-xs text-muted-foreground whitespace-nowrap">
            {matchLabel}
          </span>
        </div>

        {/* Options */}
        <button
          type="button"
          title="大文字/小文字区別"
          onClick={() => setCaseSensitive((v) => !v)}
          className={cn(
            "flex h-6 w-6 items-center justify-center rounded text-xs hover:bg-accent",
            caseSensitive && "bg-accent text-foreground",
          )}
        >
          Aa
        </button>
        <button
          type="button"
          title="正規表現"
          onClick={() => setUseRegex((v) => !v)}
          className={cn(
            "flex h-6 w-6 items-center justify-center rounded text-xs hover:bg-accent",
            useRegex && "bg-accent text-foreground",
          )}
        >
          .*
        </button>

        {/* Navigation */}
        <button
          type="button"
          title="前へ (Shift+Enter)"
          onClick={() => editor.commands.findPrev()}
          disabled={matchCount === 0}
          className="flex h-6 w-6 items-center justify-center rounded text-xs hover:bg-accent disabled:opacity-30"
        >
          ↑
        </button>
        <button
          type="button"
          title="次へ (Enter)"
          onClick={() => editor.commands.findNext()}
          disabled={matchCount === 0}
          className="flex h-6 w-6 items-center justify-center rounded text-xs hover:bg-accent disabled:opacity-30"
        >
          ↓
        </button>

        <button
          type="button"
          title="閉じる (Esc)"
          onClick={onClose}
          className="flex h-6 w-6 items-center justify-center rounded hover:bg-accent"
        >
          <X className="h-3 w-3" />
        </button>
      </div>

      {/* Replace row */}
      {showReplace && (
        <div className="mt-1 flex items-center gap-1">
          <input
            type="text"
            value={replacement}
            onChange={(e) => setReplacement(e.target.value)}
            onKeyDown={handleReplaceKeyDown}
            placeholder="置換…"
            className="flex-1 rounded border border-border bg-background px-2 py-0.5 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
          />
          <button
            type="button"
            title="置換"
            onClick={() => editor.commands.replaceOne(replacement)}
            disabled={matchCount === 0}
            className="rounded border border-border px-2 py-0.5 text-xs hover:bg-accent disabled:opacity-30"
          >
            置換
          </button>
          <button
            type="button"
            title="全て置換"
            onClick={() => editor.commands.replaceAll(replacement)}
            disabled={matchCount === 0}
            className="rounded border border-border px-2 py-0.5 text-xs hover:bg-accent disabled:opacity-30"
          >
            全置換
          </button>
        </div>
      )}
    </div>
  );
}
