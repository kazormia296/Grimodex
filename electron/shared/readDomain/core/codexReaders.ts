import { and, eq, inArray } from "drizzle-orm";

import type { CoreReadDb } from "../../mastraRead/ports.js";
import {
  codexEntries,
  codexEntryPhases,
  type CodexEntryPhase,
} from "../db/schema.js";

/**
 * The Drizzle selects of the Codex visibility decision (Mastra migration MP-4b
 * PR-8a, DR-MP4-39). The statements are those of the renderer's
 * `resolveCodexForAi` (the entries select) and `listPhasesByEntryIds` (the
 * phases select): the same columns, the same condition, the same order.
 *
 * They take the ids they are given and do not chunk or check them
 * (`codexVisibility.ts` does both). Both are awaited as arrays, in the shapes
 * the pre-send check (`mastraRead/sql.ts`) accepts, and name `codex_entries` and
 * `codex_entry_phases`, both in `MAIN_READ_TABLES`.
 */

/** A row of the entries select. `content` is there only when it was asked for. */
export type CodexVisibilityEntryRow =
  | { id: string; summary: string | null; contextMode: string }
  | {
      id: string;
      summary: string | null;
      contextMode: string;
      content: string | null;
    };

/**
 * The entries of one project among `ids`: `id`, `summary` and `contextMode`
 * (and `content` when `withContent`). The project condition is always in the
 * statement. An id the database does not return (not an entry, or an entry of
 * another project) is simply absent; the caller counts it as hidden.
 */
export async function readCodexVisibilityEntries(
  db: CoreReadDb,
  projectId: string,
  ids: readonly string[],
  withContent: boolean,
): Promise<CodexVisibilityEntryRow[]> {
  const baseColumns = {
    id: codexEntries.id,
    summary: codexEntries.summary,
    contextMode: codexEntries.contextMode,
  };
  return db
    .select(
      withContent
        ? { ...baseColumns, content: codexEntries.content }
        : baseColumns,
    )
    .from(codexEntries)
    .where(
      and(
        eq(codexEntries.projectId, projectId),
        inArray(codexEntries.id, [...ids]),
      ),
    );
}

/**
 * Every column of every phase of the given entries, oldest first (the resolver
 * orders them again, so the order carries no meaning).
 *
 * The caller passes only ids of entries it read under a project condition:
 * `codex_entry_phases` has no `project_id` column, so this reader cannot enforce
 * the project (an id of another project's entry would return that entry's
 * phases). An empty list reads nothing.
 */
export async function readCodexPhases(
  db: CoreReadDb,
  entryIds: readonly string[],
): Promise<CodexEntryPhase[]> {
  if (entryIds.length === 0) return [];
  return db
    .select()
    .from(codexEntryPhases)
    .where(inArray(codexEntryPhases.entryId, [...entryIds]))
    .orderBy(codexEntryPhases.createdAt);
}
