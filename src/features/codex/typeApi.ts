import { db } from "@/db/client";
import { codexTypes } from "@/db/schema";
import { eq, and } from "drizzle-orm";

export type CodexType = typeof codexTypes.$inferSelect;

interface BuiltinType {
  slug: string;
  label: string;
  color: string;
  paletteIndex: number;
  sortOrder: number;
}

// 組み込み 4 タイプ。slug は言語非依存の安定キー (FK)。label のみ project
// 言語でシードし分ける (en プロジェクトは英語、それ以外は日本語)。
// 既存プロジェクトは ensureBuiltinTypes が同 slug を skip するため relabel
// されない (migration 不要・rename 可)。
const BUILTIN_TYPES: BuiltinType[] = [
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

// 英語ラベル版 (slug/color/paletteIndex/sortOrder は ja と同一)。
const BUILTIN_TYPES_EN: BuiltinType[] = [
  { ...BUILTIN_TYPES[0], label: "Character" },
  { ...BUILTIN_TYPES[1], label: "Location" },
  { ...BUILTIN_TYPES[2], label: "Item" },
  { ...BUILTIN_TYPES[3], label: "Lore & Worldbuilding" },
];

/** project 言語に対応する組み込みタイプ集合 (en 以外は ja)。 */
function builtinTypesForLang(lang?: string | null): BuiltinType[] {
  return lang?.startsWith("en") ? BUILTIN_TYPES_EN : BUILTIN_TYPES;
}

// DB トリガ (src-tauri/.../migrate.rs: seed_builtin_codex_types) は project
// INSERT 時に **言語非依存で常に日本語ラベル** で builtin タイプを seed する
// (character=キャラクター/location=場所/item=アイテム/lore=伝承)。legacy TS は
// lore に "設定・世界観" を使っていた。en プロジェクトではこの ja 既定ラベルを
// en へ relabel しないと BUILTIN_TYPES_EN が反映されない。
const JA_DEFAULT_BUILTIN_LABELS: Record<string, readonly string[]> = {
  character: ["キャラクター"],
  location: ["場所"],
  item: ["アイテム"],
  lore: ["伝承", "設定・世界観"],
};

/**
 * en プロジェクトで、トリガが ja で seed した **未カスタマイズ** の builtin
 * ラベルを en へ relabel すべきか判定する純関数。relabel する場合は新ラベル、
 * しない場合は null を返す。
 * - lang が en 系でない → null (ja 挙動不変)
 * - 既に en ラベル → null (冪等)
 * - 現ラベルが ja 既定でない (= ユーザがリネーム済み) → null (上書きしない)
 */
export function builtinLabelRelabel(
  slug: string,
  currentLabel: string,
  lang?: string | null,
): string | null {
  if (!lang?.startsWith("en")) return null;
  const enLabel = BUILTIN_TYPES_EN.find((t) => t.slug === slug)?.label;
  if (!enLabel || currentLabel === enLabel) return null;
  return (JA_DEFAULT_BUILTIN_LABELS[slug] ?? []).includes(currentLabel)
    ? enLabel
    : null;
}

export async function ensureBuiltinTypes(
  projectId: string,
  lang?: string | null,
): Promise<void> {
  const builtinTypes = builtinTypesForLang(lang);
  const existing = await db
    .select()
    .from(codexTypes)
    .where(eq(codexTypes.projectId, projectId));

  const existingMap = new Map(existing.map((t) => [t.slug, t]));
  const existingSlugs = new Set(existing.map((t) => t.slug));

  for (const bt of builtinTypes) {
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
      const existing_ = existingMap.get(bt.slug);
      if (existing_) {
        const updates: { paletteIndex?: number; label?: string } = {};
        // Migrate existing builtins that lack a palette index
        if (existing_.paletteIndex === null) {
          updates.paletteIndex = bt.paletteIndex;
        }
        // en: トリガが書いた ja 既定ラベルを en へ relabel (未カスタマイズのみ)。
        // 既存プロジェクトは ja 既定でなければ温存される (migration 不要・rename 可)。
        if (existing_.isBuiltin === 1) {
          const relabel = builtinLabelRelabel(bt.slug, existing_.label, lang);
          if (relabel !== null) updates.label = relabel;
        }
        if (Object.keys(updates).length > 0) {
          await db
            .update(codexTypes)
            .set(updates)
            .where(eq(codexTypes.id, existing_.id));
        }
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
  // Defense-in-depth: the UI hides delete for builtins, but a programmatic
  // call should still be rejected. Composite FK already blocks deletion when
  // entries reference the type, but does not protect builtin slugs themselves.
  const rows = await db
    .select({ isBuiltin: codexTypes.isBuiltin })
    .from(codexTypes)
    .where(eq(codexTypes.id, id));
  if (rows[0]?.isBuiltin === 1) {
    throw new Error("Cannot delete a builtin codex type");
  }
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
