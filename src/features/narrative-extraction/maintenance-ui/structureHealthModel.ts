import type { MaintenanceInboxEntry } from "@/application/narrative-extraction/nativeApi";

/** Freshness values that make a proposal "stale" (everything except `fresh`). */
export const STALE_BREAKDOWN_KEYS = [
  "stale",
  "source-missing",
  "anchor-mismatch",
  "read-set-drift",
  "unknown",
] as const;
export type StaleBreakdownKey = (typeof STALE_BREAKDOWN_KEYS)[number];

export interface StructureHealthSummary {
  /** Proposal rows whose freshness was readable (fresh and not fresh). */
  readonly proposalsChecked: number;
  /** Proposal rows whose evidence is not fresh; equals the breakdown sum. */
  readonly proposalsStale: number;
  readonly staleBreakdown: Readonly<Record<StaleBreakdownKey, number>>;
  /** Terminal-failure rows: maintenance stopped partway. */
  readonly maintenanceStopped: number;
  /**
   * Rows whose entry kind or consumer kind, or a proposal row's freshness,
   * was outside the known vocabulary. Counted apart, never folded into a
   * known bucket and never dropped.
   */
  readonly unrecognized: number;
  /** True when nothing at all was counted (not the same as "all is well"). */
  readonly nothingToInspect: boolean;
}

/**
 * Count the Inbox rows. A row is one consumer (one proposal revision), not a
 * scene or a passage. Only `proposal-revision` rows feed the proposal counts;
 * `terminal-failure` rows are counted on their own; every other consumer kind
 * (extraction runs, applications, indexes, other known kinds) is not a proposal
 * and is not counted. A consumer kind outside the known set is not "not a
 * proposal": it is unreadable, so it is counted as unrecognized.
 */
export function summarizeInbox(
  entries: readonly MaintenanceInboxEntry[],
): StructureHealthSummary {
  const staleBreakdown: Record<StaleBreakdownKey, number> = {
    stale: 0,
    "source-missing": 0,
    "anchor-mismatch": 0,
    "read-set-drift": 0,
    unknown: 0,
  };
  let proposalsChecked = 0;
  let maintenanceStopped = 0;
  let unrecognized = 0;

  for (const entry of entries) {
    if (entry.entryKind === "unrecognized") {
      unrecognized += 1;
    } else if (entry.entryKind === "terminal-failure") {
      maintenanceStopped += 1;
    } else if (entry.consumerKind === "unrecognized") {
      unrecognized += 1;
    } else if (entry.consumerKind === "proposal-revision") {
      const freshness = entry.evidenceFreshness;
      if (freshness === "fresh") {
        proposalsChecked += 1;
      } else if (freshness !== null && freshness !== "unrecognized") {
        proposalsChecked += 1;
        staleBreakdown[freshness] += 1;
      } else {
        unrecognized += 1;
      }
    }
  }

  const proposalsStale = STALE_BREAKDOWN_KEYS.reduce(
    (sum, key) => sum + staleBreakdown[key],
    0,
  );
  return {
    proposalsChecked,
    proposalsStale,
    staleBreakdown,
    maintenanceStopped,
    unrecognized,
    nothingToInspect:
      proposalsChecked === 0 && maintenanceStopped === 0 && unrecognized === 0,
  };
}
