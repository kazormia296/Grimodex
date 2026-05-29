import { useTranslation } from "react-i18next";
import { Film } from "lucide-react";

/**
 * 執筆タイムラプス パネル。
 *
 * 動画の書き出しは「エクスポート」ダイアログ (Ctrl+Shift+E) の「タイムラプス動画」
 * タブに移設した (#8 / TimelapseExportSection)。シーン単位だけでなくプロジェクト
 * 全体 (#9) もそこから書き出せる。このパネルはその案内のみを表示する
 * (パネルは layout invariant 上 registry から外せないため残置)。
 */
export function TimelapsePanel() {
  const { t } = useTranslation();
  return (
    <div
      data-testid="timelapse-panel"
      className="flex h-full flex-col gap-2 p-4 text-sm"
    >
      <div className="flex items-center gap-2 text-foreground">
        <Film className="h-4 w-4" />
        <span className="font-medium">{t("timelapse.exportTitle")}</span>
      </div>
      <p className="text-xs text-muted-foreground">
        {t("timelapse.movedToDialog")}
      </p>
    </div>
  );
}
