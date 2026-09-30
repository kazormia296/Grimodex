import { db } from "@/db/client";
import { appSettings, projectSettings } from "@/db/schema";
import { eq, and, like } from "drizzle-orm";
import { recordChangeEvent } from "@/features/timelapse/recorder";
import { SCAN_IMPORT_STATE_KEY } from "@/features/import/scan/scanImportState";
import { invoke } from "@/lib/tauri";
import { getCurrentWorkspaceIdentity } from "@/runtime/workspaceIdentity";

export const NATIVE_OWNED_PROJECT_SETTING_ERROR =
  "NATIVE_OWNED_PROJECT_SETTING";
export const TIMELAPSE_RESET_SEQUENCE_KEY = "timelapse.resetSequence";

function assertMutableProjectSettingKey(key: string): void {
  if (key === SCAN_IMPORT_STATE_KEY || key === TIMELAPSE_RESET_SEQUENCE_KEY) {
    throw new Error(`${NATIVE_OWNED_PROJECT_SETTING_ERROR}: ${key}`);
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

/**
 * Read the Native-owned timelapse reset epoch. A malformed persisted value is
 * fail-closed: silently treating it as zero would resurrect history that a
 * user explicitly purged.
 */
export async function getTimelapseResetSequence(
  projectId: string,
): Promise<number> {
  const value = await getProjectSetting(
    projectId,
    TIMELAPSE_RESET_SEQUENCE_KEY,
  );
  if (value === null) return 0;
  const sequence = Number(value);
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new Error(
      "TIMELAPSE_HISTORY_INVALID_RESET_SEQUENCE: stored reset sequence is outside the safe integer range",
    );
  }
  return sequence;
}

export async function setProjectSetting(
  projectId: string,
  key: string,
  value: string,
): Promise<void> {
  assertMutableProjectSettingKey(key);
  if (key === "timelapse.enabled") {
    if (value !== "true" && value !== "false") {
      throw new Error(
        "TIMELAPSE_ENABLED_INVALID_VALUE: value must be exactly 'true' or 'false'",
      );
    }
    const workspaceIdentity = getCurrentWorkspaceIdentity();
    if (!workspaceIdentity) {
      throw new Error("Timelapse setting requires an active workspace");
    }
    await setTimelapseEnabledSetting(
      projectId,
      workspaceIdentity.path,
      value === "true",
    );
    return;
  }
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

/**
 * Update the timelapse flag through the path-bound Native writer. Callers that
 * coordinate a re-arm pass a path captured before their first await so a
 * workspace switch fails closed instead of mutating the replacement DB.
 */
export async function setTimelapseEnabledSetting(
  projectId: string,
  expectedWorkspacePath: string,
  enabled: boolean,
): Promise<void> {
  await invoke("timelapse_enabled_set", {
    expectedWorkspacePath,
    projectId,
    enabled,
  });
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
