import { useState } from "react";
import type {
  FindingStatus,
  ScanBundleV1,
  ScanFinding,
} from "@grimodex/scan-contract";
import { scanMessages } from "../i18n/scanMessages";
import type { ScanLocale } from "../i18n/scanLocale";

interface Props {
  bundle: ScanBundleV1;
  locale?: ScanLocale;
  writingLanguageSource?: "detected" | "selected";
  reportMode?: "private" | "demo";
  onOpenEditor?: () => void;
  onFeedback?: (
    findingId: string,
    status: Extract<FindingStatus, "intentional" | "rejected">,
  ) => void;
  onPublishPublicReport?: () => void;
  onUnpublishPublicReport?: () => void;
  publicReportId?: string;
  publicReportBusy?: boolean;
  editorBusy?: boolean;
  onDelete?: () => void;
  deleteBusy?: boolean;
}

function EvidenceList({
  finding,
  locale,
}: {
  finding: ScanFinding;
  locale: ScanLocale;
}) {
  const copy = scanMessages(locale).report;
  return (
    <details className="scan-evidence">
      <summary>
        {copy.evidence} {finding.evidence.length}
        {locale === "ja" ? "件" : ""}
      </summary>
      <ul>
        {finding.evidence.map((evidence) => (
          <li key={`${evidence.sectionId}:${evidence.paragraphId}`}>
            <code>{evidence.paragraphId}</code>
            {evidence.excerpt && <q>{evidence.excerpt}</q>}
          </li>
        ))}
      </ul>
    </details>
  );
}

function countSummary(bundle: ScanBundleV1, locale: ScanLocale): string {
  const characters = bundle.source.characterCount.toLocaleString(
    locale === "ja" ? "ja-JP" : "en-US",
  );
  if (locale === "ja") {
    return `${characters}文字 · ${bundle.source.sectionCount}章 · ${bundle.source.paragraphCount}段落`;
  }
  const sections = `${bundle.source.sectionCount} ${
    bundle.source.sectionCount === 1 ? "section" : "sections"
  }`;
  const paragraphs = `${bundle.source.paragraphCount} ${
    bundle.source.paragraphCount === 1 ? "paragraph" : "paragraphs"
  }`;
  return `${characters} characters · ${sections} · ${paragraphs}`;
}

