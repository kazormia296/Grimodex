import { useTranslation } from "react-i18next";
import { Lock } from "lucide-react";

/**
 * 同一 Codex エントリの本文を別窓が先に編集中のとき、この窓は read-only である
 * ことを示すバナー（advisory lock の holder が別窓）。
 */
export function CodexEditLockBanner() {
  const { t } = useTranslation();
  return (
    <div
      data-testid="codex-edit-lock-banner"
      className="flex items-center gap-1.5 border-b border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-700 dark:text-amber-300"
    >
      <Lock className="h-3 w-3 shrink-0" aria-hidden />
      <span>{t("codex.editLockedOtherWindow")}</span>
    </div>
  );
}
