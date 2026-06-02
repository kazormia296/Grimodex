import { db } from "@/db/client";
import { projects, lintTermDictionary } from "@/db/schema";
import { eq } from "drizzle-orm";

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
