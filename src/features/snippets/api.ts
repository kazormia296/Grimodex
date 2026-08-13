import { db } from "@/db/client";
import { snippets } from "@/db/schema";
import { eq, and, sql, desc } from "drizzle-orm";
import { invoke } from "@/lib/tauri";
import { SnippetVersionConflictError } from "./occ";
import { chatPersistenceDeletionGuard } from "@/lib/chatPersistenceDeletionGuard";
import {
  ChatAnchorDeletionBlockedError,
  tryAcquireChatAnchorDeletionLease,
} from "@/lib/chatNavigationGuard";
import { notifySnippetDeleted } from "./anchorNotify";
import { computeDocDiff, type BodyDiff } from "@/features/timelapse/bodyDiff";
import {
  createCanonicalWriteContext,
  type CanonicalWriteContext,
  type CanonicalWriteReceipt,
} from "@/features/native-writes/writeContext";

export type Snippet = Omit<typeof snippets.$inferSelect, "contentSource"> & {
  contentSource?: string | null;
};
export type NewSnippet = typeof snippets.$inferInsert;
export type SnippetWriteResult = Snippet & {
  __writeReceipt: CanonicalWriteReceipt;
};

interface NativeSnippetWriteResult extends CanonicalWriteReceipt {
  entityId: string;
  version: number;
  undoJournalId: string;
}

function attachWriteReceipt(
  snippet: Snippet,
  receipt: CanonicalWriteReceipt,
): SnippetWriteResult {
  Object.defineProperty(snippet, "__writeReceipt", {
    value: receipt,
    configurable: false,
    enumerable: false,
    writable: false,
  });
  return snippet as SnippetWriteResult;
}

function nativeNullable(value: string | null | undefined): string | undefined {
  return value === null ? "" : value;
}

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
  opts?: { writeContext?: CanonicalWriteContext },
): Promise<SnippetWriteResult> {
  const writeContext = opts?.writeContext ?? createCanonicalWriteContext();
  const result = await invoke<NativeSnippetWriteResult>("snippet_create", {
    payload: {
      ...writeContext,
      projectId: data.projectId,
      snippetId: data.id,
      title: data.title,
      content: data.content,
      tagsCache: data.tagsCache ?? null,
      contentSource: data.contentSource ?? null,
      sceneId: data.sceneId ?? null,
      sourceChatMessageId: data.sourceChatMessageId ?? null,
      canonicalPayload: {
        title: data.title,
        sceneId: data.sceneId ?? null,
      },
    },
  });
  const created = await getSnippet(data.projectId, result.entityId);
  if (!created) throw new Error(`Snippet ${result.entityId} was not created`);
  return attachWriteReceipt(created, {
    changeEventUid: result.changeEventUid,
    maintenanceTransactionId: result.maintenanceTransactionId,
    undoJournalId: result.undoJournalId,
  });
}

type SnippetUpdateData = Partial<
  Pick<NewSnippet, "title" | "content" | "tagsCache" | "sceneId">
>;

function snippetUpdateCanonicalPayload(
  current: Snippet,
  data: SnippetUpdateData,
): { fields: string[]; diffs?: Record<string, BodyDiff> } {
  const fields = Object.keys(data).sort();
  if (data.content === undefined) return { fields };
  const diff = computeDocDiff(current.content, data.content);
  return diff ? { fields, diffs: { content: diff } } : { fields };
}

export async function updateSnippet(
  projectId: string,
  id: string,
  data: SnippetUpdateData,
  opts?: { baseVersion?: number; writeContext?: CanonicalWriteContext },
): Promise<SnippetWriteResult | undefined> {
  const current = await getSnippet(projectId, id);
  if (!current) return undefined;
  const baseVersion = opts?.baseVersion ?? current.version;
  const writeContext = opts?.writeContext ?? createCanonicalWriteContext();
  let result: NativeSnippetWriteResult;
  try {
    result = await invoke<NativeSnippetWriteResult>("snippet_update", {
      payload: {
        ...writeContext,
        projectId,
        snippetId: id,
        baseVersion,
        canonicalPayload: snippetUpdateCanonicalPayload(current, data),
        ...(data.title !== undefined ? { title: data.title } : {}),
        ...(data.content !== undefined ? { content: data.content } : {}),
        ...(data.tagsCache !== undefined
          ? { tagsCache: nativeNullable(data.tagsCache) }
          : {}),
        ...(data.sceneId !== undefined
          ? { sceneId: nativeNullable(data.sceneId) }
          : {}),
      },
    });
  } catch (error) {
    if (String(error).toLowerCase().includes("version conflict")) {
      throw new SnippetVersionConflictError(id);
    }
    throw error;
  }
  const updated = await getSnippet(projectId, id);
  if (!updated) return undefined;
  return attachWriteReceipt(updated, {
    changeEventUid: result.changeEventUid,
    maintenanceTransactionId: result.maintenanceTransactionId,
    undoJournalId: result.undoJournalId,
  });
}

export async function deleteSnippet(
  projectId: string,
  id: string,
  opts?: { baseVersion?: number; writeContext?: CanonicalWriteContext },
): Promise<CanonicalWriteReceipt | undefined> {
  const deletionAuthority = tryAcquireChatAnchorDeletionLease();
  if (!deletionAuthority) throw new ChatAnchorDeletionBlockedError();
  try {
    chatPersistenceDeletionGuard.assertDeletionAllowed();
    const existing = await getSnippet(projectId, id);
    const baseVersion = opts?.baseVersion ?? existing?.version;
    if (baseVersion === undefined) return undefined;
    const writeContext = opts?.writeContext ?? createCanonicalWriteContext();
    const result = await invoke<NativeSnippetWriteResult>("snippet_delete", {
      payload: {
        ...writeContext,
        projectId,
        snippetId: id,
        baseVersion,
        canonicalPayload: { title: existing?.title ?? null },
      },
    });
    notifySnippetDeleted(id);
    return {
      changeEventUid: result.changeEventUid,
      maintenanceTransactionId: result.maintenanceTransactionId,
      undoJournalId: result.undoJournalId,
    };
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
