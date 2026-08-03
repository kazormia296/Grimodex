import { db } from "@/db/client";
import { codexEntries } from "@/db/schema";
import { invoke } from "@/lib/tauri";
import { and, eq, inArray, like, or } from "drizzle-orm";

import type { CodexEntry } from "./api";

interface SparseSearchHit {
  sourceType: string;
  id: string;
}

function orderByHitIds<T extends { id: string }>(
  rows: T[],
  hitIds: string[],
): T[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  return hitIds.flatMap((id) => {
    const row = byId.get(id);
    return row ? [row] : [];
  });
}

/**
 * Search codex entries through the typed FTS repository, then hydrate the
 * complete Drizzle entity rows. `projectId` is required by app callsites; the
 * optional unscoped fallback remains for legacy callers and uses typed Drizzle
 * predicates rather than the generic SQL bridge.
 */
export async function searchCodexEntries(
  query: string,
  projectId?: string,
): Promise<CodexEntry[]> {
  const trimmed = query.trim();
  if (trimmed.length === 0) return [];

  if (!projectId) {
    const pattern = `%${trimmed}%`;
    return db
      .select()
      .from(codexEntries)
      .where(
        or(
          like(codexEntries.name, pattern),
          like(codexEntries.summary, pattern),
          like(codexEntries.tagsCache, pattern),
          like(codexEntries.content, pattern),
        ),
      );
  }

  const hits = await invoke<SparseSearchHit[]>("fts_search", {
    projectId,
    query: trimmed,
    scope: "codex",
    limit: 50,
  });
  const hitIds = hits
    .filter((hit) => hit.sourceType === "codex")
    .map((hit) => hit.id);
  if (hitIds.length === 0) return [];

  const rows = await db
    .select()
    .from(codexEntries)
    .where(
      and(
        eq(codexEntries.projectId, projectId),
        inArray(codexEntries.id, hitIds),
      ),
    );
  return orderByHitIds(rows, hitIds);
}
