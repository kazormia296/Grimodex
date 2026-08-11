import type {
  BindCodexEntityPayload,
  BindCodexEntityProposal,
} from "@/features/narrative-extraction/proposals/bindCodexEntityProposal";
import type { CreateCodexRelationProposalPayload } from "@/features/narrative-extraction/proposals/createCodexRelationProposal";

export function patchBindCodexEntityPayload(
  payload: BindCodexEntityPayload,
  patch: {
    readonly canonicalName?: string;
    readonly summary?: string | null;
    readonly aliases?: readonly string[];
    readonly typeRef?: string;
  },
): BindCodexEntityPayload {
  const binding = payload.binding;
  let nextBinding = binding;
  if (binding.kind === "create-new") {
    nextBinding = {
      ...binding,
      entry: {
        name:
          patch.canonicalName !== undefined
            ? patch.canonicalName.trim()
            : binding.entry.name,
        aliases:
          patch.aliases !== undefined
            ? [...patch.aliases]
            : binding.entry.aliases,
        summary:
          patch.summary !== undefined
            ? patch.summary === null
              ? null
              : patch.summary.trim() || null
            : binding.entry.summary,
      },
    };
  } else if (
    binding.kind === "bind-existing" &&
    patch.summary !== undefined &&
    patch.summary !== null &&
    patch.summary.trim()
  ) {
    nextBinding = {
      ...binding,
      enrichment: {
        ...binding.enrichment,
        summary: {
          kind: "fill-if-empty",
          value: patch.summary.trim(),
        },
      },
    };
  }

  const nextType =
    patch.typeRef !== undefined
      ? { status: "resolved" as const, typeRef: patch.typeRef }
      : payload.typeResolution;

  return {
    ...payload,
    canonicalName:
      patch.canonicalName !== undefined
        ? patch.canonicalName.trim()
        : payload.canonicalName,
    typeResolution: nextType,
    binding: nextBinding,
    aliases:
      patch.aliases !== undefined
        ? patch.aliases.map((surface) => ({
            surface,
            status: "explicit" as const,
          }))
        : payload.aliases,
  };
}

export function resolveBindCodexEntityPayload(
  proposal: BindCodexEntityProposal,
  resolution:
    | { readonly kind: "create-new" }
    | { readonly kind: "bind-existing"; readonly entityRef: string },
): BindCodexEntityPayload {
  const payload = proposal.payload;
  if (payload.binding.kind !== "unresolved") {
    return payload;
  }
  const aliases = payload.aliases
    .filter((alias) => alias.status === "explicit")
    .map((alias) => alias.surface);
  if (resolution.kind === "create-new") {
    return {
      ...payload,
      binding: {
        kind: "create-new",
        entry: {
          name: payload.canonicalName,
          aliases,
          summary: null,
        },
      },
    };
  }
  return {
    ...payload,
    binding: {
      kind: "bind-existing",
      entityRef: resolution.entityRef,
      enrichment: {
        aliasesToAdd: aliases,
        summary: { kind: "leave" },
      },
    },
  };
}

export function patchCreateCodexRelationPayload(
  payload: CreateCodexRelationProposalPayload,
  patch: {
    readonly directionality?: "directed" | "symmetric";
    readonly forwardLabel?: string;
    readonly inverseLabel?: string | null;
  },
): CreateCodexRelationProposalPayload | null {
  const relation = payload.relation;
  const directionality = patch.directionality ?? relation.directionality;
  const forwardLabel =
    patch.forwardLabel !== undefined
      ? patch.forwardLabel.trim()
      : relation.forwardLabel;
  let inverseLabel =
    patch.inverseLabel !== undefined
      ? patch.inverseLabel === null
        ? null
        : patch.inverseLabel.trim() || null
      : relation.inverseLabel;
  if (directionality === "symmetric") {
    inverseLabel = forwardLabel;
  }
  if (!forwardLabel) return null;
  return {
    ...payload,
    relation: {
      ...relation,
      directionality,
      forwardLabel,
      inverseLabel,
    },
  };
}

export function swapCreateCodexRelationEndpoints(
  payload: CreateCodexRelationProposalPayload,
): CreateCodexRelationProposalPayload {
  return {
    ...payload,
    subjectEntityId: payload.objectEntityId,
    objectEntityId: payload.subjectEntityId,
  };
}
