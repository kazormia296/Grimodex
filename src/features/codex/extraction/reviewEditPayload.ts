import type {
  BindCodexEntityPayload,
  BindCodexEntityProposal,
} from "@/features/narrative-extraction/proposals/bindCodexEntityProposal";
import type { CreateCodexRelationProposalPayload } from "@/features/narrative-extraction/proposals/createCodexRelationProposal";
import { withSurfaceAlias } from "./surfaceAlias";

/** 提案の編集の patch。画面・Api・store で同じ形を使う。 */
export interface BindCodexEntityPayloadPatch {
  readonly canonicalName?: string;
  readonly summary?: string | null;
  readonly aliases?: readonly string[];
  readonly typeRef?: string;
  /**
   * 既存への結び付けで、表記（名前）を結び先の別名にも足すか（打ち手 1、既定 OFF）。
   * 判定（足してよい表記か）は呼び手が先に行う。名前を変えた編集では、指定が無ければ外す。
   */
  readonly addSurfaceAlias?: boolean;
}

export function patchBindCodexEntityPayload(
  payload: BindCodexEntityPayload,
  patch: BindCodexEntityPayloadPatch,
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

  const next: BindCodexEntityPayload = {
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
  if (next.binding.kind !== "bind-existing") return next;
  if (patch.addSurfaceAlias !== undefined) {
    return withSurfaceAlias(next, patch.addSurfaceAlias, payload.canonicalName);
  }
  // 名前（表記）を直すと足すはずの表記が変わるので、別名に足す印は外す（§14 の T1-5）。
  if (next.canonicalName.trim() !== payload.canonicalName.trim()) {
    return withSurfaceAlias(next, false, payload.canonicalName);
  }
  return next;
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
