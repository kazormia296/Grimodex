/**
 * Closed code for an audit export refused because an audited AI execution is
 * still running (DR-AAEX-1). The export never waits for it: waiting would hold
 * the quiescence lease, and with it every save and read, for as long as the
 * model takes.
 */
export const AI_AUDIT_EXPORT_AI_RUNNING = "AI_AUDIT_EXPORT_AI_RUNNING";

export class AiAuditExportBusyError extends Error {
  readonly code = AI_AUDIT_EXPORT_AI_RUNNING;

  constructor() {
    super(
      `${AI_AUDIT_EXPORT_AI_RUNNING}: an AI execution is still running; export after it finishes`,
    );
    this.name = "AiAuditExportBusyError";
  }
}

export function isAiAuditExportBusyError(
  error: unknown,
): error is AiAuditExportBusyError {
  return (
    error instanceof AiAuditExportBusyError ||
    (typeof error === "object" &&
      error !== null &&
      (error as { code?: unknown }).code === AI_AUDIT_EXPORT_AI_RUNNING)
  );
}
