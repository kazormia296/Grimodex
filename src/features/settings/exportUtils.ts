import { db } from "@/db/client";
import { codexEntries, codexTypes } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getCurrentProjectId } from "@/features/project/projectStore";

export async function exportCodexJson(): Promise<string> {
  const types = await db
    .select()
    .from(codexTypes)
    .where(eq(codexTypes.projectId, getCurrentProjectId()));

  const entries = await db
    .select()
    .from(codexEntries)
    .where(eq(codexEntries.projectId, getCurrentProjectId()));

  const typeMap = Object.fromEntries(types.map((t) => [t.slug, t.label]));

  const data = entries.map((e) => ({
    id: e.id,
    type: typeMap[e.type] ?? e.type,
    name: e.name,
    aliases: e.aliases ? JSON.parse(e.aliases) : [],
    summary: e.summary ?? "",
  }));

  return JSON.stringify(data, null, 2);
}
