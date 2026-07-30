import { db } from "@/db/client";
import { codexEntries } from "@/db/schema";
import { and, eq } from "drizzle-orm";

/** Read optimistic-lock version for a codex entry (column added by migration). */
export async function getCodexEntryVersion(
  projectId: string,
  entryId: string,
): Promise<number> {
  const [entry] = await db
    .select({ version: codexEntries.version })
    .from(codexEntries)
    .where(
      and(eq(codexEntries.id, entryId), eq(codexEntries.projectId, projectId)),
    )
    .limit(1);
  return entry?.version ?? 0;
}
