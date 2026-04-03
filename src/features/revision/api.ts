import { db } from "@/db/client";
import { contentVersions } from "@/db/schema";
import { eq, and, desc, max, sql, inArray } from "drizzle-orm";
import type { ContentVersion } from "@/db/schema";

export type EntityType = "scene" | "note" | "codex_entry" | "snippet";
export type SnapshotType = "auto" | "manual";

export type RevisionMeta = Omit<ContentVersion, "content">;

/** Get next version number for an entity. */
async function nextVersionNumber(
  entityType: EntityType,
  entityId: string,
): Promise<number> {
  const rows = await db
    .select({ max: max(contentVersions.versionNumber) })
    .from(contentVersions)
    .where(
      and(
        eq(contentVersions.entityType, entityType),
        eq(contentVersions.entityId, entityId),
      ),
    );
  return (rows[0]?.max ?? 0) + 1;
}

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

  const versionNumber = await nextVersionNumber(entityType, entityId);
  const now = new Date().toISOString();
  const rows = await db
    .insert(contentVersions)
    .values({
      id: crypto.randomUUID(),
      entityType,
      entityId,
      content,
      versionNumber,
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
  // Delete oldest auto revisions first, then manual if still over limit
  const autoToDelete = toDelete.filter((r) => r.snapshotType === "auto");
  const deleteIds = autoToDelete.map((r) => r.id);

  if (deleteIds.length === 0) return;

  await db.delete(contentVersions).where(
    and(
      eq(contentVersions.entityType, entityType),
      eq(contentVersions.entityId, entityId),
      inArray(contentVersions.id, deleteIds),
    ),
  );
}
