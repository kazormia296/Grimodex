import { invoke } from "@/lib/tauri";
import { db } from "@/db/client";
import { chatThreads, chatMessages } from "@/db/schema";
import { eq, desc } from "drizzle-orm";
import type { ChatThread, ChatMessage, MessageRole } from "./chatTypes";

// --- AI message sending (existing) ---

export async function sendChatMessage(
  messages: ChatMessage[],
  onChunk: (chunk: string) => void,
): Promise<void> {
  const payload = messages.map((m) => ({ role: m.role, content: m.content }));
  const response = await invoke<string>("send_chat_message", {
    messages: payload,
  });
  onChunk(response);
}

// --- Thread/message persistence (Task 2.5) ---

function toThread(row: typeof chatThreads.$inferSelect): ChatThread {
  return {
    id: row.id,
    title: row.title,
    sceneId: row.sceneId,
    createdAt: row.createdAt,
    modifiedAt: row.modifiedAt,
  };
}

function toMessage(row: typeof chatMessages.$inferSelect): ChatMessage {
  return {
    id: row.id,
    threadId: row.threadId,
    role: row.role as MessageRole,
    content: row.content,
    createdAt: row.createdAt,
  };
}

export async function listThreads(sceneId?: string): Promise<ChatThread[]> {
  const query = sceneId
    ? db
        .select()
        .from(chatThreads)
        .where(eq(chatThreads.sceneId, sceneId))
        .orderBy(desc(chatThreads.modifiedAt))
    : db.select().from(chatThreads).orderBy(desc(chatThreads.modifiedAt));
  const rows = await query;
  return rows.map(toThread);
}

export async function createThread(
  title: string,
  sceneId?: string,
): Promise<ChatThread> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const rows = await db
    .insert(chatThreads)
    .values({
      id,
      title,
      sceneId: sceneId ?? null,
      createdAt: now,
      modifiedAt: now,
    })
    .returning();
  return toThread(rows[0]);
}

export async function deleteThread(id: string): Promise<void> {
  await db.delete(chatThreads).where(eq(chatThreads.id, id));
}

export async function listMessages(threadId: string): Promise<ChatMessage[]> {
  const rows = await db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.threadId, threadId))
    .orderBy(chatMessages.createdAt);
  return rows.map(toMessage);
}

export async function addMessage(
  threadId: string,
  role: MessageRole,
  content: string,
): Promise<ChatMessage> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const rows = await db
    .insert(chatMessages)
    .values({ id, threadId, role, content, createdAt: now })
    .returning();

  await db
    .update(chatThreads)
    .set({ modifiedAt: now })
    .where(eq(chatThreads.id, threadId));

  return toMessage(rows[0]);
}

export async function updateThreadTitle(
  id: string,
  title: string,
): Promise<void> {
  await db
    .update(chatThreads)
    .set({ title, modifiedAt: new Date().toISOString() })
    .where(eq(chatThreads.id, id));
}
