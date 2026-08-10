import { buildCodexRelationSemanticKey } from "@/features/codex/extraction/relationVocabulary";
import type { NarrativeEntityId } from "@/features/narrative-extraction/ir/inferences/codexEntityHypothesis";
import type {
  CreateCodexRelationProposal,
  CreateCodexRelationProposalPayload,
} from "@/features/narrative-extraction/proposals/createCodexRelationProposal";
import type { SetCodexDetailValueOperationV1 } from "./detailCompiler";
import type {
  CreateCodexPhaseOperationV1,
  PatchCodexPhaseOperationV1,
} from "./phaseCompiler";

export type CodexDomainOperationKind =
  | "codex.entry.create"
  | "codex.entry.patch"
  | "codex.entity.bind-existing"
  | "codex.relation.create";  | "codex.relation.create"
  | "codex.detail.value.set"
  | "codex.phase.create"
  | "codex.phase.patch"
  | "codex.semantic_binding.upsert";>>>>>>> 83db4ffb (feat(codex): add State Track, Phase Boundary, and Detail projection extractors)

export interface DomainOperationBase<TKind extends string, TPayload> {
  readonly kind: TKind;
  readonly payload: TPayload;
}

export interface CreateCodexEntryOperationPayloadV1 {
  readonly entryId: string;
  readonly typeSlug: string;
  readonly name: string;
  readonly summary: string | null;
  readonly aliases: readonly string[];
  readonly parentId: null;
  readonly content: '{"type":"doc","content":[]}';
  readonly narrativeEntityId: NarrativeEntityId;
}

export type CreateCodexEntryOperationV1 = DomainOperationBase<
  "codex.entry.create",
  CreateCodexEntryOperationPayloadV1
>;

export type PatchCollection<T> =
  | { readonly kind: "leave" }
  | { readonly kind: "set"; readonly values: readonly T[] };

export type PatchField<T> =
  | { readonly kind: "leave" }
  | { readonly kind: "set"; readonly value: T }
  | { readonly kind: "fill-if-empty"; readonly value: T };

export interface PatchCodexEntryOperationPayloadV1 {
  readonly entryId: string;
  readonly baseVersion: number;
  readonly aliases: PatchCollection<string>;
  readonly summary: PatchField<string>;
  readonly name: { readonly kind: "leave" };
  readonly typeSlug: { readonly kind: "leave" };
  readonly parentId: { readonly kind: "leave" };
  readonly narrativeEntityId: NarrativeEntityId;
}

export type PatchCodexEntryOperationV1 = DomainOperationBase<
  "codex.entry.patch",
  PatchCodexEntryOperationPayloadV1
>;

export interface BindExistingCodexEntityOperationPayloadV1 {
  readonly entryId: string;
  readonly narrativeEntityId: NarrativeEntityId;
  readonly baseVersion: number;
}

export type BindExistingCodexEntityOperationV1 = DomainOperationBase<
  "codex.entity.bind-existing",
  BindExistingCodexEntityOperationPayloadV1
>;

export interface CreateCodexRelationOperationPayloadV1 {
  readonly relationId: string;
  readonly fromCodexId?: string;
  readonly toCodexId?: string;
  readonly subjectEntityId: NarrativeEntityId;
  readonly objectEntityId: NarrativeEntityId;
  readonly relationType: string;
  readonly directionality: "directed" | "symmetric";
  readonly forwardLabel: string;
  readonly inverseLabel: string | null;
  readonly semanticKey?: string;
}

export type CreateCodexRelationOperationV1 = DomainOperationBase<
  "codex.relation.create",
  CreateCodexRelationOperationPayloadV1
>;

export type CodexDomainOperationV1 =
  | CreateCodexEntryOperationV1
  | PatchCodexEntryOperationV1
  | BindExistingCodexEntityOperationV1
  | CreateCodexRelationOperationV1;  | CreateCodexRelationOperationV1
  | SetCodexDetailValueOperationV1
  | CreateCodexPhaseOperationV1
  | PatchCodexPhaseOperationV1;>>>>>>> 83db4ffb (feat(codex): add State Track, Phase Boundary, and Detail projection extractors)

export interface CodexEntityBinding {
  readonly narrativeEntityId: NarrativeEntityId;
  readonly codexEntryId: string;
  readonly source: "created" | "existing";
  readonly applicationId?: string;
}

export interface CommitMap {
  readonly entityBindings: Readonly<
    Record<NarrativeEntityId, CodexEntityBinding>
  >;
}

export interface BindCreateNewInput {
  readonly narrativeEntityId: NarrativeEntityId;
  readonly typeSlug: string;
  readonly name: string;
  readonly aliases: readonly string[];
  readonly summary: string | null;
  readonly entryId?: string;
}

export interface BindExistingPatchInput {
  readonly narrativeEntityId: NarrativeEntityId;
  readonly entryId: string;
  readonly baseVersion: number;
  readonly aliasesToAdd: readonly string[];
  readonly existingAliases: readonly string[];
  readonly summary:
    | { readonly kind: "leave" }
    | { readonly kind: "fill-if-empty"; readonly value: string };
}

const EMPTY_CONTENT = '{"type":"doc","content":[]}' as const;

