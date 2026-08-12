import { db } from "@/db/client";
import { codexDismissedRelations, codexEntries } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { invoke } from "@/lib/tauri";
import { getRecorderSessionId } from "@/features/timelapse/recorder";

/**
 * List all dismissed relation IDs for a given entry.
 */
export async function listDismissedRelationIds(
  entryId: string,
): Promise<string[]> {
  const rows = await db
    .select({ dismissedId: codexDismissedRelations.dismissedId })
    .from(codexDismissedRelations)
    .where(eq(codexDismissedRelations.entryId, entryId));
  return rows.map((r) => r.dismissedId);
}

/**
 * Dismiss a suggested relation between two entries.
 * Silently ignores if the pair already exists.
 */
export async function dismissRelation(
  entryId: string,
  dismissedId: string,
): Promise<void> {
  await db
    .insert(codexDismissedRelations)
    .values({ entryId, dismissedId })
    .onConflictDoNothing();
}

/**
 * Un-dismiss a previously dismissed relation.
 */
export async function undismissRelation(
  entryId: string,
  dismissedId: string,
): Promise<void> {
  await db
    .delete(codexDismissedRelations)
    .where(
      and(
        eq(codexDismissedRelations.entryId, entryId),
        eq(codexDismissedRelations.dismissedId, dismissedId),
      ),
    );
}

/**
 * Set the parent of a codex entry.
 * Pass null to remove the parent.
 */
export async function setParentRelation(
  childId: string,
  parentId: string | null,
): Promise<void> {
  const current = await db
    .select({
      projectId: codexEntries.projectId,
      version: codexEntries.version,
    })
    .from(codexEntries)
    .where(eq(codexEntries.id, childId))
    .limit(1);
  const entry = current[0];
  if (!entry) return;
  await invoke("agent_codex_update", {
    payload: {
      projectId: entry.projectId,
      sessionId: getRecorderSessionId(),
      surface: "manual",
      entryId: childId,
      baseVersion: entry.version,
      parentId: parentId ?? "",
      model: null,
      chatMessageId: null,
      traceId: null,
      authorshipSpans: null,
      authorshipSpanLanes: null,
    },
  });
}
