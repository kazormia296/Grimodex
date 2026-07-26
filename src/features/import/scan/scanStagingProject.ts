import { db } from "@/db/client";
import { projectSettings, projects } from "@/db/schema";
import { and, eq, lte } from "drizzle-orm";
import { invoke } from "@/lib/tauri";
import { deleteProject } from "@/features/project/api";
import { SCAN_IMPORT_STATE_KEY, SCAN_IMPORT_STAGING } from "./scanImportState";

const STALE_SCAN_IMPORT_TTL_MS = 24 * 60 * 60 * 1000;
const STALE_SCAN_IMPORT_BATCH_SIZE = 20;

/**
 * Create the project and its hidden staging marker in one native transaction.
 * A renderer crash must never expose a half-created Scan import as a normal
 * project in the switcher.
 */
export async function createScanStagingProject(input: {
  id: string;
  title: string;
  language: "ja" | "en";
}): Promise<void> {
  const now = new Date().toISOString();
  const project = db
    .insert(projects)
    .values({
      id: input.id,
      title: input.title,
      language: input.language,
      createdAt: now,
      updatedAt: now,
    })
    .toSQL();
  const stagingMarker = db
    .insert(projectSettings)
    .values({
      projectId: input.id,
      key: SCAN_IMPORT_STATE_KEY,
      value: SCAN_IMPORT_STAGING,
    })
    .onConflictDoUpdate({
      target: [projectSettings.projectId, projectSettings.key],
      set: { value: SCAN_IMPORT_STAGING },
    })
    .toSQL();

  await invoke("db_execute_batch", {
    statements: [project, stagingMarker].map((statement) => ({
      sql: statement.sql,
      params: statement.params,
      method: "run",
    })),
  });
}

/**
 * Remove hidden imports left behind by a renderer/process crash. A generous
 * grace period ensures a live import is never reclaimed during normal work,
 * while the bounded batch keeps workspace startup predictable.
 */
export async function cleanupStaleScanStagingProjects(
  now = new Date(),
): Promise<number> {
  const staleBefore = new Date(
    now.getTime() - STALE_SCAN_IMPORT_TTL_MS,
  ).toISOString();
  const staleRows = await db
    .select({ projectId: projectSettings.projectId })
    .from(projectSettings)
    .innerJoin(projects, eq(projects.id, projectSettings.projectId))
    .where(
      and(
        eq(projectSettings.key, SCAN_IMPORT_STATE_KEY),
        eq(projectSettings.value, SCAN_IMPORT_STAGING),
        lte(projects.createdAt, staleBefore),
      ),
    )
    .limit(STALE_SCAN_IMPORT_BATCH_SIZE);
  const projectIds = staleRows.map((row) => row.projectId);
  if (projectIds.length === 0) return 0;
  for (const projectId of projectIds) await deleteProject(projectId);
  return projectIds.length;
}
