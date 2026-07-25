import { useEffect, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import { AiDataConsentDetails } from "./AiDataConsentDetails";
import type { AiDataDisclosureView } from "./aiDataDisclosureView";

export type { AiDataDisclosureView } from "./aiDataDisclosureView";

interface AiDataConsentDialogProps {
  open: boolean;
  disclosure: AiDataDisclosureView;
  onAccept: (consentId: string) => void;
  onDecline: () => void;
}

export function AiDataConsentDialog({
  open,
  disclosure,
  onAccept,
  onDecline,
}: AiDataConsentDialogProps) {
  const { t } = useTranslation();
  const [confirmed, setConfirmed] = useState(false);

  useEffect(() => {
    setConfirmed(false);
  }, [disclosure.consentId]);
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/55 p-4"
      role="presentation"
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="ai-data-consent-title"
        className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-xl border border-border bg-background p-6 text-foreground shadow-2xl"
      >
        <div className="mb-5 flex items-start gap-3">
          <ShieldCheck className="mt-0.5 h-6 w-6 shrink-0 text-primary" />
          <div>
            <h2 id="ai-data-consent-title" className="text-lg font-semibold">
              {t("aiDataConsent.title", "AIで処理する前に確認")}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {disclosure.usagePolicy.summary}
            </p>
          </div>
        </div>

        <AiDataConsentDetails disclosure={disclosure} />

        <label className="mt-6 flex items-start gap-3 rounded-lg border border-border bg-muted/35 p-3 text-sm">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(event) => setConfirmed(event.target.checked)}
            className="mt-0.5 h-4 w-4"
          />
          <span>
            {t(
              "aiDataConsent.confirm",
              "上記の処理・送信・保存・学習利用方針を確認しました",
            )}
          </span>
        </label>

        <div className="mt-5 flex justify-end gap-3">
          <button
            type="button"
            onClick={onDecline}
            className="rounded-md border border-input px-4 py-2 text-sm hover:bg-accent"
          >
            {t("aiDataConsent.decline", "今は使わない")}
          </button>
          <button
            type="button"
            disabled={!confirmed}
            onClick={() => onAccept(disclosure.consentId)}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t("aiDataConsent.accept", "同意してAIを使う")}
          </button>
        </div>
      </section>
    </div>
  );
}
