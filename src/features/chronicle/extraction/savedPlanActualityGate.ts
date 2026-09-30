import type { EventHypothesis } from "@/features/narrative-extraction/ir/inferences/eventHypothesis";
import type { RawChronicleEventObservation } from "@/features/narrative-extraction/ir/observations/eventOccurrence";
import type { CreateChronicleEventProposalPayloadV1 } from "@/features/narrative-extraction/proposals/chronicleEventProposal";
import { checkHypothesisActuality } from "./hypothesisActualityGate";

export const CHRONICLE_REANALYSIS_REQUIRED_CODE =
  "NEX_CHRONICLE_REANALYSIS_REQUIRED";

export function isChronicleReanalysisRequired(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.startsWith(`${CHRONICLE_REANALYSIS_REQUIRED_CODE}:`)
  );
}

interface SavedPlanActualityInput {
  readonly alreadySatisfied?: readonly { readonly hypothesisId: string }[];
  readonly proposalPayloads?: readonly CreateChronicleEventProposalPayloadV1[];
  readonly planned?: readonly {
    readonly hypothesisId: string;
    readonly proposal: CreateChronicleEventProposalPayloadV1;
  }[];
  readonly hypotheses?: readonly EventHypothesis[];
  readonly observations?: readonly RawChronicleEventObservation[];
  readonly currentProposals: readonly CreateChronicleEventProposalPayloadV1[];
}

/** Old terminal sets are immutable: require reanalysis instead of shrinking saved history. */
export function assertSavedPlanActualitySupport(
  input: SavedPlanActualityInput,
): void {
  try {
    validateSavedPlanActualitySupport(input);
  } catch {
    throw new Error(
      `${CHRONICLE_REANALYSIS_REQUIRED_CODE}: saved Chronicle proposals lack consistent Observation/Hypothesis actuality support; start a new extraction run`,
    );
  }
}

function validateSavedPlanActualitySupport(
  input: SavedPlanActualityInput,
): void {
  const fail = (): never => {
    throw new Error(
      "NEX_CHRONICLE_REANALYSIS_REQUIRED: saved Chronicle proposals lack consistent Observation/Hypothesis actuality support; start a new extraction run",
    );
  };
  if (input.alreadySatisfied !== undefined) {
    if (!Array.isArray(input.alreadySatisfied)) fail();
    const seenHypotheses = new Set<string>();
    for (const row of input.alreadySatisfied) {
      if (
        !Array.isArray(input.hypotheses) ||
        !Array.isArray(input.observations)
      )
        fail();
      const hypotheses = input.hypotheses!.filter(
        (hypothesis) => hypothesis.hypothesisId === row.hypothesisId,
      );
      if (hypotheses.length !== 1 || seenHypotheses.has(row.hypothesisId))
        fail();
      seenHypotheses.add(row.hypothesisId);
      if (!checkHypothesisActuality(hypotheses[0]!, input.observations!).ok)
        fail();
    }
  }
  if (
    input.currentProposals.length === 0 &&
    (input.planned?.length ?? 0) === 0 &&
    (input.proposalPayloads?.length ?? 0) === 0
  )
    return;
  if (
    !Array.isArray(input.proposalPayloads) ||
    !Array.isArray(input.planned) ||
    !Array.isArray(input.hypotheses) ||
    !Array.isArray(input.observations) ||
    input.planned.length !== input.currentProposals.length ||
    input.proposalPayloads.length !== input.currentProposals.length
  )
    fail();
  const seenEvents = new Set<string>();
  for (const row of input.planned!) {
    const hypotheses = input.hypotheses!.filter(
      (hypothesis) => hypothesis.hypothesisId === row.hypothesisId,
    );
    const original = input.proposalPayloads!.filter(
      (proposal) => proposal.eventId === row.proposal.eventId,
    );
    const current = input.currentProposals.filter(
      (proposal) => proposal.eventId === row.proposal.eventId,
    );
    if (
      hypotheses.length !== 1 ||
      original.length !== 1 ||
      current.length !== 1 ||
      seenEvents.has(row.proposal.eventId)
    )
      fail();
    seenEvents.add(row.proposal.eventId);
    const hypothesis = hypotheses[0]!;
    if (
      !checkHypothesisActuality(hypothesis, input.observations!).ok ||
      hypothesis.actuality === "rumored" ||
      row.proposal.actuality !== hypothesis.actuality ||
      original[0]!.actuality !== hypothesis.actuality ||
      current[0]!.actuality !== hypothesis.actuality
    )
      fail();
  }
}
