import { db } from "@/db/client";
import { codexTypes } from "@/db/schema";
import { eq, and } from "drizzle-orm";

export type CodexType = typeof codexTypes.$inferSelect;

const BUILTIN_TYPES: Array<{
  slug: string;
  label: string;
  color: string;
  sortOrder: number;
}> = [
  {
    slug: "character",
    label: "キャラクター",
    color: "#7F77DD",
    sortOrder: 1.0,
  },
  { slug: "location", label: "場所", color: "#1D9E75", sortOrder: 2.0 },
  { slug: "item", label: "アイテム", color: "#BA7517", sortOrder: 3.0 },
  { slug: "lore", label: "設定・世界観", color: "#D85A30", sortOrder: 4.0 },
];

export async function ensureBuiltinTypes(projectId: string): Promise<void> {
  const existing = await db
    .select()
    .from(codexTypes)
    .where(eq(codexTypes.projectId, projectId));

  const existingSlugs = new Set(existing.map((t) => t.slug));

  for (const bt of BUILTIN_TYPES) {
    if (!existingSlugs.has(bt.slug)) {
      await db.insert(codexTypes).values({
        id: crypto.randomUUID(),
        projectId,
        slug: bt.slug,
        label: bt.label,
        color: bt.color,
        isBuiltin: 1,
        sortOrder: bt.sortOrder,
        createdAt: new Date().toISOString(),
      });
    }
  }
}

export async function listCodexTypes(projectId: string): Promise<CodexType[]> {
  return db
    .select()
    .from(codexTypes)
    .where(eq(codexTypes.projectId, projectId))
    .orderBy(codexTypes.sortOrder);
}

export async function createCodexType(data: {
  projectId: string;
  slug: string;
  label: string;
  color?: string;
  sortOrder?: number;
}): Promise<CodexType> {
  const rows = await db
    .insert(codexTypes)
    .values({
      id: crypto.randomUUID(),
      projectId: data.projectId,
      slug: data.slug,
      label: data.label,
      color: data.color ?? "#888888",
      isBuiltin: 0,
      sortOrder: data.sortOrder ?? 99.0,
      createdAt: new Date().toISOString(),
    })
    .returning();
  return rows[0];
}

export async function updateCodexType(
  id: string,
  data: Partial<Pick<CodexType, "label" | "color" | "sortOrder">>,
): Promise<CodexType | undefined> {
  const rows = await db
    .update(codexTypes)
    .set(data)
    .where(eq(codexTypes.id, id))
    .returning();
  return rows[0];
}

export async function deleteCodexType(id: string): Promise<void> {
  await db.delete(codexTypes).where(eq(codexTypes.id, id));
}

export async function codexTypeHasEntries(
  projectId: string,
  slug: string,
): Promise<boolean> {
  const { codexEntries } = await import("@/db/schema");
  const rows = await db
    .select({ id: codexEntries.id })
    .from(codexEntries)
    .where(
      and(eq(codexEntries.projectId, projectId), eq(codexEntries.type, slug)),
    );
  return rows.length > 0;
}
