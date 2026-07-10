import { db } from "@/db/client";
import { codexEntries, foreshadows, foreshadowCodexLinks } from "@/db/schema";
import { eq, and, inArray } from "drizzle-orm";
import { enqueueRescan } from "./mentionRescanQueue";
import { scheduleCodexIndex } from "@/features/semantic-search/scheduler";
import { CodexVersionConflictError } from "./occ";

/**
 * impact-review: この Codex に紐づく伏線を「Codex 変更で再評価が必要」とマークする。
 * codexLinkDirtyAt を現在時刻にし、伏線パネルの stale 判定 (isSetupEvaluationStale) で
 * 拾わせる。リンク無しなら no-op。失敗は非致命（保存自体は妨げない）。
 */
async function markLinkedForeshadowsDirty(
  projectId: string,
  entryId: string,
): Promise<void> {
  const links = await db
    .select({ foreshadowId: foreshadowCodexLinks.foreshadowId })
    .from(foreshadowCodexLinks)
    .where(eq(foreshadowCodexLinks.codexEntryId, entryId));
  if (links.length === 0) return;
  await db
    .update(foreshadows)
    .set({ codexLinkDirtyAt: new Date() })
    .where(
      and(
        eq(foreshadows.projectId, projectId),
        inArray(
          foreshadows.id,
          links.map((l) => l.foreshadowId),
        ),
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

// ---------------------------------------------------------------------------
// M10: 用途別 projection (Phase 1)
// listCodexEntries は全列 SELECT で、重い列 (content=PM JSON 本文 /
// icon=base64 WebP / notes=プライベート PM JSON) を毎回転送していた。
// mention 検出だけの経路・AI 文脈構築の経路・timelapse ベースラインの経路は
// 必要列が固定なので、列を絞った専用 API に分ける。
// codexStore（一覧/編集面/undo が全列に依存）は従来通り listCodexEntries を使う。
// ---------------------------------------------------------------------------

/** mention 検出 (CodexMatchTarget) に必要な 5 列だけの行。 */
export type CodexMatchRow = Pick<
  CodexEntry,
  "id" | "name" | "type" | "aliases" | "excludedAliases"
>;

/**
 * AI 文脈構築用: icon / notes / readings の 3 列を除いた行。content は L4 注入・
 * children budget・reverse mention 走査が全件横断で読むため残す。
 * notes は「AI 文脈には注入しない」列 (schema comment 参照)。readings は IME 辞書・
 * ルビ・ソート用のメタデータで物語本文ではないため AI 文脈には注入しない。
 */
export type CodexContextEntry = Omit<CodexEntry, "icon" | "notes" | "readings">;

/**
 * mention 検出の match target 専用の軽量 projection。
 * content / icon / notes を転送しない。
 */
export async function listCodexMatchTargets(
  projectId: string,
  type?: CodexEntryType,
): Promise<CodexMatchRow[]> {
  const scope = eq(codexEntries.projectId, projectId);
  return db
    .select({
      id: codexEntries.id,
      name: codexEntries.name,
      type: codexEntries.type,
      aliases: codexEntries.aliases,
      excludedAliases: codexEntries.excludedAliases,
    })
    .from(codexEntries)
    .where(type ? and(scope, eq(codexEntries.type, type)) : scope);
}

/**
 * AI 文脈構築 (chat L4 / エクスポートのキャラクターブック) 用 projection。
 * icon (base64 画像) と notes (注入禁止のプライベートメモ) だけを落とす。
 */
export async function listCodexEntriesForContext(
  projectId: string,
  type?: CodexEntryType,
): Promise<CodexContextEntry[]> {
  const scope = eq(codexEntries.projectId, projectId);
  return db
    .select({
      id: codexEntries.id,
      projectId: codexEntries.projectId,
      parentId: codexEntries.parentId,
      type: codexEntries.type,
      name: codexEntries.name,
      aliases: codexEntries.aliases,
      excludedAliases: codexEntries.excludedAliases,
      summary: codexEntries.summary,
      content: codexEntries.content,
      tagsCache: codexEntries.tagsCache,
      contextMode: codexEntries.contextMode,
      childrenBudget: codexEntries.childrenBudget,
      sourceChatMessageId: codexEntries.sourceChatMessageId,
      createdAt: codexEntries.createdAt,
      updatedAt: codexEntries.updatedAt,
      version: codexEntries.version,
    })
    .from(codexEntries)
    .where(type ? and(scope, eq(codexEntries.type, type)) : scope);
}

/** timelapse ベースライン記録用: id + content (PM JSON) のみ。 */
export async function listCodexContentsForBaseline(
  projectId: string,
): Promise<Array<{ id: string; content: string }>> {
  return db
    .select({ id: codexEntries.id, content: codexEntries.content })
    .from(codexEntries)
    .where(eq(codexEntries.projectId, projectId));
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
        | "readings"
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
      | "readings"
      | "parentId"
      | "contextMode"
      | "icon"
      | "childrenBudget"
      | "notes"
    >
  >,
  opts?: { baseVersion?: number },
): Promise<CodexEntry | undefined> {
  // OCC: baseVersion 指定時のみ条件付き UPDATE (version 照合 + インクリメント)。
  // 省略時は従来通りの blind UPDATE で完全後方互換 (version 列は触らない)。
  const useOcc = opts?.baseVersion !== undefined;
  const baseVersion = opts?.baseVersion ?? 0;
  const rows = await db
    .update(codexEntries)
    .set(
      useOcc
        ? {
            ...data,
            version: baseVersion + 1,
            updatedAt: new Date().toISOString(),
          }
        : { ...data, updatedAt: new Date().toISOString() },
    )
    .where(
      useOcc
        ? and(
            eq(codexEntries.id, id),
            eq(codexEntries.projectId, projectId),
            eq(codexEntries.version, baseVersion),
          )
        : and(eq(codexEntries.id, id), eq(codexEntries.projectId, projectId)),
    )
    .returning();

  // 0 件マッチ。OCC 有効時は「行が存在するのに 0 件」= version 衝突として
  // CodexVersionConflictError を投げ、呼び出し側に非破壊リロードを委ねる。
  // 行が存在しないなら従来通り undefined (別プロジェクト等のスコープ miss)。
  // OCC 無効時は従来通り undefined。
  // どちらの 0 件でも後続の副作用 (rescan/index/伏線 dirty) は走らせない。
  // 特に markLinkedForeshadowsDirty は projectId 非依存なので、ここで
  // 早期 return しないと別プロジェクトの伏線を汚染しうる。
  if (!rows[0]) {
    if (useOcc) {
      const exists = await db
        .select({ id: codexEntries.id })
        .from(codexEntries)
        .where(
          and(eq(codexEntries.id, id), eq(codexEntries.projectId, projectId)),
        )
        .limit(1);
      if (exists[0]) throw new CodexVersionConflictError(id);
    }
    return undefined;
  }

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
      await markLinkedForeshadowsDirty(projectId, id);
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
