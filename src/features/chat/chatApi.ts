import { invoke } from "@/lib/tauri";
import { db } from "@/db/client";
import { chatSessions, chatMessages, codexEntries } from "@/db/schema";
import { eq, desc, inArray } from "drizzle-orm";
import type { ChatSession, ChatMessage, MessageRole } from "./chatTypes";
import type { CodexEntry } from "@/features/codex/api";
import {
  normalizePinnedCodex,
  type PinnedCodexEntry,
} from "./pinnedCodexTypes";

// --- AI message sending (existing) ---

interface ChatResponsePayload {
  blocks: Array<
    | { type: "text"; content: string }
    | { type: "tool_use"; id: string; name: string; input: unknown }
    | {
        type: "thinking";
        content: string;
        summary?: string;
        signature?: string;
      }
  >;
  stopReason: string;
}

export async function sendChatMessage(
  messages: ChatMessage[],
  onChunk: (chunk: string) => void,
): Promise<void> {
  const payload = messages.map((m) => ({ role: m.role, content: m.content }));
  const response = await invoke<ChatResponsePayload>("send_chat_message", {
    messages: payload,
    thinking: null,
    effort: null,
  });
  const text = response.blocks
    .filter((b) => b.type === "text")
    .map((b) => (b as { type: "text"; content: string }).content)
    .join("\n");
  onChunk(text);
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
  const response = await invoke<ChatResponsePayload>("send_chat_message", {
    messages,
    thinking: null,
    effort: null,
  });
  return response.blocks
    .filter((b) => b.type === "text")
    .map((b) => (b as { type: "text"; content: string }).content)
    .join("\n");
}

import type {
  AgentMessagePayload,
  AgentLLMResponse,
  AgentToolDefinition,
} from "./agent/agentTypes";
import type { ThinkingParams } from "./agent/modelLimits";

/** Send a tool-aware agent message and return a structured response. */
export async function sendAgentMessage(
  messages: AgentMessagePayload[],
  tools: AgentToolDefinition[],
  thinkingParams?: ThinkingParams,
): Promise<AgentLLMResponse> {
  return invoke<AgentLLMResponse>("send_agent_message", {
    messages,
    tools,
    thinking: thinkingParams?.thinking ?? null,
    effort: thinkingParams?.effort ?? null,
  });
}

export interface ChatMessageResult {
  text: string;
  thinkingBlocks: Array<{
    thinking: string;
    summary?: string;
    signature?: string;
  }>;
}

/** Send a simple (non-tool) chat message with optional thinking params. */
export async function sendChatMessageWithThinking(
  messages: { role: string; content: string }[],
  thinkingParams?: ThinkingParams,
): Promise<ChatMessageResult> {
  const response = await invoke<ChatResponsePayload>("send_chat_message", {
    messages,
    thinking: thinkingParams?.thinking ?? null,
    effort: thinkingParams?.effort ?? null,
  });
  const text = response.blocks
    .filter((b) => b.type === "text")
    .map((b) => (b as { type: "text"; content: string }).content)
    .join("\n");
  const thinkingBlocks = response.blocks
    .filter((b) => b.type === "thinking")
    .map((b) => {
      const tb = b as {
        type: "thinking";
        content: string;
        summary?: string;
        signature?: string;
      };
      return {
        thinking: tb.content,
        summary: tb.summary,
        signature: tb.signature,
      };
    });
  return { text, thinkingBlocks };
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

function safeParsePinnedCodex(raw: string | null): PinnedCodexEntry[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return normalizePinnedCodex(parsed);
  } catch {
    // corrupted JSON — treat as empty
  }
  return [];
}

export type PinnedCodexEntryWithData = CodexEntry & {
  withChildren: boolean;
};

export async function listPinnedCodexEntries(
  sessionId: string,
): Promise<PinnedCodexEntryWithData[]> {
  const rows = await db
    .select({ pinnedCodex: chatSessions.pinnedCodex })
    .from(chatSessions)
    .where(eq(chatSessions.id, sessionId));
  if (!rows[0]) return [];

  const pinned = safeParsePinnedCodex(rows[0].pinnedCodex);
  if (pinned.length === 0) return [];

  const ids = pinned.map((p) => p.id);
  const entries = await db
    .select()
    .from(codexEntries)
    .where(inArray(codexEntries.id, ids));

  const withChildrenMap = new Map(
    pinned.map((p) => [p.id, p.withChildren ?? false]),
  );
  return entries.map((e) => ({
    ...e,
    withChildren: withChildrenMap.get(e.id) ?? false,
  }));
}

export async function pinCodexEntry(
  sessionId: string,
  entryId: string,
  withChildren = false,
): Promise<void> {
  const rows = await db
    .select({ pinnedCodex: chatSessions.pinnedCodex })
    .from(chatSessions)
    .where(eq(chatSessions.id, sessionId));
  if (!rows[0]) return;

  const pinned = safeParsePinnedCodex(rows[0].pinnedCodex);
  if (!pinned.some((p) => p.id === entryId)) {
    pinned.push({ id: entryId, withChildren });
    await db
      .update(chatSessions)
      .set({ pinnedCodex: JSON.stringify(pinned) })
      .where(eq(chatSessions.id, sessionId));
  }
}

export async function togglePinChildren(
  sessionId: string,
  entryId: string,
  withChildren: boolean,
): Promise<void> {
  const rows = await db
    .select({ pinnedCodex: chatSessions.pinnedCodex })
    .from(chatSessions)
    .where(eq(chatSessions.id, sessionId));
  if (!rows[0]) return;

  const pinned = safeParsePinnedCodex(rows[0].pinnedCodex);
  const updated = pinned.map((p) =>
    p.id === entryId ? { ...p, withChildren } : p,
  );
  await db
    .update(chatSessions)
    .set({ pinnedCodex: JSON.stringify(updated) })
    .where(eq(chatSessions.id, sessionId));
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

  const pinned = safeParsePinnedCodex(rows[0].pinnedCodex);
  const filtered = pinned.filter((p) => p.id !== entryId);
  await db
    .update(chatSessions)
    .set({ pinnedCodex: JSON.stringify(filtered) })
    .where(eq(chatSessions.id, sessionId));
}
