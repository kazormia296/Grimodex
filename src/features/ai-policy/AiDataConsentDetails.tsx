import { ExternalLink } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  CLOUDFLARE_ABUSE_POLICY_URL,
  CLOUDFLARE_WORKERS_AI_DATA_POLICY_URL,
  type CloudContentPolicyCopy,
} from "@grimodex/scan-contract";
import type { AiDataDisclosureView } from "./aiDataDisclosureView";
import { DisclosureSection } from "./DisclosureSection";

interface AiDataConsentDetailsProps {
  disclosure: AiDataDisclosureView;
  requiresContentRights: boolean;
  contentPolicy: CloudContentPolicyCopy;
}

export function AiDataConsentDetails({
  disclosure,
  requiresContentRights,
  contentPolicy,
}: AiDataConsentDetailsProps) {
  const { t } = useTranslation();
  const applicationRetention = disclosure.retention.application;
  const policyUrls = [
    disclosure.usagePolicy.policyUrl,
    ...disclosure.processingDestinations.map(
      (destination) => destination.privacyPolicyUrl,
    ),
    disclosure.storage.provider.policyUrl,
    disclosure.retention.provider.policyUrl,
    disclosure.trainingUse.policyUrl,
  ].filter((url, index, urls) => urls.indexOf(url) === index);

  return (
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
                { days: applicationRetention.artifactDays },
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

      {requiresContentRights && (
        <DisclosureSection title={contentPolicy.heading}>
          <p>
            {contentPolicy.adultContentNotice} {contentPolicy.aiRefusalNotice}
          </p>
          <p className="mt-2">{contentPolicy.rightsNotice}</p>
          <p className="mt-3 font-medium">{contentPolicy.prohibitedHeading}</p>
          <ul className="mt-1 list-disc space-y-1 pl-5">
            {contentPolicy.prohibitedItems.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          <div className="mt-3 flex flex-wrap gap-3">
            <a
              href={CLOUDFLARE_ABUSE_POLICY_URL}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-primary underline underline-offset-2"
            >
              {contentPolicy.hostingPolicyLabel}
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
            <a
              href={CLOUDFLARE_WORKERS_AI_DATA_POLICY_URL}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-primary underline underline-offset-2"
            >
              {contentPolicy.workersAiPolicyLabel}
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </div>
        </DisclosureSection>
      )}

      <div className="flex flex-wrap gap-3">
        {policyUrls.map((url) => (
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
  );
}
