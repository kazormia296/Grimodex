import type { NarrativeEntityId } from "@/features/narrative-extraction/ir/inferences/codexEntityHypothesis";
import type {
  BindCodexPhaseProposal,
  PhaseDetailOverrideItem,
  PhaseSummaryOverride,
} from "@/features/narrative-extraction/proposals/bindCodexPhaseProposal";
import type { PhaseDetailWrite } from "@/features/codex/details/semanticBindingTypes";
import {
  resolveCodexEntryId,
  type CommitMap,
  type DomainOperationBase,
} from "./compiler";

export interface PhaseDetailOverrideExactAfter {
  readonly definitionId: string;
  readonly value: string | null;
}

export interface CreateCodexPhaseOperationPayloadV1 {
  readonly phaseId: string;
  readonly entryId?: string;
  readonly narrativeEntityId: NarrativeEntityId;
  readonly anchorNodeId: string | null;
  readonly label: string;
  readonly summaryOverride: string | null;
  readonly detailOverrides: readonly PhaseDetailOverrideExactAfter[];
}

export type CreateCodexPhaseOperationV1 = DomainOperationBase<
  "codex.phase.create",
  CreateCodexPhaseOperationPayloadV1
>;

export type PhaseSummaryPatch =
  | { readonly kind: "leave" }
  | { readonly kind: "set"; readonly value: string | null };

export interface PatchCodexPhaseOperationPayloadV1 {
  readonly phaseId: string;
  readonly baseVersion: number;
  readonly label?: string;
  readonly summary: PhaseSummaryPatch;
  readonly detailOverrides: readonly PhaseDetailOverrideExactAfter[];
}

export type PatchCodexPhaseOperationV1 = DomainOperationBase<
  "codex.phase.patch",
  PatchCodexPhaseOperationPayloadV1
>;

export interface CompilePhaseCreateInput {
  readonly proposal: BindCodexPhaseProposal;
  readonly commitMap: CommitMap;
  readonly resolveDefinitionId: (definitionRef: string) => string;
  readonly encodeWrite: (
    definitionId: string,
    write: PhaseDetailWrite,
  ) => string | null | undefined;
  readonly resolveAnchorNodeId?: (documentRef: string) => string | null;
  readonly phaseId?: string;
  readonly entryId?: string;
}

export interface CompilePhasePatchInput {
  readonly proposal: BindCodexPhaseProposal;
  readonly baseVersion: number;
  readonly phaseId: string;
  readonly existingOverrides: readonly PhaseDetailOverrideExactAfter[];
  readonly resolveDefinitionId: (definitionRef: string) => string;
  readonly encodeWrite: (
    definitionId: string,
    write: PhaseDetailWrite,
  ) => string | null | undefined;
}

function toSummaryOverride(
  summary: PhaseSummaryOverride,
): string | null | undefined {
  if (summary.kind === "leave") return undefined;
  return summary.value;
}

function applyDetailWrites(
  existing: readonly PhaseDetailOverrideExactAfter[],
  writes: readonly PhaseDetailOverrideItem[],
  resolveDefinitionId: (definitionRef: string) => string,
  encodeWrite: (
    definitionId: string,
    write: PhaseDetailWrite,
  ) => string | null | undefined,
): PhaseDetailOverrideExactAfter[] {
  const map = new Map(
    existing.map((row) => [row.definitionId, row.value] as const),
  );
  for (const item of writes) {
    const definitionId = resolveDefinitionId(item.definitionRef);
    if (item.write.kind === "inherit") {
      map.delete(definitionId);
      continue;
    }
    const encoded = encodeWrite(definitionId, item.write);
    if (encoded === undefined) continue;
    map.set(definitionId, encoded);
  }
  return Array.from(map.entries()).map(([definitionId, value]) => ({
    definitionId,
    value,
  }));
}

/**
 * Compile create-new BindCodexPhase into codex.phase.create.
 * Forces contentOverride / contextMode null at the native layer.
 */
export function compileCreateCodexPhaseOperation(
  input: CompilePhaseCreateInput,
): CreateCodexPhaseOperationV1 {
  const binding = input.proposal.payload.binding;
  if (binding.kind !== "create-new") {
    throw new Error("compileCreateCodexPhaseOperation requires create-new binding");
  }
  const narrativeEntityId = input.proposal.payload.narrativeEntityId;
  const entryId =
    input.entryId ?? resolveCodexEntryId(input.commitMap, narrativeEntityId);
  const summary = toSummaryOverride(input.proposal.payload.summaryOverride);
  const detailOverrides = applyDetailWrites(
    [],
    input.proposal.payload.detailOverrides,
    input.resolveDefinitionId,
    input.encodeWrite,
  );
  const anchorDocumentRef = binding.phase.anchorDocumentRef;
  const anchorNodeId =
    input.resolveAnchorNodeId?.(anchorDocumentRef) ?? null;

  return {
    kind: "codex.phase.create",
    payload: {
      phaseId: input.phaseId ?? crypto.randomUUID(),
      entryId,
      narrativeEntityId,
      anchorNodeId,
      label: binding.phase.label,
      summaryOverride: summary ?? null,
      detailOverrides,
    },
  };
}

/**
 * Compile bind-existing BindCodexPhase into codex.phase.patch (aggregate OCC).
 */
export function compilePatchCodexPhaseOperation(
  input: CompilePhasePatchInput,
): PatchCodexPhaseOperationV1 {
  const binding = input.proposal.payload.binding;
  if (binding.kind !== "bind-existing") {
    throw new Error("compilePatchCodexPhaseOperation requires bind-existing binding");
  }
  const summary = input.proposal.payload.summaryOverride;
  const detailOverrides = applyDetailWrites(
    input.existingOverrides,
    input.proposal.payload.detailOverrides,
    input.resolveDefinitionId,
    input.encodeWrite,
  );
  const labelSuggestion = input.proposal.payload.labelSuggestion;

  return {
    kind: "codex.phase.patch",
    payload: {
      phaseId: input.phaseId,
      baseVersion: input.baseVersion,
      label: labelSuggestion?.trim() ? labelSuggestion.trim() : undefined,
      summary:
        summary.kind === "leave"
          ? { kind: "leave" }
          : { kind: "set", value: summary.value },
      detailOverrides,
    },
  };
}
