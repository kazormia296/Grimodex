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
 * The intended use is the in-app TimelapsePlayer scrubber: load all events
 * for a project, then filter / replay client-side. For very long histories
 * this will need pagination but P5's scope is "fits in memory".
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
