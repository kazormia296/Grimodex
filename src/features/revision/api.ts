import { db } from "@/db/client";
import { contentVersions } from "@/db/schema";
import { eq, and, desc, sql } from "drizzle-orm";
import type { ContentVersion } from "@/db/schema";
import { debugLog, errorDetail } from "@/lib/debugLog";
import { markEnd, markStart } from "@/lib/perfLog";
import { invoke } from "@/lib/tauri";
import type {
  InvokeTypedWriter,
  TypedWriterCommands,
} from "@/lib/typedWriters";

/**
 * `invoke` with the DA-2b typed writers' signature (shared by the snapshot
 * API). Bound at call time, so a partial `@/lib/tauri` mock still loads this
 * module.
 */
export const invokeTypedWriter: InvokeTypedWriter = (command, args) =>
  invoke(command, args);

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

/**
 * Where a version write belongs: the project that owns the entity and the
 * workspace bound when the save was scheduled (DR-DA2B-R3). The version
 * writers are not bound to a workspace by Native (CW's
 * `expectedWorkspacePath` has no M counterpart), so a late write must not
 * reach the workspace opened after a switch; Native refuses an entity that is
 * not `projectId`'s (`REVISION_WRITE_REFUSED:not-found`). Callers capture it
 * with `captureWorkspaceWriteScope` (`concurrency/mutationAuthority.ts`; this
 * module does not import the workspace identity, which would split it out of
 * its startup chunk, DR-DA2-30).
 */
export interface RevisionWriteScope {
  readonly projectId: string;
  readonly isCurrent: () => boolean;
}

/**
 * Runs a version writer (M, DR-DA2-51) for `scope`. The workspace check and
 * the request are in one synchronous step, so no lifecycle can replace the
 * workspace between them. A stale scope writes nothing. A typed refusal (the
 * entity is not the project's, e.g. a late record after it was deleted, or an
 * invalid request) records no version: the legacy statements never refused,
 * the save has already succeeded, and no new error reaches the user (a warn
 * only). Both answer `undefined`.
 */
export async function writeRevision<
  C extends "revision_create" | "revision_prune",
>(
  scope: RevisionWriteScope,
  command: C,
  payload: Omit<TypedWriterCommands[C]["payload"], "projectId">,
): Promise<TypedWriterCommands[C]["result"] | undefined> {
  if (!scope.isCurrent()) {
    debugLog.warn("Revision", "version write after a workspace change");
    return undefined;
  }
  try {
    return await invokeTypedWriter(command, {
      payload: {
        ...payload,
        projectId: scope.projectId,
      } as TypedWriterCommands[C]["payload"],
    });
  } catch (error) {
    if (!String(error).includes("REVISION_WRITE_REFUSED:")) throw error;
    debugLog.warn("Revision", "version write refused", errorDetail(error));
    return undefined;
  }
}

/**
 * Create a new revision. Returns null if content is identical to the latest
 * revision (Native's `created: false`), the scope is stale or the writer
 * refused it.
 *
 * `revision_create` compares with the latest version and numbers the new one
 * inside one transaction, as the legacy lookup and the `max + 1` sub-select
 * did. It returns no body: the version is built from this request.
 */
export async function createRevision(params: {
  scope: RevisionWriteScope;
  entityType: EntityType;
  entityId: string;
  content: string;
  snapshotType: SnapshotType;
}): Promise<ContentVersion | null> {
  const { scope, entityType, entityId, content, snapshotType } = params;
  markStart("editor.autoRevision.insert");
  try {
    const written = await writeRevision(scope, "revision_create", {
      entityType,
      entityId,
      content,
      snapshotType,
    });
    return written?.created
      ? {
          id: written.id,
          entityType,
          entityId,
          content,
          versionNumber: written.versionNumber,
          snapshotType,
          createdAt: written.createdAt,
        }
      : null;
  } finally {
    markEnd("editor.autoRevision.insert");
  }
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
 *
 *  `revision_prune` (M, DR-DA2-51) applies the legacy rule in one transaction:
 *  newest first, keep `keepCount`, and of the older ones delete only `auto`
 *  versions that none of the four snapshot references (entries, tree nodes,
 *  Codex entries, snippets; all ON DELETE RESTRICT) points at.
 */
export async function pruneRevisions(
  scope: RevisionWriteScope,
  entityType: EntityType,
  entityId: string,
  keepCount = 50,
): Promise<void> {
  await writeRevision(scope, "revision_prune", {
    entityType,
    entityId,
    keepCount,
  });
}
