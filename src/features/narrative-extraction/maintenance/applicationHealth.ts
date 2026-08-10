/**
 * 適用済み Domain データの現在状態。Artifact Freshness とは別軸。
 */
export type NarrativeApplicationHealth =
  | "supported"
  | "supported-after-reanchor"
  | "partially-supported"
  | "unsupported"
  | "contradicted"
  | "source-missing"
  | "target-modified"
  | "superseded"
  | "undone"
  | "unknown";

/** @deprecated Prefer NarrativeApplicationHealth */
export type NarrativeApplicationHealthStatus = NarrativeApplicationHealth;

export interface NarrativeApplicationHealthRecord {
  readonly schemaVersion: 1;
  readonly applicationId: string;
  readonly health: NarrativeApplicationHealth;
  readonly evaluatedAtSequence: number;
  readonly reasons: readonly string[];
}

/** Back-compat alias used by early stubs. */
export type NarrativeApplicationHealthSummary = NarrativeApplicationHealthRecord;
