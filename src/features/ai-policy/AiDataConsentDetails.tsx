import { ExternalLink } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { AiDataDisclosureView } from "./aiDataDisclosureView";
import { DisclosureSection } from "./DisclosureSection";

interface AiDataConsentDetailsProps {
  disclosure: AiDataDisclosureView;
}

export function AiDataConsentDetails({
  disclosure,
}: AiDataConsentDetailsProps) {
  const { t } = useTranslation();
  const policyLinks = [
    {
      url: disclosure.usagePolicy.policyUrl,
      label: t("aiDataConsent.appPolicy", "GrimodexのAIデータ利用方針"),
    },
    ...disclosure.processingDestinations.map((destination) => ({
      url: destination.privacyPolicyUrl,
      label: t("aiDataConsent.processorPolicy", {
        defaultValue: "{{processor}}のプライバシーポリシー",
        processor: destination.processor,
      }),
    })),
    {
      url: disclosure.storage.provider.policyUrl,
      label: t("aiDataConsent.providerStoragePolicy", "AI提供者の保存ポリシー"),
    },
    {
      url: disclosure.retention.provider.policyUrl,
      label: t(
        "aiDataConsent.providerRetentionPolicy",
        "AI提供者の保持期間ポリシー",
      ),
    },
    {
      url: disclosure.trainingUse.policyUrl,
      label: t(
        "aiDataConsent.providerTrainingPolicy",
        "AI提供者の学習利用ポリシー",
      ),
    },
  ].filter(
    (link, index, links) =>
      links.findIndex((candidate) => candidate.url === link.url) === index,
  );

  return (
    <div className="space-y-5 text-sm">
      <dl className="grid gap-1 rounded-md border border-border bg-muted/25 p-3 text-xs sm:grid-cols-[auto_1fr]">
        <dt className="font-medium text-muted-foreground">
          {t("aiDataConsent.policyVersion", "ポリシーバージョン")}
        </dt>
        <dd className="font-mono">{disclosure.policyVersion}</dd>
        <dt className="font-medium text-muted-foreground">
          {t("aiDataConsent.connectionDestination", "実際の接続先")}
        </dt>
        <dd className="break-all font-mono">{disclosure.destination}</dd>
      </dl>

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

      <DisclosureSection title={t("aiDataConsent.destination", "処理先と地域")}>
        {disclosure.processingDestinations.map((destination) => (
          <p key={`${destination.processor}:${destination.purpose}`}>
            <span className="font-medium">{destination.processor}</span>
            {` — ${destination.purpose} / ${destination.location}`}
          </p>
        ))}
      </DisclosureSection>

      <DisclosureSection title={t("aiDataConsent.storage", "保存先と保持期間")}>
        <p>
          <span className="font-medium">
            {disclosure.storage.application.location}
          </span>
          {` — ${t(
            "aiDataConsent.browserRetention",
            "自動削除なし。ワークスペースを削除するまで保存",
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
            {t("aiDataConsent.providerRetention", "AIプロバイダ側の保持期間")}
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
        {policyLinks.map(({ url, label }) => (
          <a
            key={url}
            href={url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-primary underline underline-offset-2"
          >
            {label}
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        ))}
      </div>
    </div>
  );
}
