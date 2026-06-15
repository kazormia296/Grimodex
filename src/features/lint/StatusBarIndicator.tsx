import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { AlertCircle, AlertTriangle, Check, Info, Loader2 } from "lucide-react";

import { useLayoutStore } from "@/features/layout/layoutStore";
import { useLintStore } from "./lintStore";

/**
 * Status-bar indicator for the Linter.
 *
 * Shows counts for the current scene split by severity. Zero counts are
 * hidden; if all three are zero, a single ✓ is shown. Clicking the
 * indicator toggles the Linter panel.
 *
 * Error / in-flight / idle states:
 * - LintError (lastErrorMessage set) → `⚠ Lint失敗` (stale numbers hidden)
 * - isLinting with prior results → show counts greyed out
 * - isLinting without prior results → `…`
 */
export function StatusBarIndicator() {
  const { t } = useTranslation();
  const diagnostics = useLintStore((s) => s.diagnostics);
  const isLinting = useLintStore((s) => s.isLinting);
  const lastErrorMessage = useLintStore((s) => s.lastErrorMessage);
  const currentSceneId = useLintStore((s) => s.currentSceneId);
  const togglePanel = useLayoutStore((s) => s.togglePanel);

  const counts = useMemo(() => {
    const c = { error: 0, warning: 0, info: 0 };
    for (const d of diagnostics) c[d.severity] += 1;
    return c;
  }, [diagnostics]);

  // No scene in focus → render nothing (avoid confusing users with
  // stale "✓" on codex/snippet tabs).
  if (!currentSceneId) return null;

  const onClick = () => togglePanel("kouetsu");

  if (lastErrorMessage) {
    return (
      <button
        type="button"
        onClick={onClick}
        className="flex h-5 items-center gap-1 rounded px-2 text-xs text-amber-600 hover:bg-amber-500/10"
        title={lastErrorMessage}
      >
        <AlertTriangle className="h-3.5 w-3.5" />
        {t("lint.status.failed", "Lint失敗")}
      </button>
    );
  }

  const hasPriorResults = diagnostics.length > 0;
  if (isLinting && !hasPriorResults) {
    return (
      <button
        type="button"
        onClick={onClick}
        className="flex h-5 items-center gap-1 rounded px-2 text-xs text-muted-foreground hover:bg-accent"
      >
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      </button>
    );
  }

  const allZero =
    counts.error === 0 && counts.warning === 0 && counts.info === 0;
  if (allZero) {
    return (
      <button
        type="button"
        onClick={onClick}
        title={t("lint.status.noProblems", "Linter: 問題なし")}
        className={`flex h-5 items-center gap-1 rounded px-2 text-xs hover:bg-accent ${
          isLinting ? "text-muted-foreground opacity-60" : "text-green-600"
        }`}
      >
        <Check className="h-3.5 w-3.5" />
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      title={t("lint.status.openPanel", "Linter パネルを開く")}
      className={`flex h-5 items-center gap-2 rounded px-2 text-xs hover:bg-accent ${
        isLinting ? "opacity-60" : ""
      }`}
    >
      {counts.error > 0 && (
        <span className="flex items-center gap-0.5 text-red-600">
          <AlertCircle className="h-3.5 w-3.5" />
          {counts.error}
        </span>
      )}
      {counts.warning > 0 && (
        <span className="flex items-center gap-0.5 text-amber-600">
          <AlertTriangle className="h-3.5 w-3.5" />
          {counts.warning}
        </span>
      )}
      {counts.info > 0 && (
        <span className="flex items-center gap-0.5 text-blue-600">
          <Info className="h-3.5 w-3.5" />
          {counts.info}
        </span>
      )}
    </button>
  );
}
