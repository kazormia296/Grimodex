import { useState, useEffect, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Search } from "lucide-react";
import { motion } from "motion/react";
import type { CodexEntry } from "@/features/codex/api";
import { getTypeLabel } from "@/features/chat/utils/typeLabels";
import { DURATIONS, EASINGS, useReducedMotion } from "@/lib/animation";

interface CodexCommandPaletteProps {
  onSelect: (entry: CodexEntry) => void;
  onClose: () => void;
  /** 検索をこのプロジェクトに限定する（FTS インデックスは全プロジェクト共有） */
  projectId?: string;
  /** @deprecated No longer needed — labels are resolved via i18n internally */
  typeLabels?: Record<string, string>;
}

export function CodexCommandPalette({
  onSelect,
  onClose,
  projectId,
}: CodexCommandPaletteProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<CodexEntry[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const reduced = useReducedMotion();

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const handleSearch = useCallback(
    async (value: string) => {
      setQuery(value);
      if (value.trim() === "") {
        setResults([]);
        return;
      }
      const { searchCodexEntries } = await import("../search");
      const entries = await searchCodexEntries(value, projectId);
      setResults(entries);
    },
    [projectId],
  );

  return (
    <div
      data-testid="codex-command-palette"
      className="fixed inset-0 z-50 flex items-start justify-center pt-[20vh]"
      onClick={onClose}
    >
      <motion.div
        className="w-full max-w-md rounded-lg border border-border bg-background shadow-lg"
        onClick={(e) => e.stopPropagation()}
        initial={{ opacity: 0, y: -4 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -4 }}
        transition={{
          duration: reduced ? 0 : DURATIONS.fast,
          ease: EASINGS.easeOut,
        }}
      >
        <div className="flex items-center border-b border-border px-3">
          <Search className="mr-2 h-4 w-4 text-muted-foreground" />
          <input
            ref={inputRef}
            data-testid="codex-command-input"
            type="text"
            value={query}
            onChange={(e) => void handleSearch(e.target.value)}
            placeholder={t("codex.searchPlaceholder")}
            className="flex-1 bg-transparent py-3 text-sm outline-none"
          />
        </div>
        {results.length > 0 && (
          <ul className="max-h-64 overflow-y-auto p-1">
            {results.map((entry) => (
              <li key={entry.id}>
                <button
                  type="button"
                  data-testid={`codex-command-result-${entry.id}`}
                  onClick={() => {
                    onSelect(entry);
                    onClose();
                  }}
                  className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-accent"
                >
                  <span className="rounded-full bg-muted px-1.5 py-0.5 text-[9px] font-medium">
                    {getTypeLabel(entry.type)}
                  </span>
                  <span className="truncate font-medium">{entry.name}</span>
                  {entry.summary && (
                    <span className="truncate text-xs text-muted-foreground">
                      {entry.summary}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
        {query.trim() !== "" && results.length === 0 && (
          <p className="p-3 text-center text-xs text-muted-foreground">
            {t("codex.empty")}
          </p>
        )}
      </motion.div>
    </div>
  );
}