export function ScanReport({
  bundle,
  locale = "ja",
  writingLanguageSource = "detected",
  reportMode = "private",
  onOpenEditor,
  onFeedback,
  onPublishPublicReport,
  onUnpublishPublicReport,
  publicReportId,
  publicReportBusy,
  editorBusy,
  onDelete,
  deleteBusy,
}: Props) {
  const [activeFinding, setActiveFinding] = useState<string | null>(null);
  const messages = scanMessages(locale);
  const copy = messages.report;
  const writingLanguage =
    bundle.source.language === "ja"
      ? copy.japanese
      : bundle.source.language === "en"
        ? copy.english
        : copy.other;
  const writingLanguageMethod =
    writingLanguageSource === "selected" ? copy.selected : copy.detected;
  const publicReportHref = publicReportId
    ? `/?${new URLSearchParams({ publicReport: publicReportId }).toString()}`
    : undefined;

  return (
    <main className="scan-report" data-testid="scan-report">
      <header className="scan-report__header">
        <div>
          <p className="scan-eyebrow">
            Grimodex Scan · {reportMode === "demo" ? copy.demo : copy.private}
          </p>
          <h1>{bundle.source.title}</h1>
          {reportMode === "demo" && (
            <p className="scan-muted">{copy.demoDescription}</p>
          )}
          <p className="scan-muted">{countSummary(bundle, locale)}</p>
          <p className="scan-muted">
            {copy.writingLanguage}: {writingLanguage} ({writingLanguageMethod})
          </p>
        </div>
        <div className="scan-report__actions">
          {onOpenEditor && (
            <button
              type="button"
              className="scan-primary"
              onClick={onOpenEditor}
              disabled={editorBusy}
            >
              {editorBusy ? copy.preparingEditor : copy.edit}
            </button>
          )}
          {onPublishPublicReport && !publicReportId && (
            <button
              type="button"
              className="scan-secondary"
              onClick={onPublishPublicReport}
              disabled={publicReportBusy}
            >
              {publicReportBusy ? copy.publishing : copy.publish}
            </button>
          )}
          {publicReportId && onUnpublishPublicReport && (
            <button
              type="button"
              className="scan-secondary"
              onClick={onUnpublishPublicReport}
              disabled={publicReportBusy}
            >
              {publicReportBusy ? copy.updating : copy.unpublish}
            </button>
          )}
          {onDelete && (
            <button
              type="button"
              className="scan-danger"
              onClick={onDelete}
              disabled={deleteBusy}
            >
              {deleteBusy
                ? messages.deletion.deleting
                : messages.deletion.action}
            </button>
          )}
        </div>
      </header>
      {publicReportId && (
        <div className="scan-publication-notice">
          <p className="scan-muted">
            {copy.publicReportId}: <code>{publicReportId}</code>{" "}
            <a href={publicReportHref} target="_blank" rel="noreferrer">
              {copy.viewPublicReport}
            </a>
          </p>
          <p className="scan-muted">{copy.publicReportNotice}</p>
        </div>
      )}

      <section
        className="scan-card scan-overview"
        aria-labelledby="scan-overview-title"
      >
        <h2 id="scan-overview-title">{copy.overview}</h2>
        {bundle.summary.premise && <p>{bundle.summary.premise}</p>}
        <div className="scan-chip-row">
          {bundle.summary.genreCandidates.map((genre) => (
            <span className="scan-chip" key={genre.value}>
              {genre.value}
            </span>
          ))}
        </div>
      </section>

      <div className="scan-report__grid">
        <section className="scan-card" aria-labelledby="scan-entities-title">
          <h2 id="scan-entities-title">{copy.entities}</h2>
          <div className="scan-entity-list">
            {bundle.entities.map((entity) => (
              <article
                className="scan-entity"
                key={entity.id}
                data-testid="scan-entity-card"
              >
                <div>
                  <strong>{entity.name}</strong>
                  <span>{copy.entityTypes[entity.type] ?? entity.type}</span>
                </div>
                {entity.summary && <p>{entity.summary}</p>}
                {entity.aliases.length > 0 && (
                  <small>
                    {copy.aliases}:{" "}
                    {entity.aliases.join(locale === "ja" ? "、" : ", ")}
                  </small>
                )}
              </article>
            ))}
          </div>
        </section>

        <section className="scan-card" aria-labelledby="scan-relations-title">
          <h2 id="scan-relations-title">{copy.relations}</h2>
          <ul className="scan-list" data-testid="scan-relation-list">
            {bundle.relations.map((relation) => {
              const from =
                bundle.entities.find(
                  (entity) => entity.id === relation.fromEntityId,
                )?.name ?? relation.fromEntityId;
              const to =
                bundle.entities.find(
                  (entity) => entity.id === relation.toEntityId,
                )?.name ?? relation.toEntityId;
              return (
                <li key={relation.id}>
                  <strong>{from}</strong> → <strong>{to}</strong>
                  <span>{relation.label ?? relation.type}</span>
                </li>
              );
            })}
          </ul>
        </section>
      </div>

      <section className="scan-card" aria-labelledby="scan-phases-title">
        <h2 id="scan-phases-title">{copy.phases}</h2>
        <ol className="scan-phase-list">
          {bundle.phases.map((phase) => (
            <li key={phase.id}>
              <div>
                <strong>{phase.title}</strong>
                <span>{Math.round(phase.confidence * 100)}%</span>
              </div>
              {phase.summary && <p>{phase.summary}</p>}
              <small>
                {copy.evidenceParagraphs} {phase.anchors.length}
                {locale === "ja" ? "件" : ""}
              </small>
            </li>
          ))}
        </ol>
      </section>

      <section className="scan-card" aria-labelledby="scan-findings-title">
        <h2 id="scan-findings-title">{copy.findings}</h2>
        <div className="scan-finding-list">
          {bundle.findings.map((finding) => (
            <article
              className={`scan-finding scan-finding--${finding.status}`}
              key={finding.id}
              data-testid="scan-finding"
            >
              <button
                type="button"
                className="scan-finding__toggle"
                onClick={() =>
                  setActiveFinding(
                    activeFinding === finding.id ? null : finding.id,
                  )
                }
              >
                <span className="scan-finding__status">
                  {copy.statuses[finding.status]}
                </span>
                <strong>{finding.title}</strong>
                <span aria-hidden="true">
                  {activeFinding === finding.id ? "−" : "+"}
                </span>
              </button>
              {activeFinding === finding.id && (
                <div className="scan-finding__body">
                  <p>{finding.summary}</p>
                  <EvidenceList finding={finding} locale={locale} />
                  {finding.status === "candidate" && (
                    <div className="scan-finding__actions">
                      <button
                        type="button"
                        onClick={() => onFeedback?.(finding.id, "intentional")}
                      >
                        {copy.intentional}
                      </button>
                      <button
                        type="button"
                        onClick={() => onFeedback?.(finding.id, "rejected")}
                      >
                        {copy.rejected}
                      </button>
                    </div>
                  )}
                </div>
              )}
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}
