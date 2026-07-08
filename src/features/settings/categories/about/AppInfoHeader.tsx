import { useState, useEffect } from "react";
import { GitBranch, ExternalLink, RefreshCw, FolderSearch } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useLicenseStore } from "@/features/license/store";
import { errorDetail } from "@/lib/debugLog";
import { useUpdaterStore } from "@/features/updater/updaterStore";
import {
  checkForUpdate,
  startUpdateDownload,
  restartApp,
} from "@/features/updater/api";
import { openLogDir } from "@/features/post-effect/errorToast";
import { fetchReleaseNotes } from "@/features/release-notes/fetchReleaseNotes";
import { useReleaseNotesStore } from "@/features/release-notes/releaseNotesStore";

const GITHUB_URL = "https://github.com/kazormia296/Grimodex";

export function AppInfoHeader() {
  const { t, i18n } = useTranslation();
  const [version, setVersion] = useState<string | null>(null);
  // ライセンス機構の有無 (ライセンス認証設計書 §9.1)。リリースビルドの
  // feature 指定ミスを目視確認できるようにする。
  const licensingEnabled = useLicenseStore((s) => s.licensingEnabled);
  // 更新ボタンは phase / availableVersion に応じて表示・動作を切り替える
  // (更新を確認 → 今すぐ更新 → ダウンロード中… → 再起動して更新)。
  const phase = useUpdaterStore((s) => s.phase);
  const availableVersion = useUpdaterStore((s) => s.availableVersion);
  const downloaded = useUpdaterStore((s) => s.downloaded);
  const total = useUpdaterStore((s) => s.total);

  useEffect(() => {
    getVersion()
      .then(setVersion)
      .catch(() => setVersion(null));
  }, []);

  // 手動更新チェック。自動チェック (useUpdateChecker) と違い、結果 (最新版 /
  // 失敗) も sonner トーストで明示する。更新ありのときは UpdateToast も出る。
  async function handleViewReleaseNotes() {
    if (version == null) {
      toast.error(t("releaseNotes.notAvailable"));
      return;
    }
    const content = await fetchReleaseNotes(version, i18n.language);
    if (content == null) {
      toast.error(t("releaseNotes.notAvailable"));
      return;
    }
    useReleaseNotesStore.getState().openManual({
      version,
      src: content.src,
      isFallback: content.isFallback,
    });
  }

  async function handleCheckUpdate() {
    const store = useUpdaterStore.getState();
    store.setChecking();
    try {
      const update = await checkForUpdate();
      if (update) {
        store.setAvailable(update.version, update.body ?? null);
        toast.info(
          t("updater.updateAvailable", {
            defaultValue: "新しいバージョンがあります",
          }),
        );
      } else {
        store.setUpToDate();
        toast.success(t("updater.upToDate", { defaultValue: "最新版です" }));
      }
    } catch (e) {
      store.setError(errorDetail(e));
      toast.error(
        t("updater.checkFailed", { defaultValue: "更新の確認に失敗しました" }),
      );
    }
  }

  // 更新ボタンの表示・動作を状態から導出する。
  const checkingUpdate = phase === "checking";
  const downloading = phase === "downloading";
  const ready = phase === "ready";
  const hasUpdate = availableVersion !== null;
  const updateBusy = checkingUpdate || downloading;
  // primary で強調するのは「更新あり」「準備完了」= ユーザーの操作を促したいとき。
  const updateEmphasis = ready || hasUpdate;
  const downloadPct = total > 0 ? Math.round((downloaded / total) * 100) : 0;
  const onUpdateClick = () => {
    if (ready) void restartApp();
    else if (hasUpdate) void startUpdateDownload();
    else void handleCheckUpdate();
  };
  const updateLabel = ready
    ? t("settings.about.restartToUpdate", { defaultValue: "再起動して更新" })
    : downloading
      ? t("settings.about.downloadingProgress", {
          defaultValue: "ダウンロード中… {{pct}}%",
          pct: downloadPct,
        })
      : hasUpdate
        ? t("settings.about.updateNowVersion", {
            defaultValue: "今すぐ更新 v{{version}}",
            version: availableVersion,
          })
        : t("settings.about.checkForUpdates", { defaultValue: "更新を確認" });

  return (
    <div className="flex-shrink-0 border-b border-border px-4 py-4">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <div>
          <h2 className="text-base font-semibold text-foreground">Grimodex</h2>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            {version != null && (
              <span className="whitespace-nowrap">v{version}</span>
            )}
            <span className="inline-block whitespace-nowrap rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">
              Elastic-2.0
            </span>
            <span className="inline-block whitespace-nowrap rounded bg-muted px-1.5 py-0.5 text-[10px]">
              {licensingEnabled
                ? t("settings.about.licensingEnabled")
                : t("settings.about.licensingDisabled")}
            </span>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onUpdateClick}
            disabled={updateBusy}
            className={
              updateEmphasis
                ? "flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                : "flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-border px-2.5 py-1.5 text-xs text-muted-foreground hover:border-foreground/40 hover:text-foreground disabled:opacity-50"
            }
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${updateBusy ? "animate-spin" : ""}`}
            />
            {updateLabel}
          </button>
          <button
            type="button"
            onClick={() => void handleViewReleaseNotes()}
            className="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-border px-2.5 py-1.5 text-xs text-muted-foreground hover:border-foreground/40 hover:text-foreground"
          >
            {t("releaseNotes.viewButton")}
          </button>
          <button
            type="button"
            onClick={() =>
              window.dispatchEvent(new CustomEvent("restart-sample-tour"))
            }
            className="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-border px-2.5 py-1.5 text-xs text-muted-foreground hover:border-foreground/40 hover:text-foreground"
          >
            {t("tour.restartTutorial")}
          </button>
          {/* トラブル報告用: 詳細ログ (~/.grimodex/logs/) をファイルマネージャで開く */}
          <button
            type="button"
            onClick={() => {
              openLogDir().catch(() => {
                toast.error(t("kouetsu.openLogFailed"));
              });
            }}
            className="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-border px-2.5 py-1.5 text-xs text-muted-foreground hover:border-foreground/40 hover:text-foreground"
          >
            <FolderSearch className="h-3.5 w-3.5" />
            {t("settings.about.openLogDir")}
          </button>
          <a
            href={GITHUB_URL}
            onClick={(e) => {
              e.preventDefault();
              openUrl(GITHUB_URL).catch(() => {
                toast.error(t("common.openLinkFailed"));
              });
            }}
            className="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-border px-2.5 py-1.5 text-xs text-muted-foreground hover:border-foreground/40 hover:text-foreground"
          >
            <GitBranch className="h-3.5 w-3.5" />
            {t("settings.about.github")}
            <ExternalLink className="h-3 w-3 opacity-60" />
          </a>
        </div>
      </div>
    </div>
  );
}
