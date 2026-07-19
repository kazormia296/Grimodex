import { useState, type ReactNode } from "react";
import type { AiDataDisclosureV1 } from "@grimodex/scan-contract";
import { scanMessages, type ScanMessages } from "../i18n/scanMessages";
import type { ScanLocale } from "../i18n/scanLocale";

interface ScanAiConsentDialogProps {
  disclosure: AiDataDisclosureV1;
  locale: ScanLocale;
  onAccept: (consentId: string) => void;
  onDecline: () => void;
}

interface PolicyLink {
  url: string;
  label: string;
}

function buildPolicyLinks(
  disclosure: AiDataDisclosureV1,
  copy: ScanMessages["consent"],
): PolicyLink[] {
  const links: PolicyLink[] = [];
  const seen = new Set<string>();
  const add = (url: string, label: string) => {
    if (seen.has(url)) return;
    seen.add(url);
    links.push({ url, label });
  };

  add(disclosure.usagePolicy.policyUrl, copy.grimodexPolicy);
  disclosure.processingDestinations.forEach((destination) => {
    add(
      destination.privacyPolicyUrl,
      copy.destinationPolicy(destination.processor),
    );
  });
  add(disclosure.storage.provider.policyUrl, copy.storagePolicy);
  add(disclosure.retention.provider.policyUrl, copy.retentionPolicy);
  add(disclosure.trainingUse.policyUrl, copy.trainingPolicy);
  return links;
}

export function ScanAiConsentDialog({
  disclosure,
  locale,
  onAccept,
  onDecline,
}: ScanAiConsentDialogProps) {
  const [confirmed, setConfirmed] = useState(false);
  const retention = disclosure.retention.application;
  const copy = scanMessages(locale).consent;
  const policyLinks = buildPolicyLinks(disclosure, copy);

  return (
    <div className="scan-consent-backdrop" role="presentation">
      <section
        className="scan-consent-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="scan-consent-title"
      >
        <header>
          <p className="scan-eyebrow">{copy.eyebrow}</p>
          <h2 id="scan-consent-title">{copy.title}</h2>
          <p>{disclosure.usagePolicy.summary}</p>
        </header>

        <div className="scan-consent-sections">
          <DisclosureSection title={copy.sentData}>
            <ul>
              {disclosure.sentData.map((item) => (
                <li key={`${item.category}:${item.description}`}>
                  {item.description}
                </li>
              ))}
            </ul>
          </DisclosureSection>

          <DisclosureSection title={copy.destinations}>
            {disclosure.processingDestinations.map((destination) => (
              <p key={`${destination.processor}:${destination.purpose}`}>
                <strong>{destination.processor}</strong>
                {` — ${destination.purpose} / ${destination.location}`}
              </p>
            ))}
          </DisclosureSection>

          <DisclosureSection title={copy.storage}>
            <p>
              <strong>{disclosure.storage.application.location}</strong>
              {` — ${copy.retentionSummary(
                retention.uploadMinutes,
                retention.sourceDays,
                retention.artifactDays,
              )}`}
            </p>
            <p className="scan-muted">
              <strong>{copy.providerStorage}:</strong>{" "}
              {disclosure.storage.provider.summary}
            </p>
            <p className="scan-muted">
              <strong>{copy.providerRetention}:</strong>{" "}
              {disclosure.retention.provider.summary}
            </p>
          </DisclosureSection>

          <DisclosureSection title={copy.training}>
            <p>{disclosure.trainingUse.summary}</p>
          </DisclosureSection>

          <div className="scan-policy-links">
            {policyLinks.map(({ url, label }) => (
              <a key={url} href={url} target="_blank" rel="noreferrer">
                {label}
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
          <span>{copy.confirm}</span>
        </label>

        <footer className="scan-consent-actions">
          <button type="button" className="scan-secondary" onClick={onDecline}>
            {copy.decline}
          </button>
          <button
            type="button"
            className="scan-primary"
            disabled={!confirmed}
            onClick={() => onAccept(disclosure.consentId)}
          >
            {copy.accept}
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
