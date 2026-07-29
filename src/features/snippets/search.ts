import { db } from "@/db/client";
import { snippets } from "@/db/schema";
import { getCurrentProjectId } from "@/features/project/projectStore";
import { invoke } from "@/lib/tauri";
import { and, eq, inArray } from "drizzle-orm";

import type { Snippet } from "./api";

interface SparseSearchHit {
  sourceType: string;
  id: string;
}

/** Search snippets via the typed FTS command and hydrate full Drizzle rows. */
export async function searchSnippets(query: string): Promise<Snippet[]> {
  const trimmed = query.trim();
  if (trimmed.length === 0) return [];

  const projectId = getCurrentProjectId();
  const hits = await invoke<SparseSearchHit[]>("fts_search", {
    projectId,
    query: trimmed,
    scope: "snippets",
    limit: 50,
  });
  const hitIds = hits
    .filter((hit) => hit.sourceType === "snippet")
    .map((hit) => hit.id);
  if (hitIds.length === 0) return [];

  const rows = await db
    .select()
    .from(snippets)
    .where(
      and(eq(snippets.projectId, projectId), inArray(snippets.id, hitIds)),
    );
  const byId = new Map(rows.map((row) => [row.id, row]));
  return hitIds.flatMap((id) => {
    const row = byId.get(id);
    return row ? [row] : [];
  });
}
