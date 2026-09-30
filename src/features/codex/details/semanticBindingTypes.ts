export const DETAIL_PROJECTION_KINDS = Object.freeze([
  "scalar-text",
  "summary-text",
  "enum",
  "entity-reference",
] as const);

export type DetailProjectionKind = (typeof DETAIL_PROJECTION_KINDS)[number];

export const DETAIL_TEMPORAL_POLICIES = Object.freeze([
  "base-only",
  "phase-on-durable-change",
  "base-and-phase",
  "derived",
  "manual-only",
] as const);

export type DetailTemporalPolicy = (typeof DETAIL_TEMPORAL_POLICIES)[number];

export const DETAIL_BINDING_SOURCES = Object.freeze([
  "preset",
  "user",
  "reviewed-ai",
] as const);

export type DetailBindingSource = (typeof DETAIL_BINDING_SOURCES)[number];

/**
 * Canonical Narrative State facet key. The concrete registry is introduced by
 * the State Track slice; PR1 deliberately preserves forward-compatible keys.
 */
export type StateFacet = string;

/** Canonical Narrative Entity identity, not a Codex Entry database id. */
export type NarrativeEntityId = string;

export interface DetailSemanticBinding {
  readonly id: string;
  readonly projectId: string;
  readonly definitionId: string;
  readonly facetKey: StateFacet;
  readonly projectionKind: DetailProjectionKind;
  readonly temporalPolicy: DetailTemporalPolicy;
  readonly source: DetailBindingSource;
  readonly confirmed: boolean;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type ProjectedDetailValue =
  | {
      readonly kind: "text";
      readonly text: string;
    }
  | {
      readonly kind: "enum";
      readonly optionRef: string;
    }
  | {
      readonly kind: "entity";
      readonly entityId: NarrativeEntityId;
    }
  | {
      readonly kind: "clear";
    };

export type PhaseDetailWrite =
  | {
      readonly kind: "inherit";
    }
  | {
      readonly kind: "set";
      readonly value: ProjectedDetailValue;
    }
  | {
      readonly kind: "clear";
    };

export function isDetailProjectionKind(
  value: unknown,
): value is DetailProjectionKind {
  return (
    typeof value === "string" &&
    (DETAIL_PROJECTION_KINDS as readonly string[]).includes(value)
  );
}

export function isDetailTemporalPolicy(
  value: unknown,
): value is DetailTemporalPolicy {
  return (
    typeof value === "string" &&
    (DETAIL_TEMPORAL_POLICIES as readonly string[]).includes(value)
  );
}

export function isDetailBindingSource(
  value: unknown,
): value is DetailBindingSource {
  return (
    typeof value === "string" &&
    (DETAIL_BINDING_SOURCES as readonly string[]).includes(value)
  );
}
