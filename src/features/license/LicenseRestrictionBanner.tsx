import { useTranslation } from "react-i18next";
import { Lock } from "lucide-react";
import { useLicenseWriteRestricted } from "./gate";

/**
 * 制限状態 (trial_expired / license_stale / revoked) の常設バナー
 * (ライセンス認証設計書 §7)。エディタ上部に細く・低彩度で出す。
 * 閉じるボタンは付けない (常設) が、執筆を中断させるモーダルにはしない。
 */
export function LicenseRestrictionBanner() {
  const { t } = useTranslation();
  const restricted = useLicenseWriteRestricted();

  if (!restricted) return null;

  const openLicenseSettings = () => {
    window.dispatchEvent(
      new CustomEvent("open-settings", { detail: { category: "license" } }),
    );
  };

  return (
    <div className="flex flex-shrink-0 items-center justify-center gap-2 border-b border-border bg-muted/60 px-3 py-1 text-xs text-muted-foreground">
      <Lock className="h-3 w-3 flex-shrink-0" />
      <span>{t("license.banner.restricted")}</span>
      <button
        type="button"
        onClick={openLicenseSettings}
        className="underline underline-offset-2 hover:text-foreground"
      >
        {t("license.banner.openSettings")}
      </button>
    </div>
  );
}
