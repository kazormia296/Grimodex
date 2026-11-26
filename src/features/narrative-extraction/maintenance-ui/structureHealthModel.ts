import type { MaintenanceHealthSummary } from "@/application/narrative-extraction/nativeApi";

/** Freshness values that make a proposal "stale" (everything except `fresh`). */
export const STALE_BREAKDOWN_KEYS = [
  "stale",
  "source-missing",
  "anchor-mismatch",
  "read-set-drift",
  "unknown",
] as const;
export type StaleBreakdownKey = (typeof STALE_BREAKDOWN_KEYS)[number];

/**
 * True when nothing at all was counted. This is not "all is well": there may
 * simply be nothing to check yet.
 */
export function isNothingToInspect(summary: MaintenanceHealthSummary): boolean {
  return (
    summary.proposalsChecked === 0 &&
    summary.maintenanceStopped === 0 &&
    summary.unrecognized === 0
  );
}
