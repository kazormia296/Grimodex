import { db } from "@/db/client";
import { codexQuickPins } from "@/db/schema";
import { eq } from "drizzle-orm";

export async function listPinnedCodexIds(): Promise<string[]> {
  const rows = await db.select().from(codexQuickPins);
  return rows.map((r) => r.entryId);
}

export async function addPinnedCodex(entryId: string): Promise<void> {
  await db.insert(codexQuickPins).values({ entryId }).onConflictDoNothing();
}

export async function removePinnedCodex(entryId: string): Promise<void> {
  await db.delete(codexQuickPins).where(eq(codexQuickPins.entryId, entryId));
}
