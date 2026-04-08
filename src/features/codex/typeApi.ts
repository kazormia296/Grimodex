import { db } from "@/db/client";
import { codexTypes } from "@/db/schema";
import { eq, and } from "drizzle-orm";

export type CodexType = typeof codexTypes.$inferSelect;

const BUILTIN_TYPES: Array<{
  slug: string;
  label: string;
  color: string;
  paletteIndex: number;
  sortOrder: number;
}> = [
  {
    slug: "character",
    label: "キャラクター",
    color: "#7F77DD",
    paletteIndex: 0,
    sortOrder: 1.0,
  },
  {
    slug: "location",
    label: "場所",
    color: "#1D9E75",
    paletteIndex: 1,
    sortOrder: 2.0,
  },
  {
    slug: "item",
    label: "アイテム",
    color: "#BA7517",
    paletteIndex: 2,
    sortOrder: 3.0,
  },
  {
    slug: "lore",
    label: "設定・世界観",
    color: "#D85A30",
    paletteIndex: 3,
    sortOrder: 4.0,
  },
];

export async function ensureBuiltinTypes(projectId: string): Promise<void> {
  const existing = await db
    .select()
    .from(codexTypes)
    .where(eq(codexTypes.projectId, projectId));

  const existingMap = new Map(existing.map((t) => [t.slug, t]));
  const existingSlugs = new Set(existing.map((t) => t.slug));

  for (const bt of BUILTIN_TYPES) {
    if (!existingSlugs.has(bt.slug)) {
      await db.insert(codexTypes).values({
        id: crypto.randomUUID(),
        projectId,
        slug: bt.slug,
        label: bt.label,
        color: bt.color,
        paletteIndex: bt.paletteIndex,
        isBuiltin: 1,
        sortOrder: bt.sortOrder,
        createdAt: new Date().toISOString(),
      });
    } else {
      // Migrate existing builtins that lack a palette index
      const existing_ = existingMap.get(bt.slug);
      if (existing_ && existing_.paletteIndex === null) {
        await db
          .update(codexTypes)
          .set({ paletteIndex: bt.paletteIndex })
          .where(eq(codexTypes.id, existing_.id));
      }
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

async function getNextPaletteIndex(projectId: string): Promise<number> {
  const rows = await db
    .select({ paletteIndex: codexTypes.paletteIndex })
    .from(codexTypes)
    .where(eq(codexTypes.projectId, projectId));
  const used = new Set(
    rows
      .map((r) => r.paletteIndex)
      .filter((i): i is number => i !== null && i !== undefined),
  );
  for (let i = 0; i < 10; i++) {
    if (!used.has(i)) return i;
  }
  // All 0-9 are taken — find next unused above 9
  let next = 10;
  while (used.has(next)) next++;
  return next;
}

export async function createCodexType(data: {
  projectId: string;
  slug: string;
  label: string;
  color?: string;
  paletteIndex?: number;
  sortOrder?: number;
}): Promise<CodexType> {
  const paletteIndex =
    data.paletteIndex !== undefined
      ? data.paletteIndex
      : await getNextPaletteIndex(data.projectId);
  const rows = await db
    .insert(codexTypes)
    .values({
      id: crypto.randomUUID(),
      projectId: data.projectId,
      slug: data.slug,
      label: data.label,
      color: data.color ?? "#888888",
      paletteIndex,
      isBuiltin: 0,
      sortOrder: data.sortOrder ?? 99.0,
      createdAt: new Date().toISOString(),
    })
    .returning();
  return rows[0];
}

export async function updateCodexType(
  id: string,
  data: Partial<
    Pick<CodexType, "label" | "color" | "sortOrder" | "paletteIndex">
  >,
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
