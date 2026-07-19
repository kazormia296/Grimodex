import { scanMessages } from "../i18n/scanMessages";
import type { ScanLocale } from "../i18n/scanLocale";

interface ScanDeleteDialogProps {
  locale: ScanLocale;
  busy: boolean;
  error?: string;
  onCancel: () => void;
  onConfirm: () => void;
}

export function ScanDeleteDialog({
  locale,
  busy,
  error,
  onCancel,
  onConfirm,
}: ScanDeleteDialogProps) {
  const copy = scanMessages(locale).deletion;

  return (
    <div className="scan-consent-backdrop" role="presentation">
      <section
        className="scan-consent-dialog scan-delete-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="scan-delete-title"
      >
        <header>
          <p className="scan-eyebrow">Grimodex Scan</p>
          <h2 id="scan-delete-title">{copy.title}</h2>
        </header>
        <div className="scan-delete-dialog__body">
          <p>{copy.body}</p>
          <p className="scan-muted">{copy.caveat}</p>
          {error && (
            <p className="scan-error" role="alert">
              {error}
            </p>
          )}
        </div>
        <footer className="scan-consent-actions">
          <button
            type="button"
            className="scan-secondary"
            autoFocus
            disabled={busy}
            onClick={onCancel}
          >
            {copy.cancel}
          </button>
          <button
            type="button"
            className="scan-danger"
            disabled={busy}
            onClick={onConfirm}
          >
            {busy ? copy.deleting : copy.action}
          </button>
        </footer>
      </section>
    </div>
  );
}
