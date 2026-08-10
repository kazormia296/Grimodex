import type {
  CodexRelationHypothesis,
  CodexRelationValidity,
} from "../ir/inferences/codexRelationHypothesis";
import type { RelationDomainGateDecision } from "@/features/codex/extraction/relationSynthesis";

export const CODEX_RELATION_CREATE_PROPOSAL_KIND =
  "codex.relation.create" as const;

export interface ProposalBase<
  Kind extends string,
  Target,
  Payload,
> {
  readonly proposalId: string;
  readonly kind: Kind;
  readonly target: Target;
  readonly payload: Payload;
  readonly dependencies: readonly {
    readonly kind: "requires-resolution";
    readonly proposalId: string;
  }[];
}

export interface CreateCodexRelationProposalPayload {
  readonly subjectEntityId: string;
  readonly objectEntityId: string;
  readonly relation: {
    readonly relationType: string;
    readonly directionality: "directed" | "symmetric";
    readonly forwardLabel: string;
    readonly inverseLabel: string | null;
  };
  readonly validity: Extract<CodexRelationValidity, "timeless" | "current">;
}

export type CreateCodexRelationProposal = ProposalBase<
  typeof CODEX_RELATION_CREATE_PROPOSAL_KIND,
  {
    readonly kind: "new";
    readonly logicalRef: string;
  },
  CreateCodexRelationProposalPayload
>;

export interface CreateCodexRelationProposalInput {
  readonly hypothesis: CodexRelationHypothesis;
  readonly gate: RelationDomainGateDecision;
  readonly logicalRef: string;
  readonly relation: CreateCodexRelationProposalPayload["relation"];
  readonly dependencyProposalIds: readonly string[];
  readonly createId?: () => string;
}

/**
 * Build a Domain create proposal only when §16 gate says proposal.
 * Native commit / UI are out of scope for PR4.
 */
export function createCodexRelationProposalFromHypothesis(
  input: CreateCodexRelationProposalInput,
): CreateCodexRelationProposal | null {
  if (input.gate.kind !== "proposal") return null;
  if (input.relation.directionality === "symmetric") {
    const forward = input.relation.forwardLabel.trim();
    const inverse = input.relation.inverseLabel?.trim() ?? forward;
    if (!forward || inverse !== forward) return null;
  } else if (!input.relation.forwardLabel.trim()) {
    return null;
  }

  const createId = input.createId ?? (() => crypto.randomUUID());
  return {
    proposalId: createId(),
    kind: CODEX_RELATION_CREATE_PROPOSAL_KIND,
    target: { kind: "new", logicalRef: input.logicalRef },
    payload: {
      subjectEntityId: input.hypothesis.payload.subjectEntityId,
      objectEntityId: input.hypothesis.payload.objectEntityId,
      relation: {
        relationType: input.relation.relationType,
        directionality: input.relation.directionality,
        forwardLabel: input.relation.forwardLabel.trim(),
        inverseLabel:
          input.relation.directionality === "symmetric"
            ? input.relation.forwardLabel.trim()
            : (input.relation.inverseLabel?.trim() ?? null),
      },
      validity: input.gate.validity,
    },
    dependencies: input.dependencyProposalIds.map((proposalId) => ({
      kind: "requires-resolution" as const,
      proposalId,
    })),
  };
}
