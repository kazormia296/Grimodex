import { useTranslation } from "react-i18next";
import { Sparkles, Loader2 } from "lucide-react";
import { AliasesField } from "./AliasesField";
import { deriveReading, needsAiReading, type ReadingMap } from "../reading";

interface ReadingsFieldProps {
  /** 読み対象の表記一覧 = [name, ...aliases]。 */
  surfaces: string[];
  /** 表記→読みの配列。 */
  readings: ReadingMap;
  onChange: (next: ReadingMap) => void;
  /** AI 読み推定 (漢字表記が対象)。未指定ならボタンを出さない。 */
  onEstimate?: () => void;
  estimating?: boolean;
}

/**
 * 表記ごとに読み(yomi)を編集するフィールド (docs/Grimodex_IME連携設計書.md §3.3)。
 * 各表記の読みチップは AliasesField を流用する (追加/削除/commit 作法を再実装しない)。
 * ひらがな/カタカナ/ASCII 表記は自動導出できるため、読み未設定なら導出値をヒント表示する。
 * 漢字を含む表記が読み未設定のとき AI 推定ボタンを出す。
 */
export function ReadingsField({
  surfaces,
  readings,
  onChange,
  onEstimate,
  estimating = false,
}: ReadingsFieldProps) {
  const { t } = useTranslation();

  if (surfaces.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        {t("codex.readings.noSurfaces")}
      </p>
    );
  }

  // 漢字表記で読み未設定のものがあれば AI 推定を促す。
  const hasEstimable = surfaces.some(
    (s) => needsAiReading(s) && !(readings[s]?.length ?? 0),
  );

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <label className="text-xs font-medium text-muted-foreground">
          {t("codex.readings.label")}
        </label>
        {onEstimate && hasEstimable && (
          <button
            type="button"
            data-testid="readings-estimate"
            onClick={onEstimate}
            disabled={estimating}
            className="inline-flex items-center gap-1 rounded border border-border bg-muted/40 px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-60"
          >
            {estimating ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Sparkles className="h-3 w-3" />
            )}
            {t("codex.readings.estimate")}
          </button>
        )}
      </div>

      <div className="space-y-1.5">
        {surfaces.map((surface, i) => {
          const current = readings[surface] ?? [];
          const derived = deriveReading(surface);
          return (
            <div key={surface} className="space-y-0.5">
              <AliasesField
                label={surface}
                aliases={current}
                fieldId={`reading-${i}`}
                placeholder={t("codex.readings.placeholder")}
                onChange={(next) => onChange({ ...readings, [surface]: next })}
              />
              {current.length === 0 && derived && (
                <p className="pl-0.5 text-[11px] text-muted-foreground/70">
                  {t("codex.readings.auto", { yomi: derived })}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
