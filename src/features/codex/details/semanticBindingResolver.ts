import type {
  DetailDefinitionCatalog,
  DetailDefinitionCatalogRecord,
} from "./detailDefinitionCatalog";
import type { PresetSemanticBindingCandidate } from "./presetSemanticBindings";
import type {
  DetailProjectionKind,
  DetailSemanticBinding,
  DetailTemporalPolicy,
  StateFacet,
} from "./semanticBindingTypes";

export type DetailBindingDestination = "base" | "phase";

export type SemanticBindingResolutionErrorCode =
  | "unknown-definition"
  | "project-mismatch"
  | "type-mismatch"
  | "projection-kind-mismatch";

export class SemanticBindingResolutionError extends Error {
  readonly code: SemanticBindingResolutionErrorCode;

  constructor(code: SemanticBindingResolutionErrorCode, message: string) {
    super(message);
    this.name = "SemanticBindingResolutionError";
    this.code = code;
  }
}

export interface DetailBindingStamp {
  readonly bindingId: string;
  readonly version: number;
}

export type DetailSemanticBindingResolution =
  | {
      readonly status: "resolved";
      readonly definitionRef: string;
      readonly basis: "confirmed-binding" | "preset-binding";
      readonly bindingStamp?: DetailBindingStamp;
    }
  | {
      readonly status: "ambiguous";
      readonly candidates: readonly {
        readonly definitionRef: string;
        readonly reasons: readonly string[];
        readonly bindingStamp?: DetailBindingStamp;
      }[];
    }
  | {
      readonly status: "unmapped";
      readonly reason:
        | "no-binding"
        | "no-confirmed-binding"
        | "temporal-policy";
    };

export interface ResolveDetailSemanticBindingInput {
  readonly projectId: string;
  readonly typeSlug: string;
  readonly facetKey: StateFacet;
  readonly destination: DetailBindingDestination;
  readonly catalog: DetailDefinitionCatalog;
  readonly bindings: readonly DetailSemanticBinding[];
  readonly presetCandidates: readonly PresetSemanticBindingCandidate[];
}

interface ResolutionCandidate {
  readonly definitionRef: string;
  readonly projectionKind: DetailProjectionKind;
  readonly temporalPolicy: DetailTemporalPolicy;
  readonly basis: "confirmed-binding" | "preset-binding";
  readonly bindingStamp?: DetailBindingStamp;
}

function projectionMatches(
  record: DetailDefinitionCatalogRecord,
  projectionKind: DetailProjectionKind,
): boolean {
  switch (record.fieldType) {
    case "text":
      return (
        projectionKind === "scalar-text" || projectionKind === "summary-text"
      );
    case "dropdown":
      return projectionKind === "enum";
    case "codex_reference":
      return projectionKind === "entity-reference";
  }
}

function destinationAllowed(
  policy: DetailTemporalPolicy,
  destination: DetailBindingDestination,
): boolean {
  if (policy === "base-and-phase") return true;
  if (destination === "base") return policy === "base-only";
  return policy === "phase-on-durable-change";
}

function resolveDefinition(
  catalog: DetailDefinitionCatalog,
  definitionId: string,
  projectionKind: DetailProjectionKind,
): { definitionRef: string; record: DetailDefinitionCatalogRecord } {
  const definitionRef = catalog.definitionRefForId(definitionId);
  const record = definitionRef ? catalog.recordByRef(definitionRef) : undefined;
  if (!definitionRef || !record) {
    throw new SemanticBindingResolutionError(
      "unknown-definition",
      `Semantic Binding targets an unknown Detail Definition: ${definitionId}`,
    );
  }
  if (!projectionMatches(record, projectionKind)) {
    throw new SemanticBindingResolutionError(
      "projection-kind-mismatch",
      `Projection kind ${projectionKind} is incompatible with ${record.fieldType}`,
    );
  }
  return { definitionRef, record };
}

