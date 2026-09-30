import type {
  ThreadDevelopmentInference,
  ThreadDevelopmentInferencePayload,
} from "@/features/narrative-extraction/ir/inferences/threadDevelopment";
import { isMaterialDevelopment } from "@/features/narrative-extraction/ir/inferences/threadDevelopment";
import type { DocumentRef } from "@/features/narrative-extraction/temporal/nodes";

export interface ThreadSignalIndexEntry {
  readonly developmentId: string;
  readonly documentRef: DocumentRef;
  readonly clusterKey: string;
  readonly payload: ThreadDevelopmentInferencePayload;
}

export interface ThreadSignalIndex {
  readonly entries: readonly ThreadSignalIndexEntry[];
  readonly byClusterKey: ReadonlyMap<string, readonly ThreadSignalIndexEntry[]>;
}

export interface BuildThreadSignalIndexOptions {
  /**
   * Resolves which candidate-thread cluster a development belongs to.
   * Cluster identity is owned upstream (entity/goal/conflict resolution);
   * this index only groups by whatever key the caller resolves. Returning
   * null drops the development (unresolved cluster).
   */
  readonly resolveClusterKey: (
    payload: ThreadDevelopmentInferencePayload,
  ) => string | null;
}

/**
 * Index material Thread Development inferences by resolved cluster key.
 * Background / mere-mention developments (isMaterialDevelopment === false)
 * are dropped before indexing, matching the marker-candidate gate discipline
 * in plot-threads/extraction/markerRoleAssigner.ts (not modified here).
 */
export function buildThreadSignalIndex(
  developments: readonly ThreadDevelopmentInference[],
  options: BuildThreadSignalIndexOptions,
): ThreadSignalIndex {
  const entries: ThreadSignalIndexEntry[] = [];
  const groups = new Map<string, ThreadSignalIndexEntry[]>();

  for (const development of developments) {
    if (development.kind !== "plot.thread-development") continue;
    if (!isMaterialDevelopment(development.payload)) continue;

    const clusterKey = options.resolveClusterKey(development.payload);
    if (!clusterKey) continue;

    const entry: ThreadSignalIndexEntry = {
      developmentId: development.payload.developmentId,
      documentRef: development.payload.documentRef,
      clusterKey,
      payload: development.payload,
    };
    entries.push(entry);

    const bucket = groups.get(clusterKey);
    if (bucket) bucket.push(entry);
    else groups.set(clusterKey, [entry]);
  }

  return { entries, byClusterKey: groups };
}
