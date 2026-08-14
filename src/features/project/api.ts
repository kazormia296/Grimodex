import { db } from "@/db/client";
import { projects, projectSettings } from "@/db/schema";
import { and, eq, notExists } from "drizzle-orm";
import {
  SCAN_IMPORT_STATE_KEY,
  SCAN_IMPORT_STAGING,
} from "@/features/import/scan/scanImportState";
import { invoke } from "@/lib/tauri";
import {
  cancelScheduledImeExports,
  scheduleImeExportRefresh,
} from "@/features/ime/scheduler";
import { removeImeProjectExportWithRetry } from "@/features/ime/api";
import { getCurrentImeWorkspaceIdentity } from "@/features/ime/workspaceScope";
import { pendingCompletedTurnPersistence } from "@/application/chat/pendingCompletedTurnPersistence";
import {
  createCanonicalWriteContext,
  type CanonicalWriteReceipt,
} from "@/features/native-writes/writeContext";

export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;

const IME_PROJECT_FIELDS = new Set(["title", "genre", "outline", "language"]);

export async function listProjects(): Promise<Project[]> {
  const stagingProject = db
    .select({ projectId: projectSettings.projectId })
    .from(projectSettings)
    .where(
      and(
        eq(projectSettings.projectId, projects.id),
        eq(projectSettings.key, SCAN_IMPORT_STATE_KEY),
        eq(projectSettings.value, SCAN_IMPORT_STAGING),
      ),
    );
  return db.select().from(projects).where(notExists(stagingProject));
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
  const result = await invoke<
    Project & { __writeReceipt: CanonicalWriteReceipt }
  >("project_create", {
    payload: {
      ...createCanonicalWriteContext("human"),
      projectId: data.id,
      title: data.title,
      genre: data.genre ?? null,
      pov: data.pov ?? null,
      tense: data.tense ?? null,
      language: data.language ?? null,
      styleGuide: data.styleGuide ?? null,
      aiInstructions: data.aiInstructions ?? null,
      outline: data.outline ?? null,
      targetReaders: data.targetReaders ?? null,
      createdAt: now,
      updatedAt: now,
    },
  });
  const { __writeReceipt: _receipt, ...project } = result;
  return project as Project;
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
      | "phaseResolutionMode"
    >
  >,
  options?: { suppressImeExport?: boolean },
): Promise<Project | undefined> {
  const current = await getProject(id);
  if (!current) return undefined;
  const updatedAt = new Date().toISOString();
  const result = await invoke<
    Project & { __writeReceipt: CanonicalWriteReceipt }
  >("project_patch", {
    payload: {
      ...createCanonicalWriteContext("human"),
      projectId: id,
      baseUpdatedAt: current.updatedAt,
      updatedAt,
      patch: data,
    },
  });
  const { __writeReceipt: _receipt, ...project } = result;
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
  // Project metadata is already recorded by the Native writer in the same
  // transaction; only schedule the dependent IME export after that commit.
  if (
    !options?.suppressImeExport &&
    Object.keys(data).some((field) => IME_PROJECT_FIELDS.has(field))
  ) {
    scheduleImeExportRefresh(id);
  }
  return project as Project;
}

export async function deleteProject(id: string): Promise<void> {
  const imeWorkspaceIdentity = getCurrentImeWorkspaceIdentity();
  pendingCompletedTurnPersistence.assertNone({
    kind: "project",
    workspaceIdentity: imeWorkspaceIdentity,
    projectId: id,
  });
  // A pending pre-delete refresh would otherwise race the native remove gate:
  // refresh can become latest, fail on the deleted DB row, and leave the old
  // plaintext snapshot behind.
  cancelScheduledImeExports(id);
  await invoke("project_delete", { payload: { projectId: id } });
  // The DB delete is authoritative; cleanup has a bounded background retry so
  // a transient filesystem failure cannot leave plaintext indefinitely.
  // Cancel again after the awaited DB work: another window/local mutation may
  // have scheduled while deletion was in flight.
  cancelScheduledImeExports(id);
  await removeImeProjectExportWithRetry(id, imeWorkspaceIdentity);
}
