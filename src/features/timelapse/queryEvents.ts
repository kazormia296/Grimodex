import { db } from "@/db/client";
import { changeEvents } from "@/db/schema";
import { getTimelapseResetSequence } from "@/features/settings/api";
import { and, asc, eq, gt } from "drizzle-orm";

// Re-export the canonical union from the recorder so the recorded-domain set
// stays single-sourced (was a hand-maintained duplicate that drifted).
export type { Domain } from "./recorder";

/**
 * Fetch the project's change-event tail, ordered by sequence (ascending).
 *
 * Export consumers load the project tail, then filter and replay client-side.
 * This currently requires the selected history to fit in memory.
 */
export async function loadProjectChangeEvents(projectId: string) {
  const resetSequence = await getTimelapseResetSequence(projectId);
  return db
    .select()
    .from(changeEvents)
    .where(
      and(
        eq(changeEvents.projectId, projectId),
        gt(changeEvents.sequence, resetSequence),
      ),
    )
    .orderBy(asc(changeEvents.sequence));
}

/**
 * Fetch events for a single scene, ordered by sequence (ascending).
 *
 * Used by the editor-body replay preview where positions must stay coherent
 * within one document.
 */
export async function loadSceneChangeEvents(
  projectId: string,
  sceneId: string,
) {
  const resetSequence = await getTimelapseResetSequence(projectId);
  return db
    .select()
    .from(changeEvents)
    .where(
      and(
        eq(changeEvents.projectId, projectId),
        eq(changeEvents.sceneId, sceneId),
        gt(changeEvents.sequence, resetSequence),
      ),
    )
    .orderBy(asc(changeEvents.sequence));
}
