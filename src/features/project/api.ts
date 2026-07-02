import { db } from "@/db/client";
import { projects, lintTermDictionary } from "@/db/schema";
import { eq } from "drizzle-orm";
import { invoke } from "@/lib/tauri";
import { recordChangeEvent } from "@/features/timelapse/recorder";

export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;

export async function listProjects(): Promise<Project[]> {
  return db.select().from(projects);
}

export async function getProject(id: string): Promise<Project | undefined> {
  const rows = await db.select().from(projects).where(eq(projects.id, id));
  return rows[0];
}

export async function createProject(
  data: Pick<NewProject, "id" | "title"> &
    Partial<
      Pick<
        NewProject,
        | "genre"
        | "pov"
        | "tense"
        | "language"
        | "styleGuide"
        | "aiInstructions"
        | "outline"
        | "targetReaders"
      >
    >,
): Promise<Project> {
  const now = new Date().toISOString();
  const rows = await db
    .insert(projects)
    .values({ ...data, createdAt: now, updatedAt: now })
    .returning();
  return rows[0];
}

export async function updateProject(
  id: string,
  data: Partial<
    Pick<
      NewProject,
      | "title"
      | "genre"
      | "pov"
      | "tense"
      | "language"
      | "styleGuide"
      | "aiInstructions"
      | "outline"
      | "targetReaders"
      | "aiPolicy"
    >
  >,
): Promise<Project | undefined> {
  const rows = await db
    .update(projects)
    .set({ ...data, updatedAt: new Date().toISOString() })
    .where(eq(projects.id, id))
    .returning();
  // A language switch re-routes which FTS tables a project's content lives in;
  // rebuild the English (_en) index so search stays consistent. Best-effort.
  if (data.language !== undefined) {
    await invoke("fts_rebuild_en").catch((e) => {
      // Don't swallow silently: a failed rebuild leaves English search stale
      // with no signal until the user manually rebuilds from settings.
      console.error(
        "fts_rebuild_en failed after language change; English search may be stale until a manual rebuild",
        e,
      );
    });
  }
  // Records under the currently-bound project (meta edits target the active
  // project). recordChangeEvent no-ops when that isn't the recording project.
  recordChangeEvent({
    domain: "project",
    opType: "meta.update",
    entityType: "project",
    entityId: id,
    payload: { projectId: id, fields: Object.keys(data) },
  });
  return rows[0];
}

export async function deleteProject(id: string): Promise<void> {
  // lint_term_dictionary.project_id is FK-cascaded only on fresh DBs; on DBs
  // upgraded via ALTER the column has no FK, so delete its rows explicitly to
  // avoid orphans (harmless on fresh DBs — the rows are already gone).
  await db
    .delete(lintTermDictionary)
    .where(eq(lintTermDictionary.projectId, id));
  await db.delete(projects).where(eq(projects.id, id));
}
