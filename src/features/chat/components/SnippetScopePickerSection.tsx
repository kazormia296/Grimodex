import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { NotepadText, Check } from "lucide-react";
import { useSnippetStore } from "@/features/snippets/snippetStore";

interface SnippetScopePickerSectionProps {
  selectedId: string | null;
  onPick: (id: string) => void;
}

export function SnippetScopePickerSection({
  selectedId,
  onPick,
}: SnippetScopePickerSectionProps) {
  const { t } = useTranslation();
  const entries = useSnippetStore((s) => s.entries);
  const ensureEntriesLoaded = useSnippetStore((s) => s.ensureEntriesLoaded);
  const [query, setQuery] = useState("");

  // Snippet パネル未訪問だと entries が空のままなので、タブ表示時にロードを保証する
  useEffect(() => {
    ensureEntriesLoaded();
  }, [ensureEntriesLoaded]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter((e) => e.title.toLowerCase().includes(q));
  }, [entries, query]);

  return (
    <div className="px-3 py-2">
      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t("chat.scope.snippetSearch")}
        className="mb-2 w-full rounded border border-border bg-background px-2 py-1 text-xs text-foreground placeholder:text-muted-foreground"
        aria-label={t("chat.scope.snippetSearch")}
      />
      <div className="max-h-48 overflow-y-auto">
        {filtered.length === 0 && (
          <p className="py-2 text-xs text-muted-foreground">
            {t("chat.scope.noSnippets")}
          </p>
        )}
        {filtered.map((snippet) => {
          const isSelected = selectedId === snippet.id;
          return (
            <button
              key={snippet.id}
              type="button"
              onClick={() => onPick(snippet.id)}
              className={[
                "flex w-full items-center gap-1.5 py-1 pr-1 text-left text-xs",
                isSelected
                  ? "bg-accent font-medium text-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground",
              ].join(" ")}
            >
              <NotepadText className="h-3 w-3 shrink-0 opacity-70" />
              <span className="flex-1 truncate">{snippet.title}</span>
              {isSelected && <Check className="h-3 w-3 shrink-0" />}
            </button>
          );
        })}
      </div>
    </div>
  );
}
