import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { BookMarked, Check } from "lucide-react";
import { useCodexStore } from "@/features/codex/codexStore";

interface CodexScopePickerSectionProps {
  selectedId: string | null;
  onPick: (id: string) => void;
}

export function CodexScopePickerSection({
  selectedId,
  onPick,
}: CodexScopePickerSectionProps) {
  const { t } = useTranslation();
  const entries = useCodexStore((s) => s.entries);
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter((e) => {
      if (e.name.toLowerCase().includes(q)) return true;
      try {
        const aliases = JSON.parse(e.aliases ?? "[]") as unknown;
        if (Array.isArray(aliases)) {
          return aliases.some(
            (a) => typeof a === "string" && a.toLowerCase().includes(q),
          );
        }
      } catch {
        /* ignore */
      }
      return false;
    });
  }, [entries, query]);

  return (
    <div className="border-t border-border px-3 py-2">
      <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {t("chat.scope.codexSection")}
      </p>
      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t("chat.scope.codexSearch")}
        className="mb-2 w-full rounded border border-border bg-background px-2 py-1 text-xs text-foreground placeholder:text-muted-foreground"
        aria-label={t("chat.scope.codexSearch")}
      />
      <div className="max-h-48 overflow-y-auto">
        {filtered.length === 0 && (
          <p className="py-2 text-xs text-muted-foreground">
            {t("chat.scope.noCodexEntries")}
          </p>
        )}
        {filtered.map((entry) => {
          const isSelected = selectedId === entry.id;
          return (
            <button
              key={entry.id}
              type="button"
              onClick={() => onPick(entry.id)}
              className={[
                "flex w-full items-center gap-1.5 py-1 pr-1 text-left text-xs",
                isSelected
                  ? "bg-accent font-medium text-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground",
              ].join(" ")}
            >
              <BookMarked className="h-3 w-3 shrink-0 opacity-70" />
              <span className="flex-1 truncate">{entry.name}</span>
              <span className="shrink-0 text-[10px] opacity-60">
                {entry.type}
              </span>
              {isSelected && <Check className="h-3 w-3 shrink-0" />}
            </button>
          );
        })}
      </div>
    </div>
  );
}
