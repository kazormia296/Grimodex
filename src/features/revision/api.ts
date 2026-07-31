import { db } from "@/db/client";
import {
  contentVersions,
  projectSnapshotEntries,
  projectSnapshotTreeNodes,
  projectSnapshotCodexEntries,
  projectSnapshotSnippets,
} from "@/db/schema";
import { eq, and, desc, sql, inArray, isNotNull } from "drizzle-orm";
import type { ContentVersion } from "@/db/schema";
import { markEnd, markStart } from "@/lib/perfLog";

export type EntityType = "scene" | "note" | "codex_entry" | "snippet";
export type SnapshotType = "auto" | "manual";

export type RevisionMeta = Omit<ContentVersion, "content">;

/** Get the latest revision's content for an entity. */
export async function getLatestRevisionContent(
  entityType: EntityType,
  entityId: string,
): Promise<string | null> {
  const rows = await db
    .select({ content: contentVersions.content })
    .from(contentVersions)
    .where(
      and(
        eq(contentVersions.entityType, entityType),
        eq(contentVersions.entityId, entityId),
      ),
    )
    .orderBy(desc(contentVersions.versionNumber))
    .limit(1);
  return rows[0]?.content ?? null;
}

/** Create a new revision. Returns null if content is identical to the latest revision. */
export async function createRevision(params: {
  entityType: EntityType;
  entityId: string;
  content: string;
  snapshotType: SnapshotType;
}): Promise<ContentVersion | null> {
  const { entityType, entityId, content, snapshotType } = params;

  // Skip if content is identical to latest revision
  markStart("editor.autoRevision.lookupLatest");
  let latest: string | null;
  try {
    latest = await getLatestRevisionContent(entityType, entityId);
  } finally {
    markEnd("editor.autoRevision.lookupLatest");
  }
  if (latest === content) return null;

  // 採番は INSERT 内のサブクエリで原子的に行う。JS 側で max+1 を先読みすると
  // 並走する saveFn (flush 二重発火等) が同じ番号を計算して UNIQUE
  // (entity_type, entity_id, version_number) 衝突になり、リビジョンが
  // 保存されない (実機で auto-revision が全滅していた)。
  const now = new Date().toISOString();
  markStart("editor.autoRevision.insert");
  let rows: ContentVersion[];
  try {
    rows = await db
      .insert(contentVersions)
      .values({
        id: crypto.randomUUID(),
        entityType,
        entityId,
        content,
        versionNumber: sql<number>`(
          select coalesce(max(${contentVersions.versionNumber}), 0) + 1
          from ${contentVersions}
          where ${contentVersions.entityType} = ${entityType}
            and ${contentVersions.entityId} = ${entityId}
        )`,
        snapshotType,
        createdAt: now,
      })
      .returning();
  } finally {
    markEnd("editor.autoRevision.insert");
  }
  return rows[0];
}

/** List revisions for an entity (metadata only, content excluded). */
export async function listRevisions(
  entityType: EntityType,
  entityId: string,
  limit = 20,
  offset = 0,
): Promise<RevisionMeta[]> {
  return db
    .select({
      id: contentVersions.id,
      entityType: contentVersions.entityType,
      entityId: contentVersions.entityId,
      versionNumber: contentVersions.versionNumber,
      snapshotType: contentVersions.snapshotType,
      createdAt: contentVersions.createdAt,
      // content omitted for performance
      content: sql<string>`''`,
    })
    .from(contentVersions)
    .where(
      and(
        eq(contentVersions.entityType, entityType),
        eq(contentVersions.entityId, entityId),
      ),
    )
    .orderBy(desc(contentVersions.versionNumber))
    .limit(limit)
    .offset(offset);
}

/** Get a single revision with its content. */
export async function getRevision(
  id: string,
): Promise<ContentVersion | undefined> {
  const rows = await db
    .select()
    .from(contentVersions)
    .where(eq(contentVersions.id, id));
  return rows[0];
}

/** Prune old auto revisions, keeping at most `keepCount` total per entity.
 *  Protected revisions (referenced by project_snapshots) are excluded from pruning.
 */
export async function pruneRevisions(
  entityType: EntityType,
  entityId: string,
  keepCount = 50,
): Promise<void> {
  // Get all revisions ordered by version desc
  const all = await db
    .select({
      id: contentVersions.id,
      snapshotType: contentVersions.snapshotType,
    })
    .from(contentVersions)
    .where(
      and(
        eq(contentVersions.entityType, entityType),
        eq(contentVersions.entityId, entityId),
      ),
    )
    .orderBy(desc(contentVersions.versionNumber));

  if (all.length <= keepCount) return;

  const toDelete = all.slice(keepCount);
  const autoToDelete = toDelete.filter((r) => r.snapshotType === "auto");
  let deleteIds = autoToDelete.map((r) => r.id);

  if (deleteIds.length === 0) return;

  // Exclude IDs referenced by project snapshots. content_versions rows are
  // referenced from FOUR places, all ON DELETE RESTRICT in SQL:
  //   1. project_snapshot_entries.version_id (scene/note/codex/snippet 本文の版)
  //   2. project_snapshot_tree_nodes.body_version_id
  //   3. project_snapshot_codex_entries.body_version_id
  //   4. project_snapshot_snippets.body_version_id
  // 以前は (1) しか除外しておらず、(2)〜(4) が参照する版を削除対象に残していた。
  // FK RESTRICT が実際の DELETE を弾く（＝データ損失は無い）が、DELETE 文が
  // 常に失敗し .catch(console.error) に飲まれるため prune が機能せず版が
  // 際限なく蓄積する。DB トリガー / schema コメントは 4 参照すべてを保護する
  // 前提で書かれており、ここも 4 参照すべてを除外して整合させる。
  const [entryRefs, treeRefs, codexRefs, snippetRefs] = await Promise.all([
    db
      .select({ versionId: projectSnapshotEntries.versionId })
      .from(projectSnapshotEntries)
      .where(inArray(projectSnapshotEntries.versionId, deleteIds)),
    db
      .select({ versionId: projectSnapshotTreeNodes.bodyVersionId })
      .from(projectSnapshotTreeNodes)
      .where(
        and(
          isNotNull(projectSnapshotTreeNodes.bodyVersionId),
          inArray(projectSnapshotTreeNodes.bodyVersionId, deleteIds),
        ),
      ),
    db
      .select({ versionId: projectSnapshotCodexEntries.bodyVersionId })
      .from(projectSnapshotCodexEntries)
      .where(
        and(
          isNotNull(projectSnapshotCodexEntries.bodyVersionId),
          inArray(projectSnapshotCodexEntries.bodyVersionId, deleteIds),
        ),
      ),
    db
      .select({ versionId: projectSnapshotSnippets.bodyVersionId })
      .from(projectSnapshotSnippets)
      .where(
        and(
          isNotNull(projectSnapshotSnippets.bodyVersionId),
          inArray(projectSnapshotSnippets.bodyVersionId, deleteIds),
        ),
      ),
  ]);
  const protectedIds = new Set<string>();
  for (const rows of [entryRefs, treeRefs, codexRefs, snippetRefs]) {
    for (const r of rows) {
      if (r.versionId) protectedIds.add(r.versionId);
    }
  }
  deleteIds = deleteIds.filter((id) => !protectedIds.has(id));

  if (deleteIds.length === 0) return;

  await db
    .delete(contentVersions)
    .where(
      and(
        eq(contentVersions.entityType, entityType),
        eq(contentVersions.entityId, entityId),
        inArray(contentVersions.id, deleteIds),
      ),
    );
}
