import { db } from "@/db/client";
import { appSettings, projectSettings } from "@/db/schema";
import { eq, and, like } from "drizzle-orm";

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
  await db
    .insert(projectSettings)
    .values({ projectId, key, value })
    .onConflictDoUpdate({
      target: [projectSettings.projectId, projectSettings.key],
      set: { value },
    });
}

export async function deleteProjectSetting(
  projectId: string,
  key: string,
): Promise<void> {
  await db
    .delete(projectSettings)
    .where(
      and(
        eq(projectSettings.projectId, projectId),
        eq(projectSettings.key, key),
      ),
    );
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
