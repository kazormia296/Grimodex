import { useTranslation } from "react-i18next";
import { Check, Loader2, AlertTriangle } from "lucide-react";
import type { AbRunResult } from "./abHarness";

interface AbCompareColumnProps {
  /** 見出しラベル ("基準" / "枠 2" 等)。 */
  label: string;
  /** この列のプロバイダ名 (override がある枠のみ。基準は空)。 */
  providerLabel?: string | null;
  /** この列に表示するモデル名 (空なら「既定」)。 */
  modelLabel?: string | null;
  /** プロンプト追記指示 (あれば小さく表示)。 */
  promptVariant?: string | null;
  /** 実行結果。null = まだ結果なし (実行中 or 編集で破棄)。 */
  result: AbRunResult | null;
  /**
   * 比較を実行中か。result===null の意味を分けるために使う:
   * running 中の null = スピナー / 非 running の null = 未生成プレースホルダ。
   */
  running?: boolean;
  /** 採用済みか (選ばれた列)。 */
  chosen: boolean;
  /** 採用ボタン押下。実行中 / 失敗時は無効。 */
  onAdopt: () => void;
  /** 採用操作を許可するか (履歴閲覧などで false)。 */
  adoptable: boolean;
}

/**
 * A/B 比較の 1 列。ラベル・プロバイダ/モデル・追記指示・レスポンス本文・採用ボタンを縦に並べる。
 */
export function AbCompareColumn({
  label,
  providerLabel,
  modelLabel,
  promptVariant,
  result,
  running = false,
  chosen,
  onAdopt,
  adoptable,
}: AbCompareColumnProps) {
  const { t } = useTranslation();
  const modelText = modelLabel?.trim() || t("abTest.defaultModel");

  return (
    <div
      className={`flex min-h-0 w-64 shrink-0 flex-col rounded-lg border ${
        chosen ? "border-primary" : "border-border"
      } bg-background`}
    >
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <div className="min-w-0">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {label}
          </div>
          <div
            className="truncate text-sm"
            title={
              providerLabel ? `${providerLabel} / ${modelText}` : modelText
            }
          >
            {providerLabel?.trim() && (
              <span className="text-muted-foreground">{providerLabel} / </span>
            )}
            {modelText}
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
        {result === null ? (
          // null は「実行中」と「未生成 (編集で破棄)」の 2 通り。
          running ? (
            <div className="flex h-full items-center justify-center text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            </div>
          ) : (
            <div className="flex h-full items-center justify-center px-2 text-center text-xs text-muted-foreground">
              {t("abTest.columnEmpty")}
            </div>
          )
        ) : result.ok ? (
          <p className="whitespace-pre-wrap break-words">{result.text}</p>
        ) : (
          <div className="flex items-start gap-1.5 text-destructive">
            <AlertTriangle
              className="mt-0.5 h-3.5 w-3.5 shrink-0"
              aria-hidden
            />
            <span className="whitespace-pre-wrap break-words">
              {result.error}
            </span>
          </div>
        )}
      </div>

      <div className="border-t border-border px-3 py-2">
        <button
          type="button"
          onClick={onAdopt}
          disabled={!adoptable || !result || !result.ok}
          className="w-full rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
        >
          {t("abTest.adopt")}
        </button>
      </div>
    </div>
  );
}
