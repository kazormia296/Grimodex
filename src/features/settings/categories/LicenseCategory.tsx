import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { openUrl } from "@/lib/opener";
import { ExternalLink, KeyRound } from "lucide-react";
import { useLicenseStore } from "@/features/license/store";

// Polar checkout link (Grimodex org, slug: grimodex)。2026-07-04 設定。
const PURCHASE_URL =
  "https://buy.polar.sh/polar_cl_tNDN5o9ho4h29XGEEHugWVwn3mH5NPbJJEcpx4Q87Sl";

/**
 * Settings の License カテゴリ (ライセンス認証設計書 §7)。
 * licensing 無効ビルドでは CategoryNav が項目ごと隠すためここには来ないが、
 * 念のため null を返す。
 */
export function LicenseCategory() {
  const { t } = useTranslation();
  const licensingEnabled = useLicenseStore((s) => s.licensingEnabled);
  const status = useLicenseStore((s) => s.status);
  const trialDaysRemaining = useLicenseStore((s) => s.trialDaysRemaining);
  const graceDaysRemaining = useLicenseStore((s) => s.graceDaysRemaining);
  const keyTail = useLicenseStore((s) => s.keyTail);
  const lastValidatedAt = useLicenseStore((s) => s.lastValidatedAt);

  const [keyInput, setKeyInput] = useState("");
  const [busy, setBusy] = useState(false);
  // 「この端末を解除」の二段階確認 (確認ダイアログの代わりにボタンを武装化)。
  const [deactivateArmed, setDeactivateArmed] = useState(false);

  if (!licensingEnabled) return null;

  const activated =
    status === "licensed" || status === "grace" || status === "license_stale";
  const restricted =
    status === "trial_expired" ||
    status === "license_stale" ||
    status === "revoked";

  const statusText = (() => {
    switch (status) {
      case "trial":
        return trialDaysRemaining === 0
          ? t("license.settings.status.trialLast")
          : t("license.settings.status.trial", {
              days: trialDaysRemaining ?? 0,
            });
      case "trial_expired":
        return t("license.settings.status.trialExpired");
      case "licensed":
        return t("license.settings.status.licensed", {
          tail: keyTail ?? "----",
        });
      case "grace":
        return t("license.settings.status.grace", {
          days: graceDaysRemaining ?? 0,
        });
      case "license_stale":
        return t("license.settings.status.stale");
      case "revoked":
        return t("license.settings.status.revoked");
      default:
        return "";
    }
  })();

  const handleActivate = async () => {
    const key = keyInput.trim();
    if (!key || busy) return;
    setBusy(true);
    try {
      await useLicenseStore.getState().activate(key);
      toast.success(t("license.settings.activated"));
      setKeyInput("");
    } catch (e) {
      // AppError は文字列で届く (理由別メッセージは Rust 側で組み立て済み)。
      toast.error(String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleDeactivate = async () => {
    if (busy) return;
    if (!deactivateArmed) {
      setDeactivateArmed(true);
      return;
    }
    setBusy(true);
    try {
      await useLicenseStore.getState().deactivate();
      toast.success(t("license.settings.deactivated"));
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(false);
      setDeactivateArmed(false);
    }
  };

  const handleRevalidate = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await useLicenseStore.getState().revalidate();
      toast.success(t("license.settings.revalidated"));
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-6 p-4">
      {/* 状態表示 */}
      <section>
        <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-foreground">
          <KeyRound className="h-4 w-4" />
          {t("license.settings.statusLabel")}
        </h3>
        <p className="text-sm text-foreground">{statusText}</p>
        {restricted && (
          <p className="mt-1 text-xs text-muted-foreground">
            {t("license.settings.explainRestricted")}
          </p>
        )}
        {activated && lastValidatedAt && (
          <p className="mt-1 text-xs text-muted-foreground">
            {t("license.settings.lastValidated", {
              date: new Date(lastValidatedAt).toLocaleString(),
            })}
          </p>
        )}
      </section>

      {/* キー入力 + アクティベート (未アクティベート時) */}
      {!activated && (
        <section>
          <h3 className="mb-2 text-sm font-semibold text-foreground">
            {t("license.settings.activateTitle")}
          </h3>
          <div className="flex gap-2">
            <input
              type="text"
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleActivate();
              }}
              placeholder={t("license.settings.keyPlaceholder")}
              spellCheck={false}
              className="flex-1 rounded border border-border bg-background px-2 py-1.5 font-mono text-sm text-foreground placeholder:text-muted-foreground"
            />
            <button
              type="button"
              onClick={() => void handleActivate()}
              disabled={busy || keyInput.trim().length === 0}
              className="rounded bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {busy
                ? t("license.settings.activating")
                : t("license.settings.activate")}
            </button>
          </div>
          <button
            type="button"
            onClick={() => void openUrl(PURCHASE_URL)}
            className="mt-3 flex items-center gap-1 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            <ExternalLink className="h-3 w-3" />
            {t("license.settings.purchase")}
          </button>
        </section>
      )}

      {/* 再検証 (license_stale のみ、§7) */}
      {status === "license_stale" && (
        <section>
          <button
            type="button"
            onClick={() => void handleRevalidate()}
            disabled={busy}
            className="rounded border border-border px-3 py-1.5 text-sm text-foreground hover:bg-accent disabled:opacity-50"
          >
            {t("license.settings.revalidate")}
          </button>
        </section>
      )}

      {/* この端末を解除 (アクティベート済み時) */}
      {activated && (
        <section>
          <h3 className="mb-2 text-sm font-semibold text-foreground">
            {t("license.settings.deactivateTitle")}
          </h3>
          <p className="mb-2 text-xs text-muted-foreground">
            {t("license.settings.deactivateDescription")}
          </p>
          <button
            type="button"
            onClick={() => void handleDeactivate()}
            onBlur={() => setDeactivateArmed(false)}
            disabled={busy}
            className={
              deactivateArmed
                ? "rounded border border-red-600 px-3 py-1.5 text-sm text-red-600 hover:bg-red-600/10 disabled:opacity-50"
                : "rounded border border-border px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent disabled:opacity-50"
            }
          >
            {deactivateArmed
              ? t("license.settings.deactivateConfirm")
              : t("license.settings.deactivate")}
          </button>
        </section>
      )}
    </div>
  );
}
