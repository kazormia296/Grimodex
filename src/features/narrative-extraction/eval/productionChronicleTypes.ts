import type { RunEventSynthesisTaskInput } from "@/application/narrative-extraction/aiTasks/runEventSynthesisTask";
import type { RunObservationExtractionTaskInput } from "@/application/narrative-extraction/aiTasks/runObservationExtractionTask";
import type { clusterEventObservations } from "@/features/chronicle/extraction/eventClustering";
import type { ChronicleExistingMatch } from "@/features/chronicle/extraction/existingEventMatcher";
import type { PlannedProposal } from "@/features/chronicle/extraction/proposalPlanner";
import type { ResolvedEvidenceAnchor } from "@/features/narrative-extraction/evidence/types";
import type { EventHypothesis } from "@/features/narrative-extraction/ir/inferences/eventHypothesis";
import type { RawChronicleEventObservation } from "@/features/narrative-extraction/ir/observations/eventOccurrence";
import type { PreparedObservationEvalCase } from "./observationAdapter";
import type { NarrativeEvalVersions } from "./replay";
import type { NarrativeActualGraph, NarrativeEvalCaseScore } from "./types";

export interface PreparedProductionChronicleEvalCase extends Omit<
  PreparedObservationEvalCase,
  "versions"
> {
  readonly versions: NarrativeEvalVersions;
}

export interface ProductionChronicleArtifacts {
  readonly observations: readonly RawChronicleEventObservation[];
  readonly anchors: readonly ResolvedEvidenceAnchor[];
  readonly clusters: ReturnType<typeof clusterEventObservations>;
  readonly hypotheses: readonly EventHypothesis[];
  readonly matches: readonly {
    readonly hypothesisId: string;
    readonly match: ChronicleExistingMatch;
  }[];
  readonly plannedProposals: readonly PlannedProposal[];
  readonly parseFailureCount: number;
  readonly unresolvedEvidenceCount: number;
}

export interface ProductionChroniclePipelineDeps {
  readonly observeWithAi?: (
    input: RunObservationExtractionTaskInput,
  ) => Promise<readonly RawChronicleEventObservation[]>;
  readonly synthesizeWithAi?: (
    input: RunEventSynthesisTaskInput,
  ) => Promise<readonly EventHypothesis[]>;
  readonly createId?: () => string;
}

export interface ProductionChronicleEvaluation extends NarrativeEvalCaseScore {
  readonly actual: NarrativeActualGraph;
  readonly parseFailureCount: number;
  readonly unresolvedEvidenceCount: number;
}

export interface ProductionChronicleCertificationReportLike {
  readonly diagnosticOnly?: boolean;
  readonly cases: readonly {
    readonly evaluation: ProductionChronicleEvaluation;
  }[];
}
