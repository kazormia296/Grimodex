import { runEventSynthesisTask } from "@/application/narrative-extraction/aiTasks/runEventSynthesisTask";
import { runObservationExtractionTask } from "@/application/narrative-extraction/aiTasks/runObservationExtractionTask";
import { clusterEventObservations } from "@/features/chronicle/extraction/eventClustering";
import { matchExistingChronicleEvent } from "@/features/chronicle/extraction/existingEventMatcher";
import { mergeObservationsByEvidence } from "@/features/chronicle/extraction/observationMerger";
import { planChronicleEventProposals } from "@/features/chronicle/extraction/proposalPlanner";
import { chronicleEvidenceTupleKey } from "@/features/chronicle/extraction/evidenceTupleKey";
import { resolveEvidenceReference } from "@/features/narrative-extraction/evidence/resolveEvidence";
import type { ResolvedEvidenceAnchor } from "@/features/narrative-extraction/evidence/types";
import type { EventHypothesis } from "@/features/narrative-extraction/ir/inferences/eventHypothesis";
import type { RawChronicleEventObservation } from "@/features/narrative-extraction/ir/observations/eventOccurrence";
import {
  assertUniqueObservationLocalIds,
  rekeyObservationsForWindow,
} from "@/features/chronicle/extraction/windowExtractor";
import type { NarrativeEvalVersions } from "./replay";
import {
  CITATION_ID_OBSERVATION_CHRONICLE_EVAL_VERSIONS,
  OBSERVATION_CHRONICLE_EVAL_VERSIONS,
  type PrepareObservationEvalCaseOptions,
  prepareObservationEvalCase,
} from "./observationAdapter";
import type {
  PreparedProductionChronicleEvalCase,
  ProductionChronicleArtifacts,
  ProductionChroniclePipelineDeps,
} from "./productionChronicleTypes";
import type { NarrativeEvalCaseV1 } from "./types";

export const PRODUCTION_CHRONICLE_EVAL_VERSIONS: NarrativeEvalVersions = {
  prompt: `${OBSERVATION_CHRONICLE_EVAL_VERSIONS.prompt}+narrative-event-synthesize/1`,
  responseSchema: `${OBSERVATION_CHRONICLE_EVAL_VERSIONS.responseSchema}+event-hypothesis/1`,
  extractor: "chronicle-production-full-pipeline/1",
  parser: `${OBSERVATION_CHRONICLE_EVAL_VERSIONS.parser}+event-synthesis-normalizer/1`,
};

export const CITATION_ID_PRODUCTION_CHRONICLE_EVAL_VERSIONS: NarrativeEvalVersions =
  {
    prompt: `${CITATION_ID_OBSERVATION_CHRONICLE_EVAL_VERSIONS.prompt}+narrative-event-synthesize/1`,
    responseSchema: `${CITATION_ID_OBSERVATION_CHRONICLE_EVAL_VERSIONS.responseSchema}+event-hypothesis/1`,
    extractor: "chronicle-production-full-pipeline/citation-id-v2",
    parser: `${CITATION_ID_OBSERVATION_CHRONICLE_EVAL_VERSIONS.parser}+event-synthesis-normalizer/1`,
  };

export const CITATION_ID_PRODUCTION_EVAL_VERSIONS =
  CITATION_ID_PRODUCTION_CHRONICLE_EVAL_VERSIONS;

export async function prepareProductionChronicleEvalCase(
  evalCase: NarrativeEvalCaseV1,
  options: PrepareObservationEvalCaseOptions = {},
): Promise<PreparedProductionChronicleEvalCase> {
  const prepared = await prepareObservationEvalCase(evalCase, options);
  const versions =
    prepared.evidenceMode === "citation-id-v2"
      ? CITATION_ID_PRODUCTION_CHRONICLE_EVAL_VERSIONS
      : PRODUCTION_CHRONICLE_EVAL_VERSIONS;
  return { ...prepared, versions };
}

function evidenceFingerprint(sourceRef: string, quote: string): string {
  return chronicleEvidenceTupleKey(sourceRef, quote);
}

function documentIdForAnchor(
  prepared: PreparedProductionChronicleEvalCase,
  anchor: ResolvedEvidenceAnchor,
): string | null {
  return (
    prepared.fixture.snapshot.documents.find(
      (document) => document.ref === anchor.documentRef,
    )?.sourceKey ?? null
  );
}