function resolveCandidates(
  candidates: readonly ResolutionCandidate[],
  destination: DetailBindingDestination,
): DetailSemanticBindingResolution {
  const allowed = candidates.filter((candidate) =>
    destinationAllowed(candidate.temporalPolicy, destination),
  );
  if (allowed.length === 0) {
    return { status: "unmapped", reason: "temporal-policy" };
  }
  if (allowed.length === 1) {
    const candidate = allowed[0];
    return Object.freeze({
      status: "resolved" as const,
      definitionRef: candidate.definitionRef,
      basis: candidate.basis,
      ...(candidate.bindingStamp
        ? { bindingStamp: Object.freeze(candidate.bindingStamp) }
        : {}),
    });
  }
  return Object.freeze({
    status: "ambiguous" as const,
    candidates: Object.freeze(
      allowed.map((candidate) =>
        Object.freeze({
          definitionRef: candidate.definitionRef,
          reasons: Object.freeze([candidate.basis]),
          ...(candidate.bindingStamp
            ? { bindingStamp: Object.freeze(candidate.bindingStamp) }
            : {}),
        }),
      ),
    ),
  });
}

export function resolveDetailSemanticBinding({
  projectId,
  typeSlug,
  facetKey,
  destination,
  catalog,
  bindings,
  presetCandidates,
}: ResolveDetailSemanticBindingInput): DetailSemanticBindingResolution {
  if (catalog.projectId !== null && catalog.projectId !== projectId) {
    throw new SemanticBindingResolutionError(
      "project-mismatch",
      "Detail Definition catalog belongs to another project",
    );
  }
  if (catalog.typeSlug !== null && catalog.typeSlug !== typeSlug) {
    throw new SemanticBindingResolutionError(
      "type-mismatch",
      "Detail Definition catalog belongs to another Codex type",
    );
  }
  const matchingBindings = bindings.filter(
    (binding) => binding.facetKey === facetKey,
  );
  for (const binding of matchingBindings) {
    if (binding.projectId !== projectId) {
      throw new SemanticBindingResolutionError(
        "project-mismatch",
        "Semantic Binding belongs to another project",
      );
    }
  }

  const confirmed = matchingBindings.filter(
    (binding) => binding.confirmed && binding.source !== "preset",
  );
  if (confirmed.length > 0) {
    const candidates = confirmed.map((binding) => {
      const { definitionRef } = resolveDefinition(
        catalog,
        binding.definitionId,
        binding.projectionKind,
      );
      return {
        definitionRef,
        projectionKind: binding.projectionKind,
        temporalPolicy: binding.temporalPolicy,
        basis: "confirmed-binding" as const,
        bindingStamp: {
          bindingId: binding.id,
          version: binding.version,
        },
      };
    });
    return resolveCandidates(candidates, destination);
  }

  const presetByDefinition = new Map<string, ResolutionCandidate>();
  for (const binding of matchingBindings.filter(
    (candidate) => candidate.confirmed && candidate.source === "preset",
  )) {
    const { definitionRef } = resolveDefinition(
      catalog,
      binding.definitionId,
      binding.projectionKind,
    );
    presetByDefinition.set(binding.definitionId, {
      definitionRef,
      projectionKind: binding.projectionKind,
      temporalPolicy: binding.temporalPolicy,
      basis: "preset-binding",
      bindingStamp: { bindingId: binding.id, version: binding.version },
    });
  }
  for (const candidate of presetCandidates.filter(
    (presetCandidate) => presetCandidate.facetKey === facetKey,
  )) {
    if (presetByDefinition.has(candidate.definitionId)) continue;
    const { definitionRef } = resolveDefinition(
      catalog,
      candidate.definitionId,
      candidate.projectionKind,
    );
    presetByDefinition.set(candidate.definitionId, {
      definitionRef,
      projectionKind: candidate.projectionKind,
      temporalPolicy: candidate.temporalPolicy,
      basis: "preset-binding",
    });
  }
  if (presetByDefinition.size > 0) {
    const order = new Map(
      catalog.records.map((record, index) => [record.definitionRef, index]),
    );
    return resolveCandidates(
      [...presetByDefinition.values()].sort(
        (left, right) =>
          (order.get(left.definitionRef) ?? Number.MAX_SAFE_INTEGER) -
          (order.get(right.definitionRef) ?? Number.MAX_SAFE_INTEGER),
      ),
      destination,
    );
  }

  return matchingBindings.length > 0
    ? { status: "unmapped", reason: "no-confirmed-binding" }
    : { status: "unmapped", reason: "no-binding" };
}
