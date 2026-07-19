import { useMemo } from "react";
import type { PublicReportV2 } from "@grimodex/scan-contract";
import type { ScanLocale } from "../i18n/scanLocale";
import { scanMessages } from "../i18n/scanMessages";
import { PublicListCard } from "./PublicListCard";
import { PublicReportAbuseForm } from "./PublicReportAbuseForm";
import type { PublicReportApi } from "./publicReportApi";

interface PublicReportContentProps {
  report: PublicReportV2;
  publicReportId: string;
  locale: ScanLocale;
  api: PublicReportApi;
}

export function PublicReportContent({
  report,
  publicReportId,
  locale,
  api,
}: PublicReportContentProps) {
  const messages = scanMessages(locale);
  const copy = messages.publicReport;
  const entityNames = useMemo(
    () =>
      new Map(
        report.entities.map((entity, index) => [
          entity.id,
          entity.name || copy.entityLabel(index + 1),
        ]),
      ),
    [copy, report],
  );

  return (
    <main className="scan-public-report">
      <header className="scan-report__header">
        <div>
          <p className="scan-eyebrow">{copy.eyebrow}</p>
          <h1>{report.title || copy.untitledReport}</h1>
          <p className="scan-muted">
            {copy.sourceCounts(
              report.source.sectionCount,
              report.source.paragraphCount,
              report.source.characterCount,
            )}
          </p>
        </div>
      </header>

      <section className="scan-card scan-public-disclosure">
        <p>{copy.projectionNotice}</p>
        <p>{copy.derivedLabelNotice}</p>
      </section>

      <div className="scan-report__grid">
        <PublicListCard
          title={copy.genres}
          items={report.summary.genreCandidates.map(
            (value, index) => value || copy.genreLabel(index + 1),
          )}
        />
        <PublicListCard
          title={copy.themes}
          items={report.summary.themes.map(
            (value, index) => value || copy.themeLabel(index + 1),
          )}
        />
      </div>

      <section className="scan-card">
        <h2>{copy.entities}</h2>
        <div className="scan-entity-list">
          {report.entities.map((entity) => (
            <article className="scan-entity" key={entity.id}>
              <div>
                <strong>{entityNames.get(entity.id)}</strong>
                <span>
                  {messages.report.entityTypes[entity.type] ?? entity.type}
                </span>
              </div>
              {entity.aliases.length > 0 && (
                <small>
                  {entity.aliases.join(locale === "ja" ? "、" : ", ")}
                </small>
              )}
            </article>
          ))}
        </div>
      </section>

      <div className="scan-report__grid">
        <section className="scan-card">
          <h2>{copy.relations}</h2>
          <ul className="scan-list">
            {report.relations.map((relation) => (
              <li key={relation.id}>
                {entityNames.get(relation.fromEntityId) ??
                  relation.fromEntityId}
                {" — "}
                {relation.type || copy.relationLabel}
                {" — "}
                {entityNames.get(relation.toEntityId) ?? relation.toEntityId}
              </li>
            ))}
          </ul>
        </section>
        <PublicListCard
          title={copy.phases}
          items={report.phases.map((_, index) => copy.phaseLabel(index + 1))}
        />
        <PublicListCard
          title={copy.events}
          items={report.events.map((_, index) => copy.eventLabel(index + 1))}
        />
        <PublicListCard
          title={copy.findings}
          items={report.findings.map((_, index) =>
            copy.findingLabel(index + 1),
          )}
        />
      </div>

      <PublicReportAbuseForm
        publicReportId={publicReportId}
        locale={locale}
        api={api}
      />
    </main>
  );
}
