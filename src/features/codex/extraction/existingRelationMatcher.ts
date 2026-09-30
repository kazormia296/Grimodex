import { buildCodexRelationSemanticKey } from "./relationVocabulary";

export interface ExistingRelationCatalogRecord {
  readonly ref: string;
  readonly sourceKey: string;
  readonly semanticKey: string;
  readonly fromCodexId: string;
  readonly toCodexId: string;
  readonly relationType: string;
  readonly directionality: "directed" | "symmetric";
  readonly forwardLabel: string;
  readonly inverseLabel: string | null;
  /** OCC token captured with the catalog read. */
  readonly expectedVersion?: number;
}

export type ExistingRelationMatch =
  | { readonly status: "already-satisfied"; readonly existingRef: string }
  | { readonly status: "unmatched" };

/**
 * Exact semantic-key match against the project Relation catalog.
 * No fuzzy / probable-duplicate path in v1.
 */
export function matchExistingCodexRelation(
  semanticKey: string | null | undefined,
  catalog: readonly ExistingRelationCatalogRecord[],
): ExistingRelationMatch {
  if (!semanticKey) return { status: "unmatched" };
  const hit = catalog.find((row) => row.semanticKey === semanticKey);
  if (!hit) return { status: "unmatched" };
  return { status: "already-satisfied", existingRef: hit.ref };
}

export function buildExistingRelationCatalog(
  rows: readonly {
    readonly id: string;
    readonly fromCodexId: string;
    readonly toCodexId: string;
    readonly relationType: string;
    readonly directionality: "directed" | "symmetric";
    readonly label: string | null;
    readonly inverseLabel: string | null;
    readonly semanticKey: string;
    readonly version?: number;
  }[],
): ExistingRelationCatalogRecord[] {
  const catalog: ExistingRelationCatalogRecord[] = [];
  let index = 0;
  for (const row of rows) {
    if (!row.semanticKey) continue;
    index += 1;
    catalog.push({
      ref: `R${String(index).padStart(4, "0")}`,
      sourceKey: row.id,
      semanticKey: row.semanticKey,
      fromCodexId: row.fromCodexId,
      toCodexId: row.toCodexId,
      relationType: row.relationType,
      directionality: row.directionality,
      forwardLabel: row.label ?? "",
      inverseLabel: row.inverseLabel,
      expectedVersion: row.version ?? 0,
    });
  }
  return catalog;
}

/** Rebuild a semantic key for catalog comparison (validates catalog rows). */
export function semanticKeyFromCatalogRow(
  projectId: string,
  row: Pick<
    ExistingRelationCatalogRecord,
    | "fromCodexId"
    | "toCodexId"
    | "relationType"
    | "directionality"
    | "forwardLabel"
    | "inverseLabel"
  >,
): string {
  return buildCodexRelationSemanticKey({
    projectId,
    fromCodexId: row.fromCodexId,
    toCodexId: row.toCodexId,
    relationType: row.relationType,
    directionality: row.directionality,
    forwardLabel: row.forwardLabel,
    inverseLabel: row.inverseLabel,
  });
}
