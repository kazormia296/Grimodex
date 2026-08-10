import { meetsNewThreadMinimum } from "./markerRoleAssigner";
import type { ThreadSignalIndex } from "./signalIndex";

export interface PlotThreadSeedManifestEntry {
  readonly seedId: string;
  readonly clusterKey: string;
  readonly developmentIds: readonly string[];
  /** Distinct, sorted documentRefs the cluster's developments occur in. */
  readonly documentRefs: readonly string[];
  /** meetsNewThreadMinimum result (does not itself decide binding). */
  readonly meetsNewThreadMinimum: boolean;
}

export interface PlotThreadSeedManifest {
  readonly entries: readonly PlotThreadSeedManifestEntry[];
}

export interface BuildPlotThreadSeedManifestOptions {
  readonly createId?: () => string;
  /** Core-concern evidence is owned upstream (IR core); resolved per cluster. */
  readonly resolveHasCoreConcern: (clusterKey: string) => boolean;
  /** Count of resolved, exact (non-ambiguous) evidence anchors for the cluster. */
  readonly resolveExactEvidenceSites: (clusterKey: string) => number;
}

/**
 * One seed manifest row per signal-index cluster. Each row is a candidate
 * unit of work for narrative_plot_thread_synthesize; `meetsNewThreadMinimum`
 * only reports the deterministic gate result (reused, not modified) so the
 * proposal planner can decide whether the seed can become a *new* thread.
 */
export function buildPlotThreadSeedManifest(
  index: ThreadSignalIndex,
  options: BuildPlotThreadSeedManifestOptions,
): PlotThreadSeedManifest {
  const createId = options.createId ?? (() => crypto.randomUUID());
  const entries: PlotThreadSeedManifestEntry[] = [];

  for (const [clusterKey, bucket] of index.byClusterKey) {
    const documentRefs = [
      ...new Set(bucket.map((entry) => entry.documentRef)),
    ].sort((a, b) => a.localeCompare(b));
    const hasCoreConcern = options.resolveHasCoreConcern(clusterKey);
    const exactEvidenceSites = options.resolveExactEvidenceSites(clusterKey);

    entries.push({
      seedId: createId(),
      clusterKey,
      developmentIds: bucket.map((entry) => entry.developmentId),
      documentRefs,
      meetsNewThreadMinimum: meetsNewThreadMinimum({
        materialDevelopmentCount: bucket.length,
        distinctSceneCount: documentRefs.length,
        hasCoreConcern,
        exactEvidenceSites,
      }),
    });
  }

  return { entries };
}
