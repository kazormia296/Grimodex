import { useState, type ReactNode } from "react";
import type { AiDataDisclosureV1 } from "@grimodex/scan-contract";

interface ScanAiConsentDialogProps {
  disclosure: AiDataDisclosureV1;
  onAccept: (consentId: string) => void;
  onDecline: () => void;
}

export function ScanAiConsentDialog({
  disclosure,
  onAccept,
  onDecline,
}: ScanAiConsentDialogProps) {
  const [confirmed, setConfirmed] = useState(false);
  const retention = disclosure.retention.application;
  const policyLinks = [
    disclosure.usagePolicy.policyUrl,
    disclosure.storage.provider.policyUrl,
    disclosure.retention.provider.policyUrl,
    disclosure.trainingUse.policyUrl,
    ...disclosure.processingDestinations.map(
      (destination) => destination.privacyPolicyUrl,
    ),
  ].filter((url, index, urls) => urls.indexOf(url) === index);

  return (
    <div className="scan-consent-backdrop" role="presentation">
      <section
        className="scan-consent-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="scan-consent-title"
      >
        <header>
          <p className="scan-eyebrow">Grimodex Scan · Data policy</p>
          <h2 id="scan-consent-title">原稿をAIへ送信する前に確認</h2>
          <p>{disclosure.usagePolicy.summary}</p>
        </header>

        <div className="scan-consent-sections">
          <DisclosureSection title="送信されるデータ">
            <ul>
              {disclosure.sentData.map((item) => (
                <li key={`${item.category}:${item.description}`}>
                  {item.description}
                </li>
              ))}
            </ul>
          </DisclosureSection>

          <DisclosureSection title="処理先と地域">
            {disclosure.processingDestinations.map((destination) => (
              <p key={`${destination.processor}:${destination.purpose}`}>
                <strong>{destination.processor}</strong>
                {` — ${destination.purpose} / ${destination.location}`}
              </p>
            ))}
          </DisclosureSection>

          <DisclosureSection title="保存先と保持期間">
            <p>
              <strong>{disclosure.storage.application.location}</strong>
              {` — アップロード枠 ${retention.uploadMinutes}分 / 原稿 ${retention.sourceDays}日 / 解析結果 ${retention.artifactDays}日`}
            </p>
            <p className="scan-muted">
              <strong>AIプロバイダ側の保存:</strong>{" "}
              {disclosure.storage.provider.summary}
            </p>
            <p className="scan-muted">
              <strong>AIプロバイダ側の保持期間:</strong>{" "}
              {disclosure.retention.provider.summary}
            </p>
          </DisclosureSection>

          <DisclosureSection title="モデル学習への利用">
            <p>{disclosure.trainingUse.summary}</p>
          </DisclosureSection>

          <div className="scan-policy-links">
            {policyLinks.map((url) => (
              <a key={url} href={url} target="_blank" rel="noreferrer">
                ポリシーを開く
              </a>
            ))}
          </div>
        </div>

        <label className="scan-consent-confirm">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(event) => setConfirmed(event.currentTarget.checked)}
          />
          <span>上記の送信・保存・学習利用方針を確認しました</span>
        </label>

        <footer className="scan-consent-actions">
          <button type="button" className="scan-secondary" onClick={onDecline}>
            今はScanしない
          </button>
          <button
            type="button"
            className="scan-primary"
            disabled={!confirmed}
            onClick={() => onAccept(disclosure.consentId)}
          >
            同意してScanを開始
          </button>
        </footer>
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
      <h3>{title}</h3>
      {children}
    </section>
  );
}
