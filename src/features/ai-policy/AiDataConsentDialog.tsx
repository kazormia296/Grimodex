import { useEffect, useState, type ReactNode } from "react";
import { ExternalLink, ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";

export interface AiDataDisclosureView {
  schemaVersion: "grimodex/ai-data-disclosure/1";
  policyVersion: string;
  route: "scan" | "hosted-editor" | "byok";
  provider: string;
  consentId: string;
  usagePolicy: { summary: string; policyUrl: string };
  sentData: Array<{ category: string; description: string }>;
  processingDestinations: Array<{
    processor: string;
    purpose: string;
    location: string;
    privacyPolicyUrl: string;
  }>;
  storage: {
    application: {
      storesPrompt: boolean;
      storesResponse: boolean;
      location: string;
    };
    provider: { summary: string; policyUrl: string };
  };
  retention: {
    application: {
      uploadMinutes: number;
      sourceDays: number;
      artifactDays: number;
    };
    provider: { summary: string; policyUrl: string };
  };
  trainingUse: {
    status: "not-used" | "used" | "depends";
    summary: string;
    policyUrl: string;
  };
}

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

  useEffect(() => setConfirmed(false), [disclosure.consentId]);
  if (!open) return null;

  const applicationRetention = disclosure.retention.application;
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
              {t("aiDataConsent.title", "AIへ送信する前に確認")}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {disclosure.usagePolicy.summary}
            </p>
          </div>
        </div>

        <div className="space-y-5 text-sm">
          <DisclosureSection
            title={t("aiDataConsent.sentData", "送信されるデータ")}
          >
            <ul className="list-disc space-y-1 pl-5">
              {disclosure.sentData.map((item) => (
                <li key={`${item.category}:${item.description}`}>
                  {item.description}
                </li>
              ))}
            </ul>
          </DisclosureSection>

          <DisclosureSection
            title={t("aiDataConsent.destination", "処理先と地域")}
          >
            {disclosure.processingDestinations.map((destination) => (
              <p key={`${destination.processor}:${destination.purpose}`}>
                <span className="font-medium">{destination.processor}</span>
                {` — ${destination.purpose} / ${destination.location}`}
              </p>
            ))}
          </DisclosureSection>

          <DisclosureSection
            title={t("aiDataConsent.storage", "保存先と保持期間")}
          >
            <p>
              <span className="font-medium">
                {disclosure.storage.application.location}
              </span>
              {disclosure.route === "byok"
                ? ` — ${t(
                    "aiDataConsent.browserRetention",
                    "自動削除なし。ワークスペースを削除するまで保存",
                  )}`
                : ` — ${t("aiDataConsent.sourceRetention", "原稿 {{days}}日", {
                    days: applicationRetention.sourceDays,
                  })} / ${t(
                    "aiDataConsent.artifactRetention",
                    "解析結果・AI応答 {{days}}日",
                    {
                      days: applicationRetention.artifactDays,
                    },
                  )}`}
            </p>
            <p className="mt-1 text-muted-foreground">
              <span className="font-medium text-foreground">
                {t("aiDataConsent.providerStorage", "AIプロバイダ側の保存")}
                {":"}
              </span>{" "}
              {disclosure.storage.provider.summary}
            </p>
            <p className="mt-1 text-muted-foreground">
              <span className="font-medium text-foreground">
                {t(
                  "aiDataConsent.providerRetention",
                  "AIプロバイダ側の保持期間",
                )}
                {":"}
              </span>{" "}
              {disclosure.retention.provider.summary}
            </p>
          </DisclosureSection>

          <DisclosureSection
            title={t("aiDataConsent.training", "モデル学習への利用")}
          >
            <p>{disclosure.trainingUse.summary}</p>
          </DisclosureSection>

          <div className="flex flex-wrap gap-3">
            {[
              disclosure.usagePolicy.policyUrl,
              ...disclosure.processingDestinations.map(
                (destination) => destination.privacyPolicyUrl,
              ),
              disclosure.storage.provider.policyUrl,
              disclosure.retention.provider.policyUrl,
              disclosure.trainingUse.policyUrl,
            ]
              .filter((url, index, urls) => urls.indexOf(url) === index)
              .map((url) => (
                <a
                  key={url}
                  href={url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-primary underline underline-offset-2"
                >
                  {t("aiDataConsent.openPolicy", "ポリシーを開く")}
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
              ))}
          </div>
        </div>

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
              "上記の送信・保存・学習利用方針を確認しました",
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

function DisclosureSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section>
      <h3 className="mb-1 font-semibold">{title}</h3>
      {children}
    </section>
  );
}
