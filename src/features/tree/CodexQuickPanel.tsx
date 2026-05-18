import { useLayoutEffect } from "react";
import { useTranslation } from "react-i18next";
import { CodexQuickSection } from "./CodexQuickSection";
import {
  useCodexStore,
  type CodexSortOrder,
} from "@/features/codex/codexStore";
import { CODEX_SORT_OPTIONS } from "@/features/codex/codexSort";
import { markStart, markEnd } from "@/lib/perfLog";

/**
 * CodexQuickPanel — standalone dockview panel for Codex Quick.
 * Displays auto-detected and pinned Codex entries for the active scene.
 */
export function CodexQuickPanel() {
  markStart("codexQuickPanel.render");
  useLayoutEffect(() => {
    markEnd("codexQuickPanel.render");
  });
  const { t } = useTranslation();
  const sortOrder = useCodexStore((s) => s.sortOrder);
  const setSort = useCodexStore((s) => s.setSort);

  // Exclude "most-referenced" — CodexQuick has no ref-count data
  const sortOptions = CODEX_SORT_OPTIONS.filter(
    (opt) => opt.value !== "most-referenced",
  ).map((opt) => ({ ...opt, label: t(opt.key) }));

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="flex flex-shrink-0 items-center gap-1 border-b border-border px-2 py-1.5">
        <span className="flex-1 text-xs font-semibold text-foreground">
          Codex Quick
        </span>
        <select
          value={sortOrder === "most-referenced" ? "category" : sortOrder}
          onChange={(e) => setSort(e.target.value as CodexSortOrder)}
          className="rounded border border-input bg-background px-1 py-0.5 text-[10px]"
          title={t("codex.sortOrderTitle")}
        >
          {sortOptions.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>
      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        <CodexQuickSection />
      </div>
    </div>
  );
}
