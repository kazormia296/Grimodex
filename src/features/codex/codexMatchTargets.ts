import { db } from "@/db/client";
import { codexEntries } from "@/db/schema";
import { and, eq } from "drizzle-orm";

type CodexEntry = typeof codexEntries.$inferSelect;

export type CodexEntryType = string;

/**
 * Renderer-side matching projection.
 *
 * name / aliases are used by mentions and completion, while readings are used
 * for automatic ruby. Heavy body, image, and private-note columns stay out.
 */
export type CodexMatchRow = Pick<
  CodexEntry,
  "id" | "name" | "type" | "aliases" | "excludedAliases"
> &
  Partial<Pick<CodexEntry, "readings">>;

export async function listCodexMatchTargets(
  projectId: string,
  type?: CodexEntryType,
): Promise<CodexMatchRow[]> {
  const scope = eq(codexEntries.projectId, projectId);
  return db
    .select({
      id: codexEntries.id,
      name: codexEntries.name,
      type: codexEntries.type,
      aliases: codexEntries.aliases,
      excludedAliases: codexEntries.excludedAliases,
      readings: codexEntries.readings,
    })
    .from(codexEntries)
    .where(type ? and(scope, eq(codexEntries.type, type)) : scope);
}
