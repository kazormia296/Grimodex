import { db } from "@/db/client";
import { codexEntries } from "@/db/schema";
import { eq } from "drizzle-orm";
import type { CodexEntry } from "./api";

export async function getChildren(parentId: string): Promise<CodexEntry[]> {
  return db
    .select()
    .from(codexEntries)
    .where(eq(codexEntries.parentId, parentId));
}

export async function getParent(entryId: string): Promise<CodexEntry | null> {
  const rows = await db
    .select()
    .from(codexEntries)
    .where(eq(codexEntries.id, entryId));
  const entry = rows[0];
  if (!entry?.parentId) return null;

  const parentRows = await db
    .select()
    .from(codexEntries)
    .where(eq(codexEntries.id, entry.parentId));
  return parentRows[0] ?? null;
}
