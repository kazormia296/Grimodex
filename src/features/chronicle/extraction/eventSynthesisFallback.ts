import type { EventHypothesis } from "@/features/narrative-extraction/ir/inferences/eventHypothesis";
import type { RawChronicleEventObservation } from "@/features/narrative-extraction/ir/observations/eventOccurrence";
import {
  resolveReferencedObservationActuality,
  type ObservationActualityRejectionReason,
} from "./hypothesisActualityGate";

export interface RejectedSynthesisCluster {
  readonly clusterRef: string;
  readonly reason:
    | ObservationActualityRejectionReason
    | "unsupported-hypothesis-actuality";
}

export function synthesizeHypothesesFromClusters(
  clusters: readonly {
    readonly clusterRef: string;
    readonly observationRefs: readonly string[];
  }[],
  observations: readonly RawChronicleEventObservation[],
  createId: () => string,
): {
  readonly hypotheses: readonly EventHypothesis[];
  readonly rejectedClusters: readonly RejectedSynthesisCluster[];
} {
  const hypotheses: EventHypothesis[] = [];
  const rejectedClusters: RejectedSynthesisCluster[] = [];
  for (const cluster of clusters) {
    const support = resolveReferencedObservationActuality(
      cluster.observationRefs,
      observations,
    );
    if (!support.ok) {
      rejectedClusters.push({
        clusterRef: cluster.clusterRef,
        reason: support.reason,
      });
      continue;
    }
    const actuality = support.actuality;
    if (
      actuality !== "actual" &&
      actuality !== "attempted" &&
      actuality !== "prevented" &&
      actuality !== "rumored"
    ) {
      rejectedClusters.push({
        clusterRef: cluster.clusterRef,
        reason: "unsupported-hypothesis-actuality",
      });
      continue;
    }
    const refs = new Set(cluster.observationRefs);
    const primary = observations
      .filter((observation) => refs.has(observation.localId))
      .sort((left, right) =>
        left.localId < right.localId
          ? -1
          : left.localId > right.localId
            ? 1
            : 0,
      )[0]!;
    const title = primary.payload.predicate.replace(/。$/u, "").trim();
    hypotheses.push({
      hypothesisId: createId(),
      clusterRef: cluster.clusterRef,
      observationRefs: cluster.observationRefs,
      titleSuggestion: title.length <= 32 ? title : `${title.slice(0, 29)}...`,
      summary: primary.payload.predicate,
      actuality,
      significance: "major",
    });
  }
  return { hypotheses, rejectedClusters };
}
