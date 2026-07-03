import { useState, useEffect } from "react";
import { GitBranch, ExternalLink, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useLicenseStore } from "@/features/license/store";
import { errorDetail } from "@/lib/debugLog";
import { useUpdaterStore } from "@/features/updater/updaterStore";
import { checkForUpdate } from "@/features/updater/api";

const GITHUB_URL = "https://github.com/kazormia296/Grimodex";

export function AppInfoHeader() {
  const { t } = useTranslation();
  const [version, setVersion] = useState<string | null>(null);
  // ライセンス機構の有無 (ライセンス認証設計書 §9.1)。リリースビルドの
  // feature 指定ミスを目視確認できるようにする。
  const licensingEnabled = useLicenseStore((s) => s.licensingEnabled);
  // 手動更新チェック中はボタンを無効化しアイコンを回す。
  const checkingUpdate = useUpdaterStore((s) => s.phase === "checking");

  useEffect(() => {
    getVersion()
      .then(setVersion)
      .catch(() => setVersion(null));
  }, []);

  // 手動更新チェック。自動チェック (useUpdateChecker) と違い、結果 (最新版 /
  // 失敗) も sonner トーストで明示する。更新ありのときは UpdateToast も出る。
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

  return (
    <div className="flex-shrink-0 border-b border-border px-4 py-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-foreground">Grimodex</h2>
          <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
            {version != null && <span>v{version}</span>}
            <span className="inline-block rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">
              Elastic-2.0
            </span>
            <span className="inline-block rounded bg-muted px-1.5 py-0.5 text-[10px]">
              {licensingEnabled
                ? t("settings.about.licensingEnabled")
                : t("settings.about.licensingDisabled")}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void handleCheckUpdate()}
            disabled={checkingUpdate}
            className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs text-muted-foreground hover:border-foreground/40 hover:text-foreground disabled:opacity-50"
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${checkingUpdate ? "animate-spin" : ""}`}
            />
            {t("settings.about.checkForUpdates", {
              defaultValue: "更新を確認",
            })}
          </button>
          <button
            type="button"
            onClick={() =>
              window.dispatchEvent(new CustomEvent("restart-sample-tour"))
            }
            className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs text-muted-foreground hover:border-foreground/40 hover:text-foreground"
          >
            {t("tour.restartTutorial")}
          </button>
          <a
            href={GITHUB_URL}
            onClick={(e) => {
              e.preventDefault();
              openUrl(GITHUB_URL).catch(() => {
                toast.error(t("common.openLinkFailed"));
              });
            }}
            className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs text-muted-foreground hover:border-foreground/40 hover:text-foreground"
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