export function compileCreateCodexEntryOperation(
  input: BindCreateNewInput,
): CreateCodexEntryOperationV1 {
  return {
    kind: "codex.entry.create",
    payload: {
      entryId: input.entryId ?? crypto.randomUUID(),
      typeSlug: input.typeSlug,
      name: input.name,
      summary: input.summary,
      aliases: input.aliases,
      parentId: null,
      content: EMPTY_CONTENT,
      narrativeEntityId: input.narrativeEntityId,
    },
  };
}

export interface BindExistingOnlyInput {
  readonly narrativeEntityId: NarrativeEntityId;
  readonly entryId: string;
  readonly baseVersion: number;
}

export function compileBindExistingCodexEntityOperation(
  input: BindExistingOnlyInput,
): BindExistingCodexEntityOperationV1 {
  return {
    kind: "codex.entity.bind-existing",
    payload: {
      entryId: input.entryId,
      narrativeEntityId: input.narrativeEntityId,
      baseVersion: input.baseVersion,
    },
  };
}

export function compilePatchCodexEntryOperation(
  input: BindExistingPatchInput,
): PatchCodexEntryOperationV1 | null {
  const aliases = Array.from(
    new Set([...input.existingAliases, ...input.aliasesToAdd]),
  );
  const hasAliasChange = input.aliasesToAdd.length > 0;
  const hasSummaryChange = input.summary.kind === "fill-if-empty";
  if (!hasAliasChange && !hasSummaryChange) {
    return null;
  }
  return {
    kind: "codex.entry.patch",
    payload: {
      entryId: input.entryId,
      baseVersion: input.baseVersion,
      aliases: hasAliasChange
        ? { kind: "set", values: aliases }
        : { kind: "leave" },
      summary:
        input.summary.kind === "fill-if-empty"
          ? { kind: "fill-if-empty", value: input.summary.value }
          : { kind: "leave" },
      name: { kind: "leave" },
      typeSlug: { kind: "leave" },
      parentId: { kind: "leave" },
      narrativeEntityId: input.narrativeEntityId,
    },
  };
}

function assertBindingCompatible(
  commitMap: CommitMap,
  narrativeEntityId: NarrativeEntityId,
  codexEntryId: string,
): void {
  const existing = commitMap.entityBindings[narrativeEntityId];
  if (existing && existing.codexEntryId !== codexEntryId) {
    throw new Error(
      `NEX_COMMIT_MAP_CONFLICT: narrative entity '${narrativeEntityId}' already bound to '${existing.codexEntryId}', cannot rebind to '${codexEntryId}'`,
    );
  }
}

export function registerExistingBinding(
  commitMap: CommitMap,
  narrativeEntityId: NarrativeEntityId,
  codexEntryId: string,
): CommitMap {
  assertBindingCompatible(commitMap, narrativeEntityId, codexEntryId);
  return {
    entityBindings: {
      ...commitMap.entityBindings,
      [narrativeEntityId]: {
        narrativeEntityId,
        codexEntryId,
        source: "existing",
      },
    },
  };
}

export function registerCreatedBinding(
  commitMap: CommitMap,
  narrativeEntityId: NarrativeEntityId,
  codexEntryId: string,
): CommitMap {
  assertBindingCompatible(commitMap, narrativeEntityId, codexEntryId);
  return {
    entityBindings: {
      ...commitMap.entityBindings,
      [narrativeEntityId]: {
        narrativeEntityId,
        codexEntryId,
        source: "created",
      },
    },
  };
}

export function resolveCodexEntryId(
  commitMap: CommitMap,
  narrativeEntityId: NarrativeEntityId,
): string {
  const binding = commitMap.entityBindings[narrativeEntityId];
  if (!binding) {
    throw new Error(
      `CommitMap missing binding for narrative entity ${narrativeEntityId}`,
    );
  }
  return binding.codexEntryId;
}

export function compileCreateCodexRelationOperation(
  proposal:
    | Pick<CreateCodexRelationProposal, "payload">
    | {
        readonly payload: CreateCodexRelationProposalPayload;
      },
  commitMap: CommitMap,
  options?: {
    readonly projectId: string;
    readonly relationId?: string;
  },
): CreateCodexRelationOperationV1 {
  const fromCodexId = resolveCodexEntryId(
    commitMap,
    proposal.payload.subjectEntityId,
  );
  const toCodexId = resolveCodexEntryId(
    commitMap,
    proposal.payload.objectEntityId,
  );
  const relation = proposal.payload.relation;
  const semanticKey = options?.projectId
    ? buildCodexRelationSemanticKey({
        projectId: options.projectId,
        fromCodexId,
        toCodexId,
        relationType: relation.relationType,
        directionality: relation.directionality,
        forwardLabel: relation.forwardLabel,
        inverseLabel: relation.inverseLabel,
      })
    : undefined;

  return {
    kind: "codex.relation.create",
    payload: {
      relationId: options?.relationId ?? crypto.randomUUID(),
      fromCodexId,
      toCodexId,
      subjectEntityId: proposal.payload.subjectEntityId,
      objectEntityId: proposal.payload.objectEntityId,
      relationType: relation.relationType,
      directionality: relation.directionality,
      forwardLabel: relation.forwardLabel,
      inverseLabel: relation.inverseLabel,
      semanticKey,
    },
  };
}

export function emptyCommitMap(): CommitMap {
  return { entityBindings: {} };
}
