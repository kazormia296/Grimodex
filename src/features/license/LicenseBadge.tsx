import { useTranslation } from "react-i18next";
import { CloudOff } from "lucide-react";
import { useLicenseStore } from "./store";

/**
 * エディタフッターの常駐ライセンスバッジ (ライセンス認証設計書 §7)。
 * AiPolicyBadge と同列・同型の「条件付きで null を返す」バッジ:
 * - trial 残り 5 日以下: 残日数バッジ (クリックで License 設定へ)
 * - grace: 小さな雲オフラインアイコンのみ (モーダルで執筆を中断させない)
 * - それ以外 (licensed / 制限状態 / 無効ビルド): 何も出さない
 *   (制限状態の常設バナーは LicenseRestrictionBanner が担当)
 */
export function LicenseBadge() {
  const { t } = useTranslation();
  const licensingEnabled = useLicenseStore((s) => s.licensingEnabled);
  const status = useLicenseStore((s) => s.status);
  const trialDaysRemaining = useLicenseStore((s) => s.trialDaysRemaining);

  if (!licensingEnabled) return null;

  const openLicenseSettings = () => {
    window.dispatchEvent(
      new CustomEvent("open-settings", { detail: { category: "license" } }),
    );
  };

  if (
    status === "trial" &&
    trialDaysRemaining !== null &&
    trialDaysRemaining <= 5
  ) {
    return (
      <button
        type="button"
        onClick={openLicenseSettings}
        title={t("license.badge.trialTitle")}
        className="flex h-5 items-center rounded px-2 text-xs text-amber-600 hover:bg-accent"
      >
        {t("license.badge.trial", { days: trialDaysRemaining })}
      </button>
    );
  }

  if (status === "grace") {
    return (
      <button
        type="button"
        onClick={openLicenseSettings}
        title={t("license.badge.grace")}
        className="flex h-5 items-center rounded px-1 text-muted-foreground hover:bg-accent"
      >
        <CloudOff className="h-3.5 w-3.5" />
      </button>
    );
  }

  return null;
}
