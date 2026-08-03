import { db } from "@/db/client";
import { snippets } from "@/db/schema";
import { eq, and, sql, desc } from "drizzle-orm";
import { SnippetVersionConflictError } from "./occ";
import { chatPersistenceDeletionGuard } from "@/lib/chatPersistenceDeletionGuard";
import {
  ChatAnchorDeletionBlockedError,
  tryAcquireChatAnchorDeletionLease,
} from "@/lib/chatNavigationGuard";
import { notifySnippetDeleted } from "./anchorNotify";

export type Snippet = Omit<typeof snippets.$inferSelect, "contentSource"> & {
  contentSource?: string | null;
};
export type NewSnippet = typeof snippets.$inferInsert;

export async function listSnippets(
  projectId: string,
  sceneId?: string,
): Promise<Snippet[]> {
  const scope = eq(snippets.projectId, projectId);
  return db
    .select()
    .from(snippets)
    .where(sceneId ? and(scope, eq(snippets.sceneId, sceneId)) : scope)
    .orderBy(desc(snippets.createdAt));
}

export async function getSnippet(
  projectId: string,
  id: string,
): Promise<Snippet | undefined> {
  const rows = await db
    .select()
    .from(snippets)
    .where(and(eq(snippets.id, id), eq(snippets.projectId, projectId)));
  return rows[0];
}

export async function createSnippet(
  data: Pick<NewSnippet, "id" | "projectId" | "title" | "content"> &
    Partial<
      Pick<
        NewSnippet,
        "tagsCache" | "sceneId" | "sourceChatMessageId" | "contentSource"
      >
    >,
): Promise<Snippet> {
  const now = new Date().toISOString();
  const rows = await db
    .insert(snippets)
    .values({ ...data, createdAt: now, updatedAt: now })
    .returning();
  return rows[0];
}

export async function updateSnippet(
  projectId: string,
  id: string,
  data: Partial<
    Pick<NewSnippet, "title" | "content" | "tagsCache" | "sceneId">
  >,
  opts?: { baseVersion?: number },
): Promise<Snippet | undefined> {
  // OCC: baseVersion 指定時のみ条件付き UPDATE (version 照合 + インクリメント)。
  // 省略時は従来通りの blind UPDATE で完全後方互換 (version 列は触らない)。
  // codex の updateCodexEntry (codex/api.ts) と同型。
  const useOcc = opts?.baseVersion !== undefined;
  const baseVersion = opts?.baseVersion ?? 0;
  const rows = await db
    .update(snippets)
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
            eq(snippets.id, id),
            eq(snippets.projectId, projectId),
            eq(snippets.version, baseVersion),
          )
        : and(eq(snippets.id, id), eq(snippets.projectId, projectId)),
    )
    .returning();

  // 0 件マッチ。OCC 有効時は「行が存在するのに 0 件」= version 衝突として
  // SnippetVersionConflictError を投げ、呼び出し側に非破壊リロードを委ねる。
  // 行が存在しないなら従来通り undefined (別プロジェクト等のスコープ miss)。
  if (!rows[0]) {
    if (useOcc) {
      const exists = await db
        .select({ id: snippets.id })
        .from(snippets)
        .where(and(eq(snippets.id, id), eq(snippets.projectId, projectId)))
        .limit(1);
      if (exists[0]) throw new SnippetVersionConflictError(id);
    }
    return undefined;
  }
  return rows[0];
}

export async function deleteSnippet(
  projectId: string,
  id: string,
): Promise<void> {
  const deletionAuthority = tryAcquireChatAnchorDeletionLease();
  if (!deletionAuthority) throw new ChatAnchorDeletionBlockedError();
  try {
    chatPersistenceDeletionGuard.assertDeletionAllowed();
    await db
      .delete(snippets)
      .where(and(eq(snippets.id, id), eq(snippets.projectId, projectId)));
    notifySnippetDeleted(id);
  } finally {
    deletionAuthority.release();
  }
}

export async function listSnippetsByMessageId(
  messageId: string,
): Promise<Snippet[]> {
  return db
    .select()
    .from(snippets)
    .where(eq(snippets.sourceChatMessageId, messageId));
}

export async function incrementSnippetUsageCount(
  projectId: string,
  id: string,
): Promise<void> {
  await db
    .update(snippets)
    .set({ usageCount: sql`${snippets.usageCount} + 1` })
    .where(and(eq(snippets.id, id), eq(snippets.projectId, projectId)));
}
