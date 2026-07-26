import { useTranslation } from "react-i18next";
import { BookOpen, Eye } from "lucide-react";

// ────────────────────────────────────────────────────────────────────
// ダイアログのフッター。選択シーン統計 + プレビュー/書き出しボタン。
// 文言は ExportDialog のフッターと共通（export.dialog.*）。
// プレビューはビルド中でも押せる（トグル: 開始 ⇄ 停止）。
// ────────────────────────────────────────────────────────────────────

interface Props {
  sceneCount: number;
  totalScenes: number;
  charCount: number;
  isRunning: boolean;
  canBuild: boolean;
  onBuild: () => void;
  previewRunning: boolean;
  canPreview: boolean;
  onPreview: () => void;
}

export function BuildFooter({
  sceneCount,
  totalScenes,
  charCount,
  isRunning,
  canBuild,
  onBuild,
  previewRunning,
  canPreview,
  onPreview,
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
      {previewRunning && (
        <span className="text-xs text-muted-foreground">
          {t("vivliostyle.preview.running")}
        </span>
      )}
      <button
        type="button"
        data-testid="vivliostyle-preview"
        onClick={onPreview}
        disabled={!previewRunning && !canPreview}
        title={t("vivliostyle.preview.note")}
        className="flex items-center gap-1.5 rounded border border-border px-3 py-1.5 text-xs text-foreground hover:bg-accent hover:text-accent-foreground disabled:cursor-not-allowed disabled:opacity-40"
      >
        <Eye className="h-3.5 w-3.5" aria-hidden />
        {previewRunning
          ? t("vivliostyle.preview.stop")
          : t("vivliostyle.preview.start")}
      </button>
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
