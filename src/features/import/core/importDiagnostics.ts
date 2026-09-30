export type ImportDiagnosticSeverity = "info" | "warn" | "error";

export interface ImportDiagnostic {
  readonly severity: ImportDiagnosticSeverity;
  readonly code: string;
  readonly message: string;
  readonly path?: string;
}

export function importDiagnostic(
  severity: ImportDiagnosticSeverity,
  code: string,
  message: string,
  path?: string,
): ImportDiagnostic {
  return path ? { severity, code, message, path } : { severity, code, message };
}

export function hasImportErrors(
  diagnostics: readonly ImportDiagnostic[],
): boolean {
  return diagnostics.some((d) => d.severity === "error");
}
