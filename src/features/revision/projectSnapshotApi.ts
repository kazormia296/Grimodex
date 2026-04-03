import { db } from "@/db/client";
import {
  projectSnapshots,
  projectSnapshotEntries,
  contentVersions,
  treeNodes,
  codexEntries,
  snippets,
} from "@/db/schema";
import { eq, and, desc, sql, inArray } from "drizzle-orm";
import { createRevision } from "./api";
import type { EntityType } from "./api";

const PROJECT_ID = "default-project";

export interface ProjectSnapshotMeta {
  id: string;
  name: string;
  description: string | null;
  entryCount: number;
  createdAt: string;
}

/** Get the latest revision ID for an entity, or create one if content differs. */
async function getOrCreateRevisionId(
  entityType: EntityType,
  entityId: string,
  content: string,
): Promise<string | null> {
  const rev = await createRevision({
    entityType,
    entityId,
    content,
    snapshotType: "manual",
  });
  if (rev) return rev.id;

  // Content was identical — find the latest existing revision
  const rows = await db
    .select({ id: contentVersions.id })
    .from(contentVersions)
    .where(
      and(
        eq(contentVersions.entityType, entityType),
        eq(contentVersions.entityId, entityId),
      ),
    )
    .orderBy(desc(contentVersions.versionNumber))
    .limit(1);
  return rows[0]?.id ?? null;
}

/** Create a named project snapshot capturing current content of all entities. */
export async function createProjectSnapshot(params: {
  name: string;
  description?: string;
}): Promise<{ id: string; entryCount: number }> {
  const { name, description } = params;
  const snapshotId = crypto.randomUUID();
  const now = new Date().toISOString();

  await db.insert(projectSnapshots).values({
    id: snapshotId,
    projectId: PROJECT_ID,
    name,
    description: description ?? null,
    createdAt: now,
  });

  const versionIds: string[] = [];

  // Scenes and notes
  const nodes = await db
    .select({
      id: treeNodes.id,
      nodeType: treeNodes.nodeType,
      content: treeNodes.content,
    })
    .from(treeNodes)
    .where(eq(treeNodes.projectId, PROJECT_ID));

  for (const node of nodes) {
    const entityType: EntityType | null =
      node.nodeType === "scene"
        ? "scene"
        : node.nodeType === "note"
          ? "note"
          : null;
    if (!entityType) continue;
    if (!node.content || node.content === "{}") continue;
    const id = await getOrCreateRevisionId(entityType, node.id, node.content);
    if (id) versionIds.push(id);
  }

  // Codex entries
  const codexRows = await db
    .select({ id: codexEntries.id, content: codexEntries.content })
    .from(codexEntries)
    .where(eq(codexEntries.projectId, PROJECT_ID));

  for (const entry of codexRows) {
    if (!entry.content || entry.content === "{}") continue;
    const id = await getOrCreateRevisionId(
      "codex_entry",
      entry.id,
      entry.content,
    );
    if (id) versionIds.push(id);
  }

  // Snippets
  const snippetRows = await db
    .select({ id: snippets.id, content: snippets.content })
    .from(snippets)
    .where(eq(snippets.projectId, PROJECT_ID));

  for (const snippet of snippetRows) {
    if (!snippet.content || snippet.content === "{}") continue;
    const id = await getOrCreateRevisionId(
      "snippet",
      snippet.id,
      snippet.content,
    );
    if (id) versionIds.push(id);
  }

  if (versionIds.length > 0) {
    await db
      .insert(projectSnapshotEntries)
      .values(versionIds.map((versionId) => ({ snapshotId, versionId })));
  }

  return { id: snapshotId, entryCount: versionIds.length };
}

/** List all project snapshots with entry counts. */
export async function listProjectSnapshots(): Promise<ProjectSnapshotMeta[]> {
  const snaps = await db
    .select()
    .from(projectSnapshots)
    .where(eq(projectSnapshots.projectId, PROJECT_ID))
    .orderBy(desc(projectSnapshots.createdAt));

  const results: ProjectSnapshotMeta[] = [];
  for (const snap of snaps) {
    const countRows = await db
      .select({ count: sql<number>`count(*)` })
      .from(projectSnapshotEntries)
      .where(eq(projectSnapshotEntries.snapshotId, snap.id));
    results.push({
      id: snap.id,
      name: snap.name,
      description: snap.description,
      entryCount: Number(countRows[0]?.count ?? 0),
      createdAt: snap.createdAt,
    });
  }
  return results;
}

/** Restore a project snapshot: saves current state as safety, then restores. */
export async function restoreProjectSnapshot(
  snapshotId: string,
  snapshotName: string,
): Promise<{ restoredCount: number; safetySnapshotId: string }> {
  // 1. Safety snapshot of current state
  const safety = await createProjectSnapshot({
    name: `Before restore to '${snapshotName}'`,
  });

  // 2. Get all version entries for the target snapshot
  const entries = await db
    .select({ versionId: projectSnapshotEntries.versionId })
    .from(projectSnapshotEntries)
    .where(eq(projectSnapshotEntries.snapshotId, snapshotId));

  const versionIds = entries.map((e) => e.versionId);
  if (versionIds.length === 0) {
    return { restoredCount: 0, safetySnapshotId: safety.id };
  }

  // 3. Fetch all versions at once
  const versions = await db
    .select()
    .from(contentVersions)
    .where(inArray(contentVersions.id, versionIds));

  const now = new Date().toISOString();
  let restoredCount = 0;

  for (const version of versions) {
    const { entityType, entityId, content } = version;

    if (entityType === "scene" || entityType === "note") {
      await db
        .update(treeNodes)
        .set({ content, updatedAt: now })
        .where(eq(treeNodes.id, entityId));
    } else if (entityType === "codex_entry") {
      await db
        .update(codexEntries)
        .set({ content, updatedAt: now })
        .where(eq(codexEntries.id, entityId));
    } else if (entityType === "snippet") {
      await db
        .update(snippets)
        .set({ content, updatedAt: now })
        .where(eq(snippets.id, entityId));
    }
    restoredCount++;
  }

  return { restoredCount, safetySnapshotId: safety.id };
}

/** Delete a project snapshot (cascade removes entries). */
export async function deleteProjectSnapshot(snapshotId: string): Promise<void> {
  await db.delete(projectSnapshots).where(eq(projectSnapshots.id, snapshotId));
}
