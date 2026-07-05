import { useTranslation } from "react-i18next";
import { CheckCircle2, Loader2, Save, XCircle } from "lucide-react";
import type { VivliostyleBuildPhase } from "./runStore";

// ────────────────────────────────────────────────────────────────────
// ビルド進捗表示。indeterminate spinner + ログ末尾数行 + 中止ボタン。
// done で保存ボタン、error でメッセージ表示。
// ────────────────────────────────────────────────────────────────────

/** 表示するログの末尾行数。 */
const LOG_TAIL_LINES = 6;

interface Props {
  status: VivliostyleBuildPhase;
  logs: string[];
  onAbort: () => void;
  onSave: () => void;
  isSaving: boolean;
}

export function BuildProgress({
  status,
  logs,
  onAbort,
  onSave,
  isSaving,
}: Props) {
  const { t } = useTranslation();

  if (status.phase === "idle") return null;

  const tail = logs.slice(-LOG_TAIL_LINES);

  return (
    <div
      data-testid="vivliostyle-build-progress"
      className="flex flex-col gap-2 rounded border border-border bg-muted/30 px-3 py-2 text-xs"
    >
      {status.phase === "running" && (
        <>
          <div className="flex items-center gap-2">
            <Loader2
              className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground"
              aria-hidden
            />
            <span aria-live="polite">{t("vivliostyle.build.running")}</span>
            <div className="flex-1" />
            <button
              type="button"
              onClick={onAbort}
              className="shrink-0 rounded border border-border px-2 py-1 hover:bg-accent"
            >
              {t("vivliostyle.build.abort")}
            </button>
          </div>
          <p className="text-muted-foreground">
            {t("vivliostyle.build.firstRunNote")}
          </p>
        </>
      )}

      {status.phase === "done" && (
        <div className="flex items-center gap-2">
          <CheckCircle2
            className="h-3.5 w-3.5 shrink-0 text-green-500"
            aria-hidden
          />
          <span aria-live="polite">{t("vivliostyle.build.done")}</span>
          <div className="flex-1" />
          <button
            type="button"
            data-testid="vivliostyle-save"
            onClick={onSave}
            disabled={isSaving}
            className="flex shrink-0 items-center gap-1.5 rounded bg-primary px-2.5 py-1 text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Save className="h-3 w-3" aria-hidden />
            {isSaving
              ? t("vivliostyle.build.saving")
              : t("vivliostyle.build.save")}
          </button>
        </div>
      )}

      {status.phase === "error" && (
        <div className="flex items-start gap-2 text-destructive">
          <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <div className="min-w-0">
            <p>{t("vivliostyle.build.failed")}</p>
            <p className="break-words">{status.message}</p>
          </div>
        </div>
      )}

      {tail.length > 0 && (
        <pre className="max-h-24 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/60 p-2 font-mono text-[11px] text-muted-foreground">
          {tail.join("\n")}
        </pre>
      )}
    </div>
  );
}
