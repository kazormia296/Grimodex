import { useEffect, useState } from "react";
import {
  parsePublicReport,
  type PublicReportV2,
} from "@grimodex/scan-contract";
import { GrimodexLogo } from "../../../../src/components/GrimodexLogo";
import type { ScanLocale } from "../i18n/scanLocale";
import { scanMessages } from "../i18n/scanMessages";
import { PublicReportContent } from "./PublicReportContent";
import type { PublicReportApi } from "./publicReportApi";

export type { PublicReportApi } from "./publicReportApi";

interface PublicReportPageProps {
  publicReportId: string;
  locale: ScanLocale;
  api: PublicReportApi;
}

export function PublicReportPage({
  publicReportId,
  locale,
  api,
}: PublicReportPageProps) {
  const messages = scanMessages(locale);
  const copy = messages.publicReport;
  const [report, setReport] = useState<PublicReportV2>();
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    let active = true;
    setReport(undefined);
    setLoadFailed(false);
    void api
      .getPublicReport(publicReportId)
      .then((value) => {
        if (!active) return;
        const parsed = parsePublicReport(value);
        if (!parsed.ok) throw new Error("invalid public report");
        setReport(parsed.value);
      })
      .catch(() => {
        if (active) setLoadFailed(true);
      });
    return () => {
      active = false;
    };
  }, [api, publicReportId]);

  return (
    <>
      <header className="scan-app-header">
        <a className="scan-brand" href="/" aria-label="Grimodex Scan">
          <GrimodexLogo height={24} className="scan-brand__logo" />
          <span className="scan-brand__product">Scan</span>
        </a>
        <a className="scan-editor-link" href="/">
          {copy.backToScan}
        </a>
      </header>

      {!report && !loadFailed && (
        <main className="scan-public-report scan-report--state">
          <p role="status" className="scan-card scan-report-state">
            {copy.loading}
          </p>
        </main>
      )}

      {loadFailed && (
        <main className="scan-public-report scan-report--state">
          <p role="alert" className="scan-card scan-report-state scan-error">
            {copy.unavailable}
          </p>
        </main>
      )}

      {report && (
        <PublicReportContent
          report={report}
          publicReportId={publicReportId}
          locale={locale}
          api={api}
        />
      )}
    </>
  );
}
