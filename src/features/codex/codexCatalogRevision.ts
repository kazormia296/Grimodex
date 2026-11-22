/**
 * Codex 構造抽出が提案を Codex の catalog に結び付ける印（DR-CSX-1）。
 *
 * `project:codex-catalog:<projectId>` の revisionToken は Native
 * （`source_revision.rs` の `resolve_codex_catalog`）が DB の内容の digest として
 * 計算し、保存と取り込みの ReadSet をその値で照合する。renderer はこの印を
 * 自分で作らず、Native から受け取る。
 *
 * 抽出は呼び出し元が先に読んだ catalog（Codex の store 由来）を材料にするので、
 * 印を受け取った後に DB の版（entry と、semanticKey のある relation の id・version）を読み直し、
 * 材料の catalog と同じであることを確かめる。印の後に catalog が変われば、保存や
 * 取り込みで Native が `NEX_READ_SET_STALE` を返す。
 */
import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import { codexEntries, codexRelations } from "@/db/schema";
import {
  narrativeExtractionResolveCodexCatalogRevision,
  type CodexCatalogRevision,
  type NarrativeExtractionWorkspaceBinding,
} from "@/application/narrative-extraction/nativeApi";

export interface CodexCatalogVersionRow {
  readonly sourceKey: string;
  readonly version: number;
}

export interface CodexCatalogMaterialVersions {
  readonly entries: readonly CodexCatalogVersionRow[];
  readonly relations: readonly CodexCatalogVersionRow[];
}

export const CODEX_CATALOG_MATERIAL_STALE =
  "NEX_READ_SET_STALE: Codex catalog changed after the extraction material was read";

/** 材料の版と DB の版の違い（id ごと）。空なら同じ。 */
export function diffCodexCatalogVersions(
  material: readonly CodexCatalogVersionRow[],
  current: readonly CodexCatalogVersionRow[],
): string[] {
  const expected = new Map(
    material.map((row) => [row.sourceKey, row.version] as const),
  );
  const differences: string[] = [];
  for (const row of current) {
    const version = expected.get(row.sourceKey);
    if (version === undefined) differences.push(`+${row.sourceKey}`);
    else if (version !== row.version) differences.push(`~${row.sourceKey}`);
    expected.delete(row.sourceKey);
  }
  for (const sourceKey of expected.keys()) differences.push(`-${sourceKey}`);
  return differences.sort();
}

async function readCodexCatalogVersions(
  projectId: string,
): Promise<CodexCatalogMaterialVersions> {
  const [entries, relations] = await Promise.all([
    db
      .select({ sourceKey: codexEntries.id, version: codexEntries.version })
      .from(codexEntries)
      .where(eq(codexEntries.projectId, projectId)),
    db
      .select({
        sourceKey: codexRelations.id,
        version: codexRelations.version,
        semanticKey: codexRelations.semanticKey,
      })
      .from(codexRelations)
      .where(eq(codexRelations.projectId, projectId)),
  ]);
  return {
    entries,
    // `buildExistingRelationCatalog` leaves out Relations without a semantic
    // key (they cannot be matched), so the material never holds them.
    relations: relations
      .filter((row) => Boolean(row.semanticKey))
      .map(({ sourceKey, version }) => ({ sourceKey, version })),
  };
}

/**
 * Native の印を受け取り、その後に読んだ DB の版が材料と同じことを確かめる。
 * 違えば `NEX_READ_SET_STALE` で止める（作者は抽出をやり直す）。
 */
export async function captureCodexCatalogRevision(input: {
  readonly projectId: string;
  readonly binding: NarrativeExtractionWorkspaceBinding;
  readonly material: CodexCatalogMaterialVersions;
}): Promise<CodexCatalogRevision> {
  const revision = await narrativeExtractionResolveCodexCatalogRevision(
    { projectId: input.projectId },
    input.binding,
  );
  const expectedKey = `project:codex-catalog:${input.projectId}`;
  if (
    revision.sourceKind !== "codex-catalog" ||
    revision.sourceKey !== expectedKey ||
    !/^sha256:[0-9a-f]{64}$/u.test(revision.revisionToken)
  ) {
    throw new Error(
      "NEX_SOURCE_KEY_INVALID: Native returned an unexpected Codex catalog revision",
    );
  }
  const current = await readCodexCatalogVersions(input.projectId);
  const differences = [
    ...diffCodexCatalogVersions(input.material.entries, current.entries).map(
      (item) => `entry${item}`,
    ),
    ...diffCodexCatalogVersions(
      input.material.relations,
      current.relations,
    ).map((item) => `relation${item}`),
  ];
  if (differences.length > 0) {
    throw new Error(
      `${CODEX_CATALOG_MATERIAL_STALE} (${differences.slice(0, 8).join(", ")})`,
    );
  }
  return revision;
}
