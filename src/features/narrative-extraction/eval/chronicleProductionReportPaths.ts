import path from "node:path";

export interface ChronicleProductionStableReportRootOptions {
  readonly repoRoot: string;
  readonly diagnosticOnly: boolean;
  readonly localQualification: boolean;
}

/**
 * Return the archived stable-report directory only for the normative,
 * non-local Chronicle run. Diagnostic and local qualification reports must
 * remain scoped to their run-specific artifact directory.
 */
export function chronicleProductionStableReportRoot({
  repoRoot,
  diagnosticOnly,
  localQualification,
}: ChronicleProductionStableReportRootOptions): string | null {
  if (diagnosticOnly || localQualification) return null;
  return path.join(
    repoRoot,
    ".artifacts",
    "narrative-eval",
    "chronicle-production-live",
  );
}
