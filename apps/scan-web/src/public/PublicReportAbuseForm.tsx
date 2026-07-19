import { useState, type FormEvent } from "react";
import { CLOUDFLARE_ABUSE_REPORT_URL } from "@grimodex/scan-contract";
import type { ScanLocale } from "../i18n/scanLocale";
import { scanMessages } from "../i18n/scanMessages";
import type { PublicReportApi } from "./publicReportApi";

interface PublicReportAbuseFormProps {
  publicReportId: string;
  locale: ScanLocale;
  api: PublicReportApi;
}

export function PublicReportAbuseForm({
  publicReportId,
  locale,
  api,
}: PublicReportAbuseFormProps) {
  const copy = scanMessages(locale).publicReport;
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [submitFailed, setSubmitFailed] = useState(false);

  const submitAbuseReport = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalizedReason = reason.trim();
    if (!normalizedReason || normalizedReason.length > 1_000 || submitting) {
      return;
    }
    setSubmitting(true);
    setSubmitted(false);
    setSubmitFailed(false);
    try {
      await api.reportPublicAbuse(publicReportId, normalizedReason);
      setReason("");
      setSubmitted(true);
    } catch {
      setSubmitFailed(true);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="scan-card scan-abuse-report">
      <h2>{copy.abuseTitle}</h2>
      <p className="scan-muted">{copy.abuseCaveat}</p>
      <form onSubmit={(event) => void submitAbuseReport(event)}>
        <label>
          {copy.abuseReason}
          <textarea
            required
            maxLength={1_000}
            value={reason}
            placeholder={copy.abusePlaceholder}
            onChange={(event) => setReason(event.currentTarget.value)}
          />
        </label>
        <div className="scan-abuse-report__actions">
          <button
            type="submit"
            className="scan-primary"
            disabled={!reason.trim() || submitting}
          >
            {submitting ? copy.abuseSubmitting : copy.abuseSubmit}
          </button>
          <a
            href={CLOUDFLARE_ABUSE_REPORT_URL}
            target="_blank"
            rel="noreferrer"
          >
            {copy.cloudflareAbuse}
          </a>
        </div>
      </form>
      {submitted && <p role="status">{copy.abuseSuccess}</p>}
      {submitFailed && (
        <p role="alert" className="scan-error">
          {copy.abuseError}
        </p>
      )}
    </section>
  );
}
