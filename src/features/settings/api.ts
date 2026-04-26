import { db } from "@/db/client";
import { appSettings } from "@/db/schema";
import { eq, like } from "drizzle-orm";

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
