import type { ResolvedEvidenceAnchor } from "@/features/narrative-extraction/evidence/types";
import type { EventHypothesis } from "@/features/narrative-extraction/ir/inferences/eventHypothesis";
import type { RawChronicleEventObservation } from "@/features/narrative-extraction/ir/observations/eventOccurrence";
import type { CreateChronicleEventProposalPayloadV1 } from "@/features/narrative-extraction/proposals/chronicleEventProposal";
import type { ChronicleExistingMatch } from "./existingEventMatcher";
import {
  checkHypothesisActuality,
  type RejectedHypothesisActuality,
} from "./hypothesisActualityGate";

export interface PlannedProposal {
  readonly proposal: CreateChronicleEventProposalPayloadV1;
  readonly match: ChronicleExistingMatch;
  readonly hypothesisId: string;
}

export interface ProposalPlannerInput {
  readonly hypotheses: readonly EventHypothesis[];
  readonly observations: readonly RawChronicleEventObservation[];
  readonly anchors: readonly ResolvedEvidenceAnchor[];
  readonly matchesByHypothesisId: ReadonlyMap<string, ChronicleExistingMatch>;
  readonly createId?: () => string;
}

function collectAnchorsForHypothesis(
  hypothesis: EventHypothesis,
  observations: readonly RawChronicleEventObservation[],
  anchorsByQuoteAndSource: Map<
    string,
    Map<string, ResolvedEvidenceAnchor | null>
  >,
): ResolvedEvidenceAnchor[] {
  const observationById = new Map(
    observations.map((observation) => [observation.localId, observation]),
  );
  const found: ResolvedEvidenceAnchor[] = [];
  const seen = new Set<string>();
  for (const observationRef of hypothesis.observationRefs) {
    const observation = observationById.get(observationRef);
    if (!observation) continue;
    for (const evidence of observation.evidence) {
      const anchor = anchorsByQuoteAndSource
        .get(evidence.sourceRef)
        ?.get(evidence.quote);
      if (!anchor || seen.has(anchor.id)) continue;
      seen.add(anchor.id);
      found.push(anchor);
    }
  }
  return found;
}

/**
 * Gate Event Hypotheses into Chronicle create proposals.
 * Requires actual/attempted/prevented + major/scene-level + ≥1 resolved evidence.
 * already-satisfied matches are omitted (completed elsewhere).
 */
export function planChronicleEventProposals(
  input: ProposalPlannerInput,
): readonly PlannedProposal[] {
  return planChronicleEventProposalsWithDiagnostics(input).planned;
}

export function planChronicleEventProposalsWithDiagnostics(
  input: ProposalPlannerInput,
): {
  readonly planned: readonly PlannedProposal[];
  readonly rejectedHypotheses: readonly RejectedHypothesisActuality[];
} {
  const createId = input.createId ?? (() => crypto.randomUUID());
  const anchorsByQuoteAndSource = new Map<
    string,
    Map<string, ResolvedEvidenceAnchor | null>
  >();
  for (const anchor of input.anchors) {
    const anchorsByQuote =
      anchorsByQuoteAndSource.get(anchor.sourceRef) ?? new Map();
    const existing = anchorsByQuote.get(anchor.quote);
    if (!anchorsByQuote.has(anchor.quote)) {
      anchorsByQuote.set(anchor.quote, anchor);
    } else if (
      existing === null ||
      existing?.documentRef !== anchor.documentRef
    ) {
      anchorsByQuote.set(anchor.quote, null);
    }
    anchorsByQuoteAndSource.set(anchor.sourceRef, anchorsByQuote);
  }

  const planned: PlannedProposal[] = [];
  const rejectedHypotheses: RejectedHypothesisActuality[] = [];
  for (const hypothesis of input.hypotheses) {
    const actualityCheck = checkHypothesisActuality(
      hypothesis,
      input.observations,
    );
    if (!actualityCheck.ok) {
      rejectedHypotheses.push({
        hypothesisId: hypothesis.hypothesisId,
        reason: actualityCheck.reason,
      });
      continue;
    }
    if (
      hypothesis.actuality !== "actual" &&
      hypothesis.actuality !== "attempted" &&
      hypothesis.actuality !== "prevented"
    ) {
      continue;
    }
    if (
      hypothesis.significance !== "major" &&
      hypothesis.significance !== "scene-level"
    ) {
      continue;
    }

    const match =
      input.matchesByHypothesisId.get(hypothesis.hypothesisId) ??
      ({ status: "none" } as const);
    if (match.status === "already-satisfied") continue;

    const anchors = collectAnchorsForHypothesis(
      hypothesis,
      input.observations,
      anchorsByQuoteAndSource,
    );
    if (anchors.length === 0) continue;

    const first = anchors[0];
    const documentRefs = [
      ...new Set(anchors.map((anchor) => anchor.documentRef)),
    ] as [string, ...string[]];

    const observationById = new Map(
      input.observations.map((observation) => [
        observation.localId,
        observation,
      ]),
    );
    const participantSurfaces = [
      ...new Set(
        hypothesis.observationRefs.flatMap((ref) => {
          const observation = observationById.get(ref);
          return (
            observation?.payload.participants.map(
              (participant) => participant.surface,
            ) ?? []
          );
        }),
      ),
    ];
    const locationSurface =
      hypothesis.observationRefs
        .map((ref) => observationById.get(ref)?.payload.locationSurface)
        .find((value): value is string => typeof value === "string") ?? null;
    const temporalExpressions = [
      ...new Set(
        hypothesis.observationRefs.flatMap((ref) => {
          const observation = observationById.get(ref);
          return observation?.payload.temporalExpressions ?? [];
        }),
      ),
    ];

    planned.push({
      hypothesisId: hypothesis.hypothesisId,
      match,
      proposal: {
        eventId: createId(),
        title: hypothesis.titleSuggestion,
        note: null,
        actuality: hypothesis.actuality,
        significance: hypothesis.significance,
        ...(hypothesis.semanticType
          ? { semanticType: hypothesis.semanticType }
          : {}),
        evidenceAnchorIds: [first.id, ...anchors.slice(1).map((a) => a.id)],
        evidenceDocumentRefs: documentRefs,
        disclosure: {
          // Spoiler-safe default: hide until first evidence document.
          secret: true,
          revealDocumentRef: first.documentRef,
        },
        unresolvedMetadata: {
          participantSurfaces,
          locationSurface,
          temporalExpressions,
        },
      },
    });
  }

  return { planned, rejectedHypotheses };
}
