/** Diagnostic codes for generic import capture (stable contract). */
export const CAPTURE_DIAG = {
  BUDGET_EXCEEDED: "capture-budget-exceeded",
  EMPTY_CAPTURE: "capture-empty",
  PATH_TOO_DEEP: "capture-path-too-deep",
  FILE_TOO_LARGE: "capture-file-too-large",
  TOO_MANY_FILES: "capture-too-many-files",
  SYMLINK_REJECTED: "capture-symlink-rejected",
  INVALID_PATH: "capture-invalid-path",
  DUPLICATE_ENTRY: "capture-duplicate-entry",
  SEAL_MISMATCH: "capture-seal-mismatch",
  DECODE_FAILED: "capture-decode-failed",
  ENCODING_AMBIGUOUS: "capture-encoding-ambiguous",
  UNSUPPORTED_KIND: "capture-unsupported-kind",
} as const;

export type CaptureDiagnosticCode =
  (typeof CAPTURE_DIAG)[keyof typeof CAPTURE_DIAG];
