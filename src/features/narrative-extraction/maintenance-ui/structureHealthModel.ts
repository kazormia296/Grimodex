import type { NarrativeApplicationHealth } from "../maintenance/applicationHealth";
import type { NarrativeFreshnessState } from "../maintenance/freshness";

export interface StructureHealthCount {
  readonly key: string;
  readonly labelKey: string;
  readonly count: number;
}

export interface StructureHealthSummaryModel {
  readonly mode: "deterministic" | "manual" | "idle-suggestions";
  readonly freshness: Readonly<Record<NarrativeFreshnessState, number>>;
  readonly applicationHealth: Readonly<
    Partial<Record<NarrativeApplicationHealth, number>>
  >;
  readonly backgroundAiDeferred: boolean;
  readonly deferredReason: string | null;
}

/** Demo / soft-entry summary used until Change Feed consumers are wired. */
export function buildPreviewStructureHealthSummary(): StructureHealthSummaryModel {
  return {
    mode: "deterministic",
    freshness: {
      fresh: 128,
      reanchorable: 4,
      "content-stale": 8,
      "context-stale": 3,
      "order-stale": 0,
      "catalog-stale": 0,
      "solver-stale": 0,
      "coverage-stale": 5,
      "target-stale": 0,
      "normalizer-mismatch": 0,
      "extractor-obsolete": 0,
      "source-missing": 2,
      unknown: 0,
    },
    applicationHealth: {
      supported: 120,
      "supported-after-reanchor": 4,
      "partially-supported": 3,
      unsupported: 2,
      contradicted: 1,
      "target-modified": 6,
      undone: 0,
    },
    backgroundAiDeferred: false,
    deferredReason: null,
  };
}

export function summarizeFreshnessCounts(
  model: StructureHealthSummaryModel,
): StructureHealthCount[] {
  return [
    {
      key: "fresh",
      labelKey: "narrativeMaintenance.health.fresh",
      count: model.freshness.fresh,
    },
    {
      key: "reanchorable",
      labelKey: "narrativeMaintenance.health.reanchorable",
      count: model.freshness.reanchorable,
    },
    {
      key: "content-stale",
      labelKey: "narrativeMaintenance.health.contentStale",
      count: model.freshness["content-stale"],
    },
    {
      key: "context-stale",
      labelKey: "narrativeMaintenance.health.contextStale",
      count: model.freshness["context-stale"],
    },
    {
      key: "coverage-stale",
      labelKey: "narrativeMaintenance.health.coverageStale",
      count: model.freshness["coverage-stale"],
    },
    {
      key: "source-missing",
      labelKey: "narrativeMaintenance.health.sourceMissing",
      count: model.freshness["source-missing"],
    },
  ];
}

/** Alias used by StructureHealthSummary. */
export const summarizeStructureHealth = summarizeFreshnessCounts;
