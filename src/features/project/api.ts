import { db } from "@/db/client";
import { projects } from "@/db/schema";
import { eq } from "drizzle-orm";

export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;

export async function listProjects(): Promise<Project[]> {
  return db.select().from(projects);
}

export async function getProject(id: number): Promise<Project | undefined> {
  const rows = await db.select().from(projects).where(eq(projects.id, id));
  return rows[0];
}

export async function createProject(
  data: Pick<NewProject, "title" | "description">,
): Promise<Project> {
  const now = new Date().toISOString();
  const rows = await db
    .insert(projects)
    .values({ ...data, createdAt: now, updatedAt: now })
    .returning();
  return rows[0];
}

export async function updateProject(
  id: number,
  data: Partial<Pick<NewProject, "title" | "description">>,
): Promise<Project | undefined> {
  const rows = await db
    .update(projects)
    .set({ ...data, updatedAt: new Date().toISOString() })
    .where(eq(projects.id, id))
    .returning();
  return rows[0];
}

export async function deleteProject(id: number): Promise<void> {
  await db.delete(projects).where(eq(projects.id, id));
}
