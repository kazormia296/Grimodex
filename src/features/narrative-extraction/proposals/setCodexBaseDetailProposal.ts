import type { ProposalBase } from "@/features/narrative-extraction/proposals/createCodexRelationProposal";
import type {
  PhaseDetailWrite,
  ProjectedDetailValue,
} from "@/features/codex/details/semanticBindingTypes";
import type { NarrativeEntityId } from "@/features/narrative-extraction/ir/inferences/codexEntityHypothesis";

export const CODEX_BASE_DETAIL_SET_PROPOSAL_KIND =
  "codex.detail.base.set" as const;

export type CodexBaseDetailTarget =
  | {
      readonly kind: "existing-entry";
      readonly entityRef: string;
    }
  | {
      readonly kind: "narrative-entity";
      readonly narrativeEntityId: NarrativeEntityId;
    };

export interface SetCodexBaseDetailPayload {
  readonly narrativeEntityId: NarrativeEntityId;
  readonly definitionRef: string;
  readonly facetKey: string;
  readonly value: ProjectedDetailValue;
  /**
   * Base Detail is only eligible for timeless facts, or corpus-initial current
   * when the extraction scope covers the full corpus opening.
   */
  readonly temporalEligibility: "timeless" | "corpus-initial";
}

export type SetCodexBaseDetailProposal = ProposalBase<
  typeof CODEX_BASE_DETAIL_SET_PROPOSAL_KIND,
  CodexBaseDetailTarget,
  SetCodexBaseDetailPayload
>;

export interface CreateSetCodexBaseDetailProposalInput {
  readonly narrativeEntityId: NarrativeEntityId;
  readonly definitionRef: string;
  readonly facetKey: string;
  readonly value: ProjectedDetailValue;
  readonly temporalEligibility: "timeless" | "corpus-initial";
  readonly target?: CodexBaseDetailTarget;
  readonly dependencyProposalIds?: readonly string[];
  readonly createId?: () => string;
}

/**
 * Build a Base Detail set proposal.
 * Rejects clear/inherit as Base set values — Base uses set or omit only.
 */
export function createSetCodexBaseDetailProposal(
  input: CreateSetCodexBaseDetailProposalInput,
): SetCodexBaseDetailProposal | null {
  if (input.value.kind === "clear") return null;
  if (!input.definitionRef.trim()) return null;

  const createId = input.createId ?? (() => crypto.randomUUID());
  return {
    proposalId: createId(),
    kind: CODEX_BASE_DETAIL_SET_PROPOSAL_KIND,
    target: input.target ?? {
      kind: "narrative-entity",
      narrativeEntityId: input.narrativeEntityId,
    },
    payload: {
      narrativeEntityId: input.narrativeEntityId,
      definitionRef: input.definitionRef,
      facetKey: input.facetKey,
      value: input.value,
      temporalEligibility: input.temporalEligibility,
    },
    dependencies: (input.dependencyProposalIds ?? []).map((proposalId) => ({
      kind: "requires-resolution" as const,
      proposalId,
    })),
  };
}

/** Type guard helper for Phase writes used by Base planners (set only). */
export function isSetWrite(
  write: PhaseDetailWrite,
): write is Extract<PhaseDetailWrite, { kind: "set" }> {
  return write.kind === "set";
}
