import type {
  EntityBindingCandidate,
  KnowledgeEntityRef,
  KnowledgeTypeRef,
  NarrativeEntityId,
} from "../ir/inferences/codexEntityHypothesis";
import type { CoarseEntityClass } from "../ir/observations/entityIdentity";
import type { ProposalBase } from "./createCodexRelationProposal";

export const CODEX_ENTITY_BIND_PROPOSAL_KIND = "codex.entity.bind" as const;

export interface AliasCandidate {
  readonly surface: string;
  readonly status:
    | "explicit"
    | "coreference-only"
    | "user-confirmation-required";
}

export type CodexEntityBindingTarget =
  | {
      readonly kind: "new";
      readonly logicalRef: string;
    }
  | {
      readonly kind: "existing";
      readonly entityRef: KnowledgeEntityRef;
    }
  | {
      readonly kind: "unresolved";
      readonly logicalRef: string;
    };

export type BindCodexEntityTypeResolution =
  | {
      readonly status: "resolved";
      readonly typeRef: KnowledgeTypeRef;
    }
  | {
      readonly status: "ambiguous";
      readonly candidates: readonly KnowledgeTypeRef[];
    }
  | {
      readonly status: "unresolved";
    };

export type BindCodexEntityBinding =
  | {
      readonly kind: "create-new";
      readonly entry: {
        readonly name: string;
        readonly aliases: readonly string[];
        readonly summary: string | null;
      };
    }
  | {
      readonly kind: "bind-existing";
      readonly entityRef: KnowledgeEntityRef;
      readonly enrichment: {
        readonly aliasesToAdd: readonly string[];
        readonly summary:
          | { readonly kind: "leave" }
          | { readonly kind: "fill-if-empty"; readonly value: string };
      };
    }
  | {
      readonly kind: "unresolved";
      readonly candidates: readonly EntityBindingCandidate[];
      readonly allowCreateNew: boolean;
    };

export interface BindCodexEntityPayload {
  readonly narrativeEntityId: NarrativeEntityId;
  readonly canonicalName: string;
  readonly aliases: readonly AliasCandidate[];
  readonly coarseClass: CoarseEntityClass;
  readonly typeResolution: BindCodexEntityTypeResolution;
  readonly binding: BindCodexEntityBinding;
}

export type BindCodexEntityProposal = ProposalBase<
  typeof CODEX_ENTITY_BIND_PROPOSAL_KIND,
  CodexEntityBindingTarget,
  BindCodexEntityPayload
>;

export interface BindCodexEntityProposalOptions {
  readonly proposalId?: string;
  readonly dependencies?: BindCodexEntityProposal["dependencies"];
  readonly createId?: () => string;
}

function resolveId(
  options: BindCodexEntityProposalOptions | undefined,
): string {
  return (
    options?.proposalId ?? (options?.createId ?? (() => crypto.randomUUID()))()
  );
}

/** Build a create-new binding proposal (new Codex Entry). */
export function createNewBindCodexEntityProposal(
  payload: Omit<BindCodexEntityPayload, "binding"> & {
    readonly binding: Extract<BindCodexEntityBinding, { kind: "create-new" }>;
  },
  options?: BindCodexEntityProposalOptions & {
    readonly logicalRef?: string;
  },
): BindCodexEntityProposal {
  const proposalId = resolveId(options);
  return {
    proposalId,
    kind: CODEX_ENTITY_BIND_PROPOSAL_KIND,
    target: {
      kind: "new",
      logicalRef: options?.logicalRef ?? payload.narrativeEntityId,
    },
    payload,
    dependencies: options?.dependencies ?? [],
  };
}

/** Build a bind-existing proposal (optional alias / empty-summary enrichment). */
export function bindExistingCodexEntityProposal(
  payload: Omit<BindCodexEntityPayload, "binding"> & {
    readonly binding: Extract<
      BindCodexEntityBinding,
      { kind: "bind-existing" }
    >;
  },
  options?: BindCodexEntityProposalOptions,
): BindCodexEntityProposal {
  return {
    proposalId: resolveId(options),
    kind: CODEX_ENTITY_BIND_PROPOSAL_KIND,
    target: {
      kind: "existing",
      entityRef: payload.binding.entityRef,
    },
    payload,
    dependencies: options?.dependencies ?? [],
  };
}

/** Build an unresolved binding proposal (user must pick create / existing). */
export function unresolvedBindCodexEntityProposal(
  payload: Omit<BindCodexEntityPayload, "binding"> & {
    readonly binding: Extract<BindCodexEntityBinding, { kind: "unresolved" }>;
  },
  options?: BindCodexEntityProposalOptions & {
    readonly logicalRef?: string;
  },
): BindCodexEntityProposal {
  return {
    proposalId: resolveId(options),
    kind: CODEX_ENTITY_BIND_PROPOSAL_KIND,
    target: {
      kind: "unresolved",
      logicalRef: options?.logicalRef ?? payload.narrativeEntityId,
    },
    payload,
    dependencies: options?.dependencies ?? [],
  };
}
