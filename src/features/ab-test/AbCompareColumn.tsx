import { useTranslation } from "react-i18next";
import { Check, Loader2, AlertTriangle } from "lucide-react";
import type { AbRunResult } from "./abHarness";

interface AbCompareColumnProps {
  /** "A" | "B" の見出しラベル。 */
  side: "a" | "b";
  /** この列に表示するモデル名 (空なら「既定」)。 */
  modelLabel?: string | null;
  /** プロンプト追記指示 (あれば小さく表示)。 */
  promptVariant?: string | null;
  /** 実行結果。null = 実行中。 */
  result: AbRunResult | null;
  /** 採用済みか (両列のうち選ばれた方)。 */
  chosen: boolean;
  /** 採用ボタン押下。実行中 / 失敗時は無効。 */
  onAdopt: () => void;
  /** 採用操作を許可するか (履歴閲覧などで false)。 */
  adoptable: boolean;
}

/**
 * A/B 比較の片側 1 列。モデル名・追記指示・レスポンス本文・採用ボタンを縦に並べる。
 */
export function AbCompareColumn({
  side,
  modelLabel,
  promptVariant,
  result,
  chosen,
  onAdopt,
  adoptable,
}: AbCompareColumnProps) {
  const { t } = useTranslation();
  const loading = result === null;
  const failed = result !== null && !result.ok;

  return (
    <div
      className={`flex min-h-0 min-w-0 flex-1 flex-col rounded-lg border ${
        chosen ? "border-primary" : "border-border"
      } bg-background`}
    >
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <div className="min-w-0">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {side === "a" ? t("abTest.sideA") : t("abTest.sideB")}
          </div>
          <div className="truncate text-sm" title={modelLabel ?? undefined}>
            {modelLabel?.trim() || t("abTest.defaultModel")}
          </div>
        </div>
        {chosen && (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary">
            <Check className="h-3 w-3" strokeWidth={3} aria-hidden />
            {t("abTest.chosenBadge")}
          </span>
        )}
      </div>

      {promptVariant?.trim() && (
        <div className="border-b border-border bg-muted/40 px-3 py-1.5 text-xs italic text-muted-foreground">
          + {promptVariant.trim()}
        </div>
      )}

      <div className="min-h-[8rem] flex-1 overflow-y-auto px-3 py-2 text-sm">
        {loading ? (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          </div>
        ) : failed ? (
          <div className="flex items-start gap-1.5 text-destructive">
            <AlertTriangle
              className="mt-0.5 h-3.5 w-3.5 shrink-0"
              aria-hidden
            />
            <span className="whitespace-pre-wrap break-words">
              {result.ok ? "" : result.error}
            </span>
          </div>
        ) : (
          <p className="whitespace-pre-wrap break-words">
            {result.ok ? result.text : ""}
          </p>
        )}
      </div>

      <div className="border-t border-border px-3 py-2">
        <button
          type="button"
          onClick={onAdopt}
          disabled={!adoptable || loading || failed}
          className="w-full rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
        >
          {side === "a" ? t("abTest.adoptA") : t("abTest.adoptB")}
        </button>
      </div>
    </div>
  );
}
