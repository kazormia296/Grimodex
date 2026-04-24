import { db } from "@/db/client";
import { codexQuickPins } from "@/db/schema";
import { eq, asc } from "drizzle-orm";

export async function listPinnedCodexIds(): Promise<string[]> {
  const rows = await db
    .select()
    .from(codexQuickPins)
    .orderBy(asc(codexQuickPins.createdAt));
  return rows.map((r) => r.entryId);
}

export async function addPinnedCodex(entryId: string): Promise<void> {
  await db
    .insert(codexQuickPins)
    .values({ entryId, createdAt: new Date().toISOString() })
    .onConflictDoNothing();
}

export async function removePinnedCodex(entryId: string): Promise<void> {
  await db.delete(codexQuickPins).where(eq(codexQuickPins.entryId, entryId));
}