export async function runProductionChroniclePipeline(
  prepared: PreparedProductionChronicleEvalCase,
  deps: ProductionChroniclePipelineDeps = {},
): Promise<ProductionChronicleArtifacts> {
  const createId = deps.createId ?? (() => crypto.randomUUID());
  const observe = deps.observeWithAi ?? runObservationExtractionTask;
  const synthesize = deps.synthesizeWithAi ?? runEventSynthesisTask;
  let parseFailureCount = 0;

  const collectedObservations: RawChronicleEventObservation[] = [];
  for (const [index, window] of prepared.windows.entries()) {
    const binding = prepared.evidenceSpanCatalogBindingsByWindowId?.get(
      window.windowId ?? "",
    );
    if (prepared.evidenceMode === "citation-id-v2" && !binding) {
      throw new Error(
        `Citation-ID production window has no exact binding: ${window.windowId ?? "<missing>"}`,
      );
    }
    const batch = await observe({
      windows: [window],
      projectId: `narrative-eval:${prepared.evalCase.id}`,
      createId,
      repairOnFailure: false,
      evidenceMode: prepared.evidenceMode,
      ...(binding ? { evidenceSpanCatalogBinding: binding } : {}),
      onParseStatus: (status) => {
        if (status === "invalid") parseFailureCount += 1;
      },
    });
    collectedObservations.push(
      ...rekeyObservationsForWindow(
        `eval-window-${String(index + 1).padStart(3, "0")}`,
        batch,
      ),
    );
  }
  assertUniqueObservationLocalIds(collectedObservations);

  const anchors: ResolvedEvidenceAnchor[] = [];
  let unresolvedEvidenceCount = 0;
  const resolutionSourceViews =
    prepared.evidenceMode === "citation-id-v2" && prepared.evidenceSpanCatalog
      ? prepared.evidenceSpanCatalog.entries.map((entry) => entry.sourceView)
      : prepared.sourceViews;
  for (const observation of collectedObservations) {
    for (const evidence of observation.evidence) {
      const resolution = await resolveEvidenceReference(evidence, {
        snapshot: prepared.fixture.snapshot,
        sourceViews: resolutionSourceViews,
        createAnchorId: createId,
      });
      if (resolution.status === "resolved") anchors.push(resolution.anchor);
      else unresolvedEvidenceCount += 1;
    }
  }

  const observations = mergeObservationsByEvidence(collectedObservations);
  const clusters = clusterEventObservations(observations);
  const observationById = new Map(
    observations.map((observation) => [observation.localId, observation]),
  );
  const hypotheses: EventHypothesis[] = [];
  for (const cluster of clusters) {
    const clusterObservations = cluster.observationRefs.flatMap((ref) => {
      const observation = observationById.get(ref);
      return observation ? [observation] : [];
    });
    const batch = await synthesize({
      clusterRef: cluster.clusterRef,
      observations: clusterObservations,
      projectId: `narrative-eval:${prepared.evalCase.id}`,
      createId,
      repairOnFailure: false,
      onParseStatus: (status) => {
        if (status === "invalid") parseFailureCount += 1;
      },
    });
    hypotheses.push(...batch);
  }

  const anchorsByEvidence = new Map<
    string,
    Map<string, ResolvedEvidenceAnchor | null>
  >();
  for (const anchor of anchors) {
    const anchorsByQuote = anchorsByEvidence.get(anchor.sourceRef) ?? new Map();
    const existing = anchorsByQuote.get(anchor.quote);
    if (!anchorsByQuote.has(anchor.quote)) {
      anchorsByQuote.set(anchor.quote, anchor);
    } else if (
      existing === null ||
      existing?.documentRef !== anchor.documentRef
    ) {
      anchorsByQuote.set(anchor.quote, null);
    }
    anchorsByEvidence.set(anchor.sourceRef, anchorsByQuote);
  }
  const matches = hypotheses.map((hypothesis) => {
    const evidenceDocumentSourceKeys: string[] = [];
    const provenanceKeys: string[] = [];
    for (const observationRef of hypothesis.observationRefs) {
      const observation = observationById.get(observationRef);
      if (!observation) continue;
      for (const evidence of observation.evidence) {
        const fingerprint = evidenceFingerprint(
          evidence.sourceRef,
          evidence.quote,
        );
        const anchor = anchorsByEvidence
          .get(evidence.sourceRef)
          ?.get(evidence.quote);
        if (!anchor) continue;
        provenanceKeys.push(fingerprint);
        const documentId = documentIdForAnchor(prepared, anchor);
        if (documentId) evidenceDocumentSourceKeys.push(documentId);
      }
    }
    return {
      hypothesisId: hypothesis.hypothesisId,
      match: matchExistingChronicleEvent(
        {
          hypothesis,
          evidenceDocumentSourceKeys: [...new Set(evidenceDocumentSourceKeys)],
          provenanceKeys,
        },
        [],
      ),
    };
  });
  const plannedProposals = planChronicleEventProposals({
    hypotheses,
    observations,
    anchors,
    matchesByHypothesisId: new Map(
      matches.map((entry) => [entry.hypothesisId, entry.match] as const),
    ),
    createId,
  });

  return {
    observations,
    anchors,
    clusters,
    hypotheses,
    matches,
    plannedProposals,
    parseFailureCount,
    unresolvedEvidenceCount,
  };
}

export {
  evaluateProductionChronicleArtifacts,
  isCertificationEligible,
} from "./productionChronicleScoring";
export type {
  PreparedProductionChronicleEvalCase,
  ProductionChronicleArtifacts,
  ProductionChronicleCertificationReportLike,
  ProductionChronicleEvaluation,
  ProductionChroniclePipelineDeps,
} from "./productionChronicleTypes";
