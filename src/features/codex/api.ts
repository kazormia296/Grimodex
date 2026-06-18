import { db } from "@/db/client";
import { codexEntries, foreshadows, foreshadowCodexLinks } from "@/db/schema";
import { eq, and, inArray } from "drizzle-orm";
import { enqueueRescan } from "./mentionRescanQueue";
import { scheduleCodexIndex } from "@/features/semantic-search/scheduler";

/**
 * impact-review: この Codex に紐づく伏線を「Codex 変更で再評価が必要」とマークする。
 * codexLinkDirtyAt を現在時刻にし、伏線パネルの stale 判定 (isSetupEvaluationStale) で
 * 拾わせる。リンク無しなら no-op。失敗は非致命（保存自体は妨げない）。
 */
async function markLinkedForeshadowsDirty(entryId: string): Promise<void> {
  const links = await db
    .select({ foreshadowId: foreshadowCodexLinks.foreshadowId })
    .from(foreshadowCodexLinks)
    .where(eq(foreshadowCodexLinks.codexEntryId, entryId));
  if (links.length === 0) return;
  await db
    .update(foreshadows)
    .set({ codexLinkDirtyAt: new Date() })
    .where(
      inArray(
        foreshadows.id,
        links.map((l) => l.foreshadowId),
      ),
    );
}

export type CodexEntry = typeof codexEntries.$inferSelect;
export type NewCodexEntry = typeof codexEntries.$inferInsert;
export const BUILTIN_CODEX_TYPES = [
  "character",
  "location",
  "item",
  "lore",
] as const;
export type BuiltinCodexEntryType = (typeof BUILTIN_CODEX_TYPES)[number];
export type CodexEntryType = string;

export async function listCodexEntries(
  projectId: string,
  type?: CodexEntryType,
): Promise<CodexEntry[]> {
  const scope = eq(codexEntries.projectId, projectId);
  return db
    .select()
    .from(codexEntries)
    .where(type ? and(scope, eq(codexEntries.type, type)) : scope);
}

export async function getCodexEntry(
  projectId: string,
  id: string,
): Promise<CodexEntry | undefined> {
  const rows = await db
    .select()
    .from(codexEntries)
    .where(and(eq(codexEntries.id, id), eq(codexEntries.projectId, projectId)));
  return rows[0];
}

export async function createCodexEntry(
  data: Pick<NewCodexEntry, "id" | "projectId" | "type" | "name"> &
    Partial<
      Pick<
        NewCodexEntry,
        | "summary"
        | "tagsCache"
        | "aliases"
        | "excludedAliases"
        | "parentId"
        | "sourceChatMessageId"
      >
    >,
): Promise<CodexEntry> {
  const now = new Date().toISOString();
  const rows = await db
    .insert(codexEntries)
    .values({ ...data, createdAt: now, updatedAt: now })
    .returning();
  // 段階3: 新規エントリを semantic index へ (debounce + Rust 側 hash 再検証で冪等)。
  if (rows[0]) scheduleCodexIndex(rows[0].id);
  return rows[0];
}

export async function updateCodexEntry(
  projectId: string,
  id: string,
  data: Partial<
    Pick<
      NewCodexEntry,
      | "type"
      | "name"
      | "summary"
      | "content"
      | "tagsCache"
      | "aliases"
      | "excludedAliases"
      | "parentId"
      | "contextMode"
      | "icon"
      | "childrenBudget"
      | "notes"
    >
  >,
): Promise<CodexEntry | undefined> {
  const rows = await db
    .update(codexEntries)
    .set({ ...data, updatedAt: new Date().toISOString() })
    .where(and(eq(codexEntries.id, id), eq(codexEntries.projectId, projectId)))
    .returning();

  // If name/aliases/excludedAliases changed, body-mention cache may be stale
  if (
    data.name !== undefined ||
    data.aliases !== undefined ||
    data.excludedAliases !== undefined
  ) {
    enqueueRescan(id);
  }

  // 段階3: 埋め込み対象 (name/aliases/summary/content) が変わったら再 index。
  // notes/icon/contextMode 等のみの更新では発火しない (埋め込みに影響しない)。
  if (
    data.name !== undefined ||
    data.aliases !== undefined ||
    data.summary !== undefined ||
    data.content !== undefined
  ) {
    scheduleCodexIndex(id);
    // impact-review: 埋め込みに効く変更＝伏線整合性にも効きうる変更。
    // リンク伏線を再評価対象としてマーク（非致命なので失敗は飲み込む）。
    try {
      await markLinkedForeshadowsDirty(id);
    } catch {
      /* foreshadow dirty マークの失敗は保存を妨げない */
    }
  }

  return rows[0];
}

export async function deleteCodexEntry(
  projectId: string,
  id: string,
): Promise<void> {
  await db
    .delete(codexEntries)
    .where(and(eq(codexEntries.id, id), eq(codexEntries.projectId, projectId)));
}

export async function listCodexEntriesByMessageId(
  messageId: string,
): Promise<CodexEntry[]> {
  return db
    .select()
    .from(codexEntries)
    .where(eq(codexEntries.sourceChatMessageId, messageId));
}
