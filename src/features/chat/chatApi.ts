import { invoke } from "@/lib/tauri";
import { db } from "@/db/client";
import { chatSessions, chatMessages, codexEntries } from "@/db/schema";
import { eq, desc, inArray } from "drizzle-orm";
import type { ChatSession, ChatMessage, MessageRole } from "./chatTypes";
import type { CodexEntry } from "@/features/codex/api";

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

/**
 * B-8: One-shot synopsis generation from scene content.
 * Returns the generated synopsis text (100-200 chars).
 */
export async function generateSynopsisFromContent(
  sceneTitle: string,
  sceneContent: string,
): Promise<string> {
  const messages = [
    {
      role: "user",
      content:
        `以下のシーン「${sceneTitle}」の内容を1〜3文（100〜200文字程度）で簡潔にまとめたSynopsisを日本語で書いてください。\n` +
        `Synopsisのみを出力してください。余分な説明は不要です。\n\n` +
        `===シーン本文===\n${sceneContent}`,
    },
  ];
  return invoke<string>("send_chat_message", { messages });
}

// --- Session/message persistence ---

function toSession(row: typeof chatSessions.$inferSelect): ChatSession {
  return {
    id: row.id,
    projectId: row.projectId,
    nodeId: row.nodeId,
    title: row.title,
    titleManual: row.titleManual,
    model: row.model,
    pinnedCodex: row.pinnedCodex,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toMessage(row: typeof chatMessages.$inferSelect): ChatMessage {
  return {
    id: row.id,
    sessionId: row.sessionId,
    role: row.role as MessageRole,
    content: row.content,
    model: row.model,
    tokensIn: row.tokensIn,
    tokensOut: row.tokensOut,
    durationMs: row.durationMs,
    metadata: row.metadata,
    createdAt: row.createdAt,
  };
}

export async function listSessions(nodeId?: string): Promise<ChatSession[]> {
  const query = nodeId
    ? db
        .select()
        .from(chatSessions)
        .where(eq(chatSessions.nodeId, nodeId))
        .orderBy(desc(chatSessions.updatedAt))
    : db.select().from(chatSessions).orderBy(desc(chatSessions.updatedAt));
  const rows = await query;
  return rows.map(toSession);
}

export async function createSession(
  projectId: string,
  title: string,
  nodeId?: string,
): Promise<ChatSession> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const rows = await db
    .insert(chatSessions)
    .values({
      id,
      projectId,
      title,
      nodeId: nodeId ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return toSession(rows[0]);
}

export async function deleteSession(id: string): Promise<void> {
  await db.delete(chatSessions).where(eq(chatSessions.id, id));
}

export async function listMessages(sessionId: string): Promise<ChatMessage[]> {
  const rows = await db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.sessionId, sessionId))
    .orderBy(chatMessages.createdAt);
  return rows.map(toMessage);
}

export async function addMessage(
  sessionId: string,
  role: MessageRole,
  content: string,
  extra?: {
    model?: string;
    tokensIn?: number;
    tokensOut?: number;
    durationMs?: number;
    metadata?: string;
  },
): Promise<ChatMessage> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const rows = await db
    .insert(chatMessages)
    .values({
      id,
      sessionId,
      role,
      content,
      model: extra?.model ?? null,
      tokensIn: extra?.tokensIn ?? null,
      tokensOut: extra?.tokensOut ?? null,
      durationMs: extra?.durationMs ?? null,
      metadata: extra?.metadata ?? null,
      createdAt: now,
    })
    .returning();

  await db
    .update(chatSessions)
    .set({ updatedAt: now })
    .where(eq(chatSessions.id, sessionId));

  return toMessage(rows[0]);
}

export async function updateSessionTitle(
  id: string,
  title: string,
): Promise<void> {
  await db
    .update(chatSessions)
    .set({ title, updatedAt: new Date().toISOString() })
    .where(eq(chatSessions.id, id));
}

// --- Pinned Codex entries (now stored as JSON in chat_sessions.pinned_codex) ---

function safeParsePinnedCodex(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed))
      return parsed.filter((v) => typeof v === "string");
  } catch {
    // corrupted JSON — treat as empty
  }
  return [];
}

export async function listPinnedCodexEntries(
  sessionId: string,
): Promise<CodexEntry[]> {
  const rows = await db
    .select({ pinnedCodex: chatSessions.pinnedCodex })
    .from(chatSessions)
    .where(eq(chatSessions.id, sessionId));
  if (!rows[0]) return [];

  const ids = safeParsePinnedCodex(rows[0].pinnedCodex);
  if (ids.length === 0) return [];

  return db.select().from(codexEntries).where(inArray(codexEntries.id, ids));
}

export async function pinCodexEntry(
  sessionId: string,
  entryId: string,
): Promise<void> {
  const rows = await db
    .select({ pinnedCodex: chatSessions.pinnedCodex })
    .from(chatSessions)
    .where(eq(chatSessions.id, sessionId));
  if (!rows[0]) return;

  const ids = safeParsePinnedCodex(rows[0].pinnedCodex);
  if (!ids.includes(entryId)) {
    ids.push(entryId);
    await db
      .update(chatSessions)
      .set({ pinnedCodex: JSON.stringify(ids) })
      .where(eq(chatSessions.id, sessionId));
  }
}

export async function unpinCodexEntry(
  sessionId: string,
  entryId: string,
): Promise<void> {
  const rows = await db
    .select({ pinnedCodex: chatSessions.pinnedCodex })
    .from(chatSessions)
    .where(eq(chatSessions.id, sessionId));
  if (!rows[0]) return;

  const ids = safeParsePinnedCodex(rows[0].pinnedCodex);
  const filtered = ids.filter((id) => id !== entryId);
  await db
    .update(chatSessions)
    .set({ pinnedCodex: JSON.stringify(filtered) })
    .where(eq(chatSessions.id, sessionId));
}
