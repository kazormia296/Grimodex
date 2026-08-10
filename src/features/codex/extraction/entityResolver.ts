import type {
  CoarseEntityClass,
} from "@/features/narrative-extraction/ir/observations/entityIdentity";
import type {
  CodexEntityExistingResolution,
  CodexEntityTypeResolution,
  KnowledgeTypeRef,
} from "@/features/narrative-extraction/ir/inferences/codexEntityHypothesis";
import type { ExistingEntityCatalogRecord } from "./existingEntityMatcher";

export interface KnowledgeTypeCatalogRecord {
  readonly ref: KnowledgeTypeRef;
  /** Real domain/type key — never sent to the model. */
  readonly sourceKey: string;
  readonly slug: string;
  readonly label: string;
  readonly description?: string;
  readonly coarseClassHints: readonly CoarseEntityClass[];
  readonly expectedVersion: number;
}

export interface ResolveEntityTypeInput {
  readonly existingResolution: CodexEntityExistingResolution;
  readonly existingCatalog?: readonly ExistingEntityCatalogRecord[];
  readonly typeCatalog: readonly KnowledgeTypeCatalogRecord[];
  /** Opaque type refs suggested by the model (T0001…). Unknown refs are rejected. */
  readonly suggestedTypeRefs?: readonly string[];
  readonly coarseClass?: CoarseEntityClass;
}

function uniqueValidTypeRefs(
  refs: readonly string[],
  catalog: readonly KnowledgeTypeCatalogRecord[],
): KnowledgeTypeRef[] {
  const known = new Map(catalog.map((entry) => [entry.ref, entry] as const));
  const out: KnowledgeTypeRef[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    if (!known.has(ref) || seen.has(ref)) continue;
    seen.add(ref);
    out.push(ref);
  }
  return out;
}

/**
 * Resolve Project Codex Type with opaque catalog refs only.
 *
 * 1. Binding an existing entry keeps that entry's type
 * 2. A single valid suggested / coarse-class type → resolved
 * 3. Multiple valid candidates → ambiguous
 * 4. Otherwise → unresolved (never auto-creates types)
 */
export function resolveEntityType(
  input: ResolveEntityTypeInput,
): CodexEntityTypeResolution {
  const existingResolution = input.existingResolution;
  if (existingResolution.status === "resolved") {
    const existing = (input.existingCatalog ?? []).find(
      (entry) => entry.ref === existingResolution.ref,
    );
    if (existing) {
      const typeKnown = input.typeCatalog.some(
        (type) => type.ref === existing.typeRef,
      );
      if (typeKnown) {
        return { status: "resolved", typeRef: existing.typeRef };
      }
      return { status: "unresolved" };
    }
  }

  const suggested = uniqueValidTypeRefs(
    input.suggestedTypeRefs ?? [],
    input.typeCatalog,
  );
  if (suggested.length === 1) {
    return { status: "resolved", typeRef: suggested[0]! };
  }
  if (suggested.length > 1) {
    return { status: "ambiguous", candidates: suggested };
  }

  if (input.coarseClass) {
    const byClass = input.typeCatalog.filter((type) =>
      type.coarseClassHints.includes(input.coarseClass!),
    );
    if (byClass.length === 1) {
      return { status: "resolved", typeRef: byClass[0]!.ref };
    }
    if (byClass.length > 1) {
      return {
        status: "ambiguous",
        candidates: byClass.map((type) => type.ref),
      };
    }
  }

  return { status: "unresolved" };
}

/** Reject unknown opaque type refs from model output. */
export function filterKnownTypeRefs(
  refs: readonly string[],
  catalog: readonly KnowledgeTypeCatalogRecord[],
): readonly KnowledgeTypeRef[] {
  return uniqueValidTypeRefs(refs, catalog);
}
