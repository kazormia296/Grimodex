import { db } from "@/db/client";
import { contentVersions, projectSnapshotEntries } from "@/db/schema";
import { eq, and, desc, sql, inArray } from "drizzle-orm";
import type { ContentVersion } from "@/db/schema";

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
  const latest = await getLatestRevisionContent(entityType, entityId);
  if (latest === content) return null;

  // 採番は INSERT 内のサブクエリで原子的に行う。JS 側で max+1 を先読みすると
  // 並走する saveFn (flush 二重発火等) が同じ番号を計算して UNIQUE
  // (entity_type, entity_id, version_number) 衝突になり、リビジョンが
  // 保存されない (実機で auto-revision が全滅していた)。
  const now = new Date().toISOString();
  const rows = await db
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

  // Exclude IDs referenced by project snapshots
  const protectedRows = await db
    .select({ versionId: projectSnapshotEntries.versionId })
    .from(projectSnapshotEntries)
    .where(inArray(projectSnapshotEntries.versionId, deleteIds));
  const protectedIds = new Set(protectedRows.map((r) => r.versionId));
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
