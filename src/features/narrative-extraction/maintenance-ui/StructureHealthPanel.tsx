import { useTranslation } from "react-i18next";
import {
  buildPreviewStructureHealthSummary,
  summarizeFreshnessCounts,
} from "./structureHealthModel";

interface Props {
  readonly onClose: () => void;
}

export function StructureHealthPanel({ onClose }: Props) {
  const { t } = useTranslation();
  const summary = buildPreviewStructureHealthSummary();
  const counts = summarizeFreshnessCounts(summary);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="structure-health-title"
    >
      <div className="max-h-[90vh] w-full max-w-lg overflow-auto rounded-lg border border-border bg-background p-4 shadow-lg">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h2 id="structure-health-title" className="text-base font-semibold">
              {t("narrativeMaintenance.title", "構造の健全性")}
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {t(
                "narrativeMaintenance.previewNote",
                "プレビュー: Change Feed 確定後に実数へ切り替わります。既定は決定的 Maintenance のみで、AI は自動適用しません。",
              )}
            </p>
          </div>
          <button
            type="button"
            className="rounded border border-border px-2 py-1 text-xs"
            onClick={onClose}
          >
            {t("common.close", "閉じる")}
          </button>
        </div>

        <p className="mb-2 text-xs text-muted-foreground">
          {t("narrativeMaintenance.modeLabel", "モード")}: {summary.mode}
        </p>

        <ul className="space-y-1 text-sm">
          {counts.map((row) => (
            <li
              key={row.key}
              className="flex items-center justify-between rounded border border-border/60 px-2 py-1"
            >
              <span>{t(row.labelKey, row.key)}</span>
              <span className="font-mono tabular-nums">{row.count}</span>
            </li>
          ))}
        </ul>

        <div className="mt-4 rounded border border-dashed border-border p-3 text-xs text-muted-foreground">
          {t(
            "narrativeMaintenance.principles",
            "変更検知・再解析・既存構造の書き換えは別段階です。Reanchor 候補は決定的に計算しますが自動適用しません。",
          )}
        </div>
      </div>
    </div>
  );
}
