import { db } from "@/db/client";
import { chatMessages, chatSessions } from "@/db/schema";
import { eq } from "drizzle-orm";
import { invoke } from "@/lib/tauri";
import type {
  ChatMessageRecordPatch,
  ChatScope,
  InvokeTypedWriter,
} from "@/lib/typedWriters";
import { getCurrentWorkspaceIdentity } from "@/runtime/workspaceIdentity";
import { recordChatMessageDelete } from "@/features/timelapse/captureChat";
import { pendingCompletedTurnPersistence } from "@/application/chat/pendingCompletedTurnPersistence";

/**
 * The CW typed writers of the chat API (K3/2 "chat の書込みの入口" 4〜8, CW
 * conditions 1〜7; DR-DA2-50, DR-DA2B-R2). `chatApi.ts` re-exports them. Both
 * modes use them (D-11 (a)); the renderer guards
 * (`pendingCompletedTurnPersistence`, `assertMessageMutationAllowed`) stay and
 * are not counted as the defence.
 */

// Bound at call time, so a partial `@/lib/tauri` mock still loads this module.
// Shared by `chatApi.ts` and `chatHistoryApi.ts`.
export const invokeTypedWriter: InvokeTypedWriter = (command, args) =>
  invoke(command, args);

/**
 * The project and workspace binding of a chat typed writer (CW condition 1;
 * DR-DA2B-R2). The callers keep their id-only signatures: the owning session
 * and project are read from the row (`chat_sessions` and `chat_messages` are
 * read-open, so the read passes while restricted), and Native checks that
 * binding again inside its transaction. A missing row means the legacy
 * statement would have matched nothing, so the caller writes nothing.
 */
export type ChatWriteScope = ChatScope & { sessionId: string };

export function chatScope(projectId: string): ChatScope {
  const identity = getCurrentWorkspaceIdentity();
  if (!identity) throw new Error("No workspace is open");
  return { expectedWorkspacePath: identity.path, projectId };
}

export async function sessionWriteScope(
  sessionId: string,
): Promise<ChatWriteScope | null> {
  const [row] = await db
    .select({ projectId: chatSessions.projectId })
    .from(chatSessions)
    .where(eq(chatSessions.id, sessionId))
    .limit(1);
  return row ? { ...chatScope(row.projectId), sessionId } : null;
}

export async function messageWriteScope(
  messageId: string,
): Promise<ChatWriteScope | null> {
  const [row] = await db
    .select({
      sessionId: chatMessages.sessionId,
      projectId: chatSessions.projectId,
    })
    .from(chatMessages)
    .innerJoin(chatSessions, eq(chatMessages.sessionId, chatSessions.id))
    .where(eq(chatMessages.id, messageId))
    .limit(1);
  return row ? { ...chatScope(row.projectId), sessionId: row.sessionId } : null;
}

export async function deleteMessage(messageId: string): Promise<void> {
  await deleteMessages([messageId]);
}

/**
 * The typed writer's per-call bound (Main and Native; 10,000 since the ST4-A
 * review fix, DR-DA2-54..61). It is not a K3/2 threshold.
 */
const MESSAGE_DELETE_BATCH = 10_000;

/**
 * Deletes messages of one session with the CW typed writer (DR-DA2B-R2). One
 * call is all-or-nothing, so a user row and the rows after it go in one call;
 * only a list above the writer's bound is split, and then it is not atomic (a
 * failed batch is the caller's delete failure).
 * The session and project are read from the first row that still exists; ids
 * that are already gone are not counted, as the legacy DELETE matched nothing.
 */
export async function deleteMessages(messageIds: string[]): Promise<void> {
  for (const messageId of messageIds) {
    pendingCompletedTurnPersistence.assertNone({
      kind: "message-id",
      messageId,
    });
  }
  let scope: ChatWriteScope | null = null;
  for (const id of messageIds) {
    scope = await messageWriteScope(id);
    if (scope) break;
  }
  for (let at = 0; at < messageIds.length; at += MESSAGE_DELETE_BATCH) {
    const batch = messageIds.slice(at, at + MESSAGE_DELETE_BATCH);
    if (scope) {
      await invokeTypedWriter("chat_messages_delete", {
        payload: { ...scope, messageIds: batch },
      });
    }
    // A failed later batch throws to the caller's delete failure; the
    // timelapse keeps the batches that were deleted.
    for (const messageId of batch) recordChatMessageDelete({ messageId });
  }
}

/**
 * The extraction and insertion record (CW 8): Native merges the record keys
 * into the stored metadata (`json_set`; the legacy `{ ...existing, ...update }`)
 * and refuses any other key. False when the message is gone (the legacy read
 * found no row and wrote nothing).
 */
export async function recordMessageMetadata(
  messageId: string,
  patch: ChatMessageRecordPatch,
): Promise<boolean> {
  const scope = await messageWriteScope(messageId);
  if (!scope) return false;
  await invokeTypedWriter("chat_message_metadata_record", {
    payload: {
      expectedWorkspacePath: scope.expectedWorkspacePath,
      projectId: scope.projectId,
      messageId,
      patch,
    },
  });
  return true;
}
