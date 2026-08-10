import type { NarrativeEntityId } from "@/features/narrative-extraction/ir/inferences/codexEntityHypothesis";
import type { SetCodexBaseDetailProposal } from "@/features/narrative-extraction/proposals/setCodexBaseDetailProposal";
import type { ProjectedDetailValue } from "@/features/codex/details/semanticBindingTypes";
import {
  resolveCodexEntryId,
  type CommitMap,
  type DomainOperationBase,
} from "./compiler";

export type DetailValueOcc =
  | { readonly kind: "absent" }
  | { readonly kind: "version"; readonly version: number };

export interface SetCodexDetailValueOperationPayloadV1 {
  readonly detailValueId?: string;
  readonly entryId?: string;
  readonly narrativeEntityId: NarrativeEntityId;
  readonly definitionId: string;
  readonly value: string | null;
  readonly occ: DetailValueOcc;
}

export type SetCodexDetailValueOperationV1 = DomainOperationBase<
  "codex.detail.value.set",
  SetCodexDetailValueOperationPayloadV1
>;

export interface CompileSetCodexBaseDetailInput {
  readonly proposal: SetCodexBaseDetailProposal;
  readonly commitMap: CommitMap;
  readonly resolveDefinitionId: (definitionRef: string) => string;
  readonly encodeValue: (value: ProjectedDetailValue) => string | null;
  /** When updating an existing base value, pass its OCC version. */
  readonly existingVersion?: number;
  readonly detailValueId?: string;
  readonly entryId?: string;
}

/**
 * Compile a Base Detail set proposal into a domain operation.
 * Resolves entryId via CommitMap when not provided explicitly.
 */
export function compileSetCodexBaseDetailOperation(
  input: CompileSetCodexBaseDetailInput,
): SetCodexDetailValueOperationV1 {
  const narrativeEntityId = input.proposal.payload.narrativeEntityId;
  const entryId =
    input.entryId ?? resolveCodexEntryId(input.commitMap, narrativeEntityId);
  const definitionId = input.resolveDefinitionId(
    input.proposal.payload.definitionRef,
  );
  const value = input.encodeValue(input.proposal.payload.value);
  const occ: DetailValueOcc =
    input.existingVersion === undefined
      ? { kind: "absent" }
      : { kind: "version", version: input.existingVersion };

  return {
    kind: "codex.detail.value.set",
    payload: {
      detailValueId: input.detailValueId,
      entryId,
      narrativeEntityId,
      definitionId,
      value,
      occ,
    },
  };
}
