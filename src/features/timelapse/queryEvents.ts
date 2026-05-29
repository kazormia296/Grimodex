import { db } from "@/db/client";
import { changeEvents } from "@/db/schema";
import { and, asc, eq } from "drizzle-orm";

export type Domain =
  | "editor"
  | "codex"
  | "snippet"
  | "grid"
  | "map"
  | "synopsis"
  | "beat"
  // P0 (§17): chat conversation flow + panel/layout/focus motion.
  | "chat"
  | "layout";

/**
 * Fetch the project's change-event tail, ordered by sequence (ascending).
 *
 * The intended use is the in-app TimelapsePlayer scrubber: load all events
 * for a project, then filter / replay client-side. For very long histories
 * this will need pagination but P5's scope is "fits in memory".
 */
export async function loadProjectChangeEvents(projectId: string) {
  return db
    .select()
    .from(changeEvents)
    .where(eq(changeEvents.projectId, projectId))
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
  return db
    .select()
    .from(changeEvents)
    .where(
      and(
        eq(changeEvents.projectId, projectId),
        eq(changeEvents.sceneId, sceneId),
      ),
    )
    .orderBy(asc(changeEvents.sequence));
}
