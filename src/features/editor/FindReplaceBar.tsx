import { useState, useEffect, useRef, useReducer } from "react";
import type { Editor } from "@tiptap/react";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import type { FindReplaceStorage } from "./FindReplaceExtension";

function supportsFindReplace(editor: Editor): boolean {
  return typeof editor.commands.clearFind === "function";
}

interface FindReplaceBarProps {
  editor: Editor | null;
  open: boolean;
  showReplace: boolean;
  onClose: () => void;
}

/**
 * C-7: VS Code-style Find & Replace bar rendered above editor content.
 */
export function FindReplaceBar({
  editor,
  open,
  showReplace,
  onClose,
}: FindReplaceBarProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [useRegex, setUseRegex] = useState(false);
  const findInputRef = useRef<HTMLInputElement>(null);

  // editor.storage は React state ではないため、findNext/findPrev で currentIndex が
  // 進んでも再レンダリングされない。transaction を購読してマッチカウント表示を更新する。
  const [, bumpStorageRev] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    if (!editor || !open) return;
    const handler = () => bumpStorageRev();
    editor.on("transaction", handler);
    return () => {
      editor.off("transaction", handler);
    };
  }, [editor, open]);

  // Focus on open
  useEffect(() => {
    if (open) {
      setTimeout(() => findInputRef.current?.focus(), 0);
    }
  }, [open]);

  // Clear decorations on close
  useEffect(() => {
    if (!open && editor && supportsFindReplace(editor)) {
      editor.commands.clearFind();
      setQuery("");
    }
  }, [open, editor]);

  // Update search when query or options change
  useEffect(() => {
    if (!editor || !open || !supportsFindReplace(editor)) return;
    editor.commands.setFindQuery(query);
  }, [query, editor, open]);

  useEffect(() => {
    if (!editor || !open || !supportsFindReplace(editor)) return;
    editor.commands.setFindOptions({ caseSensitive, useRegex });
  }, [caseSensitive, useRegex, editor, open]);

  if (!open || !editor || !supportsFindReplace(editor)) return null;

  const storage = editor.storage.findReplace as FindReplaceStorage;
  const matchCount = storage?.matches?.length ?? 0;
  const currentIdx = (storage?.currentIndex ?? 0) + 1;
  const regexError = storage?.regexError ?? false;

  const matchLabel = regexError
    ? t("editor.find.invalidRegex")
    : matchCount === 0
      ? query
        ? t("editor.find.noMatch")
        : ""
      : `${currentIdx} / ${matchCount}`;

  function handleFindKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      if (e.shiftKey) {
        editor?.commands.findPrev();
      } else {
        editor?.commands.findNext();
      }
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
            placeholder={t("editor.find.placeholder")}
            className={`w-full rounded border bg-background px-2 py-0.5 pr-20 text-xs focus:outline-none focus:ring-1 focus:ring-primary ${regexError ? "border-destructive text-destructive" : "border-border"}`}
          />
          <span className="absolute right-2 text-xs text-muted-foreground whitespace-nowrap">
            {matchLabel}
          </span>
        </div>

        {/* Options */}
        <button
          type="button"
          title={t("editor.find.caseSensitive")}
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
          title={t("editor.find.regex")}
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
          title={t("editor.find.prev")}
          onClick={() => editor.commands.findPrev()}
          disabled={matchCount === 0}
          className="flex h-6 w-6 items-center justify-center rounded text-xs hover:bg-accent disabled:opacity-30"
        >
          ↑
        </button>
        <button
          type="button"
          title={t("editor.find.next")}
          onClick={() => editor.commands.findNext()}
          disabled={matchCount === 0}
          className="flex h-6 w-6 items-center justify-center rounded text-xs hover:bg-accent disabled:opacity-30"
        >
          ↓
        </button>

        <button
          type="button"
          title={t("editor.find.close")}
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
            placeholder={t("editor.find.replacePlaceholder")}
            className="flex-1 rounded border border-border bg-background px-2 py-0.5 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
          />
          <button
            type="button"
            title={t("editor.find.replace")}
            onClick={() => editor.commands.replaceOne(replacement)}
            disabled={matchCount === 0}
            className="rounded border border-border px-2 py-0.5 text-xs hover:bg-accent disabled:opacity-30"
          >
            {t("editor.find.replace")}
          </button>
          <button
            type="button"
            title={t("editor.find.replaceAll")}
            onClick={() => editor.commands.replaceAll(replacement)}
            disabled={matchCount === 0}
            className="rounded border border-border px-2 py-0.5 text-xs hover:bg-accent disabled:opacity-30"
          >
            {t("editor.find.replaceAll")}
          </button>
        </div>
      )}
    </div>
  );
}
