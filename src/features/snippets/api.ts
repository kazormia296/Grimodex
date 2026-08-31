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
import {
  runTimelapseBodyReplacement,
  runTimelapseBodyWrite,
  runTimelapseMutation,
} from "@/features/timelapse/bodyWriteMode";
import type {
  TimelapseCoverageProof,
  TimelapseDocumentRef,
} from "@/features/timelapse/documentCoverage";

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
  const write = async (): Promise<SnippetWriteResult> => {
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
  };
  return runTimelapseBodyReplacement(
    {
      projectId: data.projectId,
      documentIdentity: {
        projectId: data.projectId,
        domain: "snippet",
        entityType: "snippet",
        entityId: data.id,
      },
    },
    { commit: write, project: async (created) => created },
  );
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
  opts?: {
    baseVersion?: number;
    writeContext?: CanonicalWriteContext;
    timelapseDocument?: TimelapseDocumentRef;
    preexistingDraft?: boolean;
  },
): Promise<SnippetWriteResult | undefined> {
  const writeContext = opts?.writeContext ?? createCanonicalWriteContext();
  type CommittedUpdate = {
    current: Snippet;
    result: NativeSnippetWriteResult;
  };
  const commit = async (
    coverage: TimelapseCoverageProof | undefined,
  ): Promise<CommittedUpdate | null> => {
    const current = await getSnippet(projectId, id);
    if (!current) return null;
    const baseVersion = opts?.baseVersion ?? current.version;
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
          ...(coverage ? { timelapseDocStepCoverage: coverage } : {}),
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
    return { current, result };
  };
  const project = async (
    committed: CommittedUpdate | null,
  ): Promise<SnippetWriteResult | undefined> => {
    if (!committed) return undefined;
    const updated = await getSnippet(projectId, id);
    if (!updated) return undefined;
    return attachWriteReceipt(updated, {
      changeEventUid: committed.result.changeEventUid,
      maintenanceTransactionId: committed.result.maintenanceTransactionId,
      undoJournalId: committed.result.undoJournalId,
    });
  };
  const documentIdentity = {
    projectId,
    domain: "snippet" as const,
    entityType: "snippet" as const,
    entityId: id,
  };
  if (data.content !== undefined) {
    const write = opts?.timelapseDocument
      ? runTimelapseBodyWrite(
          {
            projectId,
            coverageReceipt: opts.timelapseDocument,
            documentIdentity,
            content: data.content,
            ...(opts?.preexistingDraft ? { preexistingDraft: true } : {}),
          },
          {
            commit,
            didCommit: (committed) => committed !== null,
            project,
          },
        )
      : runTimelapseBodyReplacement(
          {
            projectId,
            documentIdentity,
            ...(opts?.preexistingDraft ? { preexistingDraft: true } : {}),
          },
          {
            commit: () => commit(undefined),
            didCommit: (committed) => committed !== null,
            project,
          },
        );
    return write;
  }
  return runTimelapseMutation(projectId, async () =>
    project(await commit(undefined)),
  );
}

export async function deleteSnippet(
  projectId: string,
  id: string,
  opts?: { baseVersion?: number; writeContext?: CanonicalWriteContext },
): Promise<CanonicalWriteReceipt | undefined> {
  const deletionAuthority = tryAcquireChatAnchorDeletionLease();
  if (!deletionAuthority) throw new ChatAnchorDeletionBlockedError();
  try {
    return await runTimelapseMutation(projectId, async () => {
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
    });
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
