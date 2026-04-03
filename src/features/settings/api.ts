import { db } from "@/db/client";
import { settings } from "@/db/schema";
import { eq, like } from "drizzle-orm";

export async function getSetting(key: string): Promise<string | null> {
  const rows = await db.select().from(settings).where(eq(settings.key, key));
  return rows[0]?.value ?? null;
}

export async function setSetting(key: string, value: string): Promise<void> {
  await db
    .insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: settings.key, set: { value } });
}

export async function getSettingsByPrefix(
  prefix: string,
): Promise<Record<string, string>> {
  const rows = await db
    .select()
    .from(settings)
    .where(like(settings.key, `${prefix}%`));
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

export async function deleteSetting(key: string): Promise<void> {
  await db.delete(settings).where(eq(settings.key, key));
}
