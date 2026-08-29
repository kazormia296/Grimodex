import { db } from "@/db/client";
import { appSettings, projectSettings } from "@/db/schema";
import { eq, and, like } from "drizzle-orm";
import { recordChangeEvent } from "@/features/timelapse/recorder";
import { SCAN_IMPORT_STATE_KEY } from "@/features/import/scan/scanImportState";

export const NATIVE_OWNED_PROJECT_SETTING_ERROR =
  "NATIVE_OWNED_PROJECT_SETTING";

function assertMutableProjectSettingKey(key: string): void {
  if (key === SCAN_IMPORT_STATE_KEY) {
    throw new Error(
      `${NATIVE_OWNED_PROJECT_SETTING_ERROR}: ${SCAN_IMPORT_STATE_KEY}`,
    );
  }
}

/**
 * Keys we never surface in the timelapse: the recorder's own on/off control
 * (`timelapse.enabled`) would self-reference (it is written during the
 * OFF→ON re-arm), so recording it is noise. app_settings (global) are out of
 * scope entirely — only project_settings are recorded.
 */
function isRecordableProjectSettingKey(key: string): boolean {
  return key !== "editor.tabState" && !key.startsWith("timelapse.");
}

function shortSettingValue(value: string): string {
  return value.length > 120 ? `${value.slice(0, 120)}…` : value;
}

export async function getSetting(key: string): Promise<string | null> {
  const rows = await db
    .select()
    .from(appSettings)
    .where(eq(appSettings.key, key));
  return rows[0]?.value ?? null;
}

export async function setSetting(key: string, value: string): Promise<void> {
  await db
    .insert(appSettings)
    .values({ key, value })
    .onConflictDoUpdate({ target: appSettings.key, set: { value } });
}

export async function getSettingsByPrefix(
  prefix: string,
): Promise<Record<string, string>> {
  const rows = await db
    .select()
    .from(appSettings)
    .where(like(appSettings.key, `${prefix}%`));
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

export async function deleteSetting(key: string): Promise<void> {
  await db.delete(appSettings).where(eq(appSettings.key, key));
}

// --- Project-scoped settings ---

export async function getProjectSetting(
  projectId: string,
  key: string,
): Promise<string | null> {
  const rows = await db
    .select()
    .from(projectSettings)
    .where(
      and(
        eq(projectSettings.projectId, projectId),
        eq(projectSettings.key, key),
      ),
    );
  return rows[0]?.value ?? null;
}

export async function setProjectSetting(
  projectId: string,
  key: string,
  value: string,
): Promise<void> {
  assertMutableProjectSettingKey(key);
  await db
    .insert(projectSettings)
    .values({ projectId, key, value })
    .onConflictDoUpdate({
      target: [projectSettings.projectId, projectSettings.key],
      set: { value },
    });
  if (isRecordableProjectSettingKey(key)) {
    recordChangeEvent({
      domain: "settings",
      opType: "project.set",
      projectId,
      entityType: "project_setting",
      entityId: key,
      payload: { key, value: shortSettingValue(value) },
    });
  }
}

export async function deleteProjectSetting(
  projectId: string,
  key: string,
): Promise<void> {
  assertMutableProjectSettingKey(key);
  await db
    .delete(projectSettings)
    .where(
      and(
        eq(projectSettings.projectId, projectId),
        eq(projectSettings.key, key),
      ),
    );
  if (isRecordableProjectSettingKey(key)) {
    recordChangeEvent({
      domain: "settings",
      opType: "project.delete",
      projectId,
      entityType: "project_setting",
      entityId: key,
      payload: { key },
    });
  }
}

export async function getAllProjectSettings(
  projectId: string,
): Promise<Record<string, string>> {
  const rows = await db
    .select()
    .from(projectSettings)
    .where(eq(projectSettings.projectId, projectId));
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}
