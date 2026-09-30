import {
  resolveDetailSemanticBinding,
  type DetailSemanticBindingResolution,
  type ResolveDetailSemanticBindingInput,
} from "@/features/codex/details/semanticBindingResolver";
import type { StateFacet } from "@/features/codex/details/semanticBindingTypes";
import type { NarrativeEntityId } from "@/features/narrative-extraction/ir/inferences/codexEntityHypothesis";
import type {
  DetailProjectionHypothesis,
  DetailProjectionScope,
} from "@/features/narrative-extraction/ir/inferences/detailProjection";
import type { ProjectedDetailValue } from "@/features/codex/details/semanticBindingTypes";

export interface ResolveDetailProjectionInput {
  readonly entityId: NarrativeEntityId;
  readonly facetKey: StateFacet;
  readonly scope: DetailProjectionScope;
  readonly observationRefs: readonly string[];
  readonly value: ProjectedDetailValue | null;
  readonly writeKind: "set" | "clear" | "inherit";
  readonly bindingInput: ResolveDetailSemanticBindingInput;
  readonly createId?: () => string;
}

/**
 * Resolve a Detail projection via the existing semanticBindingResolver.
 * Ambiguous / unmapped bindings still produce a hypothesis for review.
 */
export function resolveDetailProjection(
  input: ResolveDetailProjectionInput,
): DetailProjectionHypothesis {
  const createId = input.createId ?? (() => crypto.randomUUID());
  const binding: DetailSemanticBindingResolution = resolveDetailSemanticBinding(
    input.bindingInput,
  );

  const destination = input.bindingInput.destination;
  const write =
    input.writeKind === "inherit"
      ? ({ kind: "inherit" } as const)
      : input.writeKind === "clear"
        ? ({ kind: "clear" } as const)
        : input.value
          ? ({ kind: "set", value: input.value } as const)
          : ({ kind: "clear" } as const);

  return {
    projectionId: createId(),
    observationRefs: input.observationRefs,
    payload: {
      entityId: input.entityId,
      facetKey: input.facetKey,
      destination,
      scope: input.scope,
      binding,
      write,
      value: input.writeKind === "set" ? input.value : null,
    },
  };
}
