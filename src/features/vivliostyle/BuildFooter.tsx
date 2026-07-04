import { useTranslation } from "react-i18next";
import { BookOpen } from "lucide-react";

// ────────────────────────────────────────────────────────────────────
// ダイアログのフッター。選択シーン統計 + 書き出しボタン。
// 文言は ExportDialog のフッターと共通（export.dialog.*）。
// ────────────────────────────────────────────────────────────────────

interface Props {
  sceneCount: number;
  totalScenes: number;
  charCount: number;
  isRunning: boolean;
  canBuild: boolean;
  onBuild: () => void;
}

export function BuildFooter({
  sceneCount,
  totalScenes,
  charCount,
  isRunning,
  canBuild,
  onBuild,
}: Props) {
  const { t } = useTranslation();

  return (
    <div className="flex flex-shrink-0 items-center gap-3 border-t border-border px-4 py-2">
      <span className="text-xs text-muted-foreground">
        {t("export.dialog.selectedScenes", { sceneCount, totalScenes })}
      </span>
      <span className="text-xs text-muted-foreground">
        {t("export.dialog.approxChars", { count: charCount.toLocaleString() })}
      </span>
      <div className="flex-1" />
      <button
        type="button"
        data-testid="vivliostyle-build"
        onClick={onBuild}
        disabled={!canBuild}
        className="flex items-center gap-1.5 rounded bg-primary px-3 py-1.5 text-xs text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
      >
        <BookOpen className="h-3.5 w-3.5" aria-hidden />
        {isRunning
          ? t("vivliostyle.build.running")
          : t("vivliostyle.build.start")}
      </button>
    </div>
  );
}
