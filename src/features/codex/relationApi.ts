import { db } from "@/db/client";
import { codexDismissedRelations, codexEntries } from "@/db/schema";
import { eq, and } from "drizzle-orm";

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
  await db
    .update(codexEntries)
    .set({ parentId, updatedAt: new Date().toISOString() })
    .where(eq(codexEntries.id, childId));
}
