import { useState, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import type { SuggestedEntry } from "../contextCreatorApi";

interface ContextCreatorDialogProps {
  onSearch: (instruction: string) => Promise<SuggestedEntry[]>;
  onAddSelected: (entries: SuggestedEntry[]) => Promise<void>;
  onClose: () => void;
}

export function ContextCreatorDialog({
  onSearch,
  onAddSelected,
  onClose,
}: ContextCreatorDialogProps) {
  const { t } = useTranslation();
  const [input, setInput] = useState("");
  const [isSearching, setIsSearching] = useState(false);
  const [results, setResults] = useState<SuggestedEntry[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [isAdding, setIsAdding] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // ESC で閉じる
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  async function handleSearch() {
    const q = input.trim();
    if (!q || isSearching) return;
    setIsSearching(true);
    setResults(null);
    try {
      const entries = await onSearch(q);
      setResults(entries);
      // 既にピン留め済みでないものを全選択
      setSelected(
        new Set(entries.filter((e) => !e.alreadyPinned).map((e) => e.id)),
      );
    } finally {
      setIsSearching(false);
    }
  }

  async function handleAdd() {
    if (!results || selected.size === 0 || isAdding) return;
    const toAdd = results.filter((e) => selected.has(e.id) && !e.alreadyPinned);
    setIsAdding(true);
    try {
      await onAddSelected(toAdd);
      onClose();
    } finally {
      setIsAdding(false);
    }
  }

  function toggleEntry(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const typeLabel: Record<string, string> = {
    character: t("codex.character"),
    location: t("codex.location"),
    item: t("codex.item"),
    lore: t("codex.lore"),
  };

  const newlySelected = results
    ? results.filter((e) => selected.has(e.id) && !e.alreadyPinned)
    : [];

  return (
    <div className="border-b border-border bg-muted/20 px-4 py-2">
      {/* 入力欄 */}
      <div className="flex gap-2">
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleSearch();
          }}
          placeholder={t("chat.context.inputPlaceholder")}
          className="flex-1 rounded border border-border bg-background px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-primary"
          disabled={isSearching}
        />
        <button
          type="button"
          onClick={handleSearch}
          disabled={!input.trim() || isSearching}
          className="rounded bg-primary px-2 py-1 text-xs text-primary-foreground disabled:opacity-50"
        >
          {isSearching ? <Loader2 className="h-3 w-3 animate-spin" /> : "▶"}
        </button>
        <button
          type="button"
          onClick={onClose}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          ✕
        </button>
      </div>

      {/* 検索中インジケーター */}
      {isSearching && (
        <p className="mt-2 text-xs text-muted-foreground">Searching...</p>
      )}

      {/* 結果リスト */}
      {results !== null && !isSearching && (
        <div className="mt-2">
          {results.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {t("chat.context.noResults")}
            </p>
          ) : (
            <>
              <p className="mb-1 text-xs text-muted-foreground">
                {t("chat.context.foundEntries", { count: results.length })}
              </p>
              <ul className="space-y-1 max-h-40 overflow-y-auto">
                {results.map((entry) => (
                  <li key={entry.id} className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      id={`cc-${entry.id}`}
                      checked={selected.has(entry.id) || entry.alreadyPinned}
                      disabled={entry.alreadyPinned}
                      onChange={() => toggleEntry(entry.id)}
                      className="mt-0.5 shrink-0"
                    />
                    <label
                      htmlFor={`cc-${entry.id}`}
                      className="cursor-pointer text-xs"
                    >
                      <span className="font-medium">{entry.name}</span>
                      <span className="ml-1 rounded bg-muted px-1 text-muted-foreground">
                        {typeLabel[entry.type] ?? entry.type}
                      </span>
                      {entry.alreadyPinned && (
                        <span className="ml-1 text-muted-foreground">
                          {t("chat.context.alreadyPinned")}
                        </span>
                      )}
                      {entry.summary && (
                        <span className="ml-1 text-muted-foreground">
                          — {entry.summary}
                        </span>
                      )}
                    </label>
                  </li>
                ))}
              </ul>
              {newlySelected.length > 0 && (
                <button
                  type="button"
                  onClick={handleAdd}
                  disabled={isAdding}
                  className="mt-2 rounded bg-primary px-2 py-1 text-xs text-primary-foreground disabled:opacity-50"
                >
                  {isAdding ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    t("chat.context.addSelected", {
                      count: newlySelected.length,
                    })
                  )}
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
