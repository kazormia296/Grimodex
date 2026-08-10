import type { ProposalBase } from "./createCodexRelationProposal";
import type {
  PhaseDetailWrite,
} from "@/features/codex/details/semanticBindingTypes";
import type { NarrativeEntityId } from "../ir/inferences/codexEntityHypothesis";
import type { KnowledgePhaseRef } from "@/features/codex/extraction/existingPhaseMatcher";

export const CODEX_PHASE_BIND_PROPOSAL_KIND = "codex.phase.bind" as const;

export type CodexPhaseBindingTarget =
  | {
      readonly kind: "new";
      readonly logicalRef: string;
    }
  | {
      readonly kind: "existing";
      readonly phaseRef: KnowledgePhaseRef;
    }
  | {
      readonly kind: "unresolved";
      readonly logicalRef: string;
    };

export type PhaseSummaryOverride =
  | { readonly kind: "leave" }
  | { readonly kind: "set"; readonly value: string | null };

export interface PhaseDetailOverrideItem {
  readonly definitionRef: string;
  readonly write: PhaseDetailWrite;
}

export type BindCodexPhaseBinding =
  | {
      readonly kind: "create-new";
      readonly phase: {
        readonly label: string;
        readonly anchorDocumentRef: string;
      };
    }
  | {
      readonly kind: "bind-existing";
      readonly phaseRef: KnowledgePhaseRef;
      readonly expectedVersion: number;
    }
  | {
      readonly kind: "unresolved";
      readonly candidates: readonly {
        readonly ref: KnowledgePhaseRef;
        readonly score: number;
      }[];
      readonly allowCreateNew: boolean;
    };

export interface BindCodexPhasePayload {
  readonly narrativeEntityId: NarrativeEntityId;
  readonly anchorDocumentRef: string;
  readonly labelSuggestion: string | null;
  readonly binding: BindCodexPhaseBinding;
  /**
   * Summary override defaults to leave. Never invent content/context overrides
   * in this slice (no contentOverride / contextModeOverride fields).
   */
  readonly summaryOverride: PhaseSummaryOverride;
  readonly detailOverrides: readonly PhaseDetailOverrideItem[];
}

export type BindCodexPhaseProposal = ProposalBase<
  typeof CODEX_PHASE_BIND_PROPOSAL_KIND,
  CodexPhaseBindingTarget,
  BindCodexPhasePayload
>;

export interface BindCodexPhaseProposalOptions {
  readonly proposalId?: string;
  readonly dependencies?: BindCodexPhaseProposal["dependencies"];
  readonly createId?: () => string;
  readonly logicalRef?: string;
}

function resolveId(options: BindCodexPhaseProposalOptions | undefined): string {
  return options?.proposalId ?? (options?.createId ?? (() => crypto.randomUUID()))();
}

function assertNoForbiddenOverrides(payload: BindCodexPhasePayload): void {
  const record = payload as BindCodexPhasePayload & Record<string, unknown>;
  if ("contentOverride" in record || "contextModeOverride" in record) {
    throw new Error(
      "BindCodexPhasePayload must not include contentOverride or contextModeOverride",
    );
  }
}

export function createNewBindCodexPhaseProposal(
  payload: Omit<BindCodexPhasePayload, "binding" | "summaryOverride"> & {
    readonly binding: Extract<BindCodexPhaseBinding, { kind: "create-new" }>;
    readonly summaryOverride?: PhaseSummaryOverride;
  },
  options?: BindCodexPhaseProposalOptions,
): BindCodexPhaseProposal {
  const full: BindCodexPhasePayload = {
    ...payload,
    summaryOverride: payload.summaryOverride ?? { kind: "leave" },
  };
  assertNoForbiddenOverrides(full);
  const proposalId = resolveId(options);
  return {
    proposalId,
    kind: CODEX_PHASE_BIND_PROPOSAL_KIND,
    target: {
      kind: "new",
      logicalRef: options?.logicalRef ?? `phase:${payload.narrativeEntityId}:${payload.anchorDocumentRef}`,
    },
    payload: full,
    dependencies: options?.dependencies ?? [],
  };
}

export function bindExistingCodexPhaseProposal(
  payload: Omit<BindCodexPhasePayload, "binding" | "summaryOverride"> & {
    readonly binding: Extract<BindCodexPhaseBinding, { kind: "bind-existing" }>;
    readonly summaryOverride?: PhaseSummaryOverride;
  },
  options?: BindCodexPhaseProposalOptions,
): BindCodexPhaseProposal {
  const full: BindCodexPhasePayload = {
    ...payload,
    summaryOverride: payload.summaryOverride ?? { kind: "leave" },
  };
  assertNoForbiddenOverrides(full);
  return {
    proposalId: resolveId(options),
    kind: CODEX_PHASE_BIND_PROPOSAL_KIND,
    target: {
      kind: "existing",
      phaseRef: payload.binding.phaseRef,
    },
    payload: full,
    dependencies: options?.dependencies ?? [],
  };
}

export function unresolvedBindCodexPhaseProposal(
  payload: Omit<BindCodexPhasePayload, "binding" | "summaryOverride"> & {
    readonly binding: Extract<BindCodexPhaseBinding, { kind: "unresolved" }>;
    readonly summaryOverride?: PhaseSummaryOverride;
  },
  options?: BindCodexPhaseProposalOptions,
): BindCodexPhaseProposal {
  const full: BindCodexPhasePayload = {
    ...payload,
    summaryOverride: payload.summaryOverride ?? { kind: "leave" },
  };
  assertNoForbiddenOverrides(full);
  return {
    proposalId: resolveId(options),
    kind: CODEX_PHASE_BIND_PROPOSAL_KIND,
    target: {
      kind: "unresolved",
      logicalRef:
        options?.logicalRef ??
        `phase:${payload.narrativeEntityId}:${payload.anchorDocumentRef}`,
    },
    payload: full,
    dependencies: options?.dependencies ?? [],
  };
}
