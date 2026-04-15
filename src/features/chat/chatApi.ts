import { invoke, listen } from "@/lib/tauri";
import { db } from "@/db/client";
import {
  chatSessions,
  chatMessages,
  chatSummaries,
  codexEntries,
  snippets,
} from "@/db/schema";
import { eq, desc, inArray, isNull, gte, and } from "drizzle-orm";
import type {
  ChatSession,
  ChatMessage,
  ChatSummary,
  MessageRole,
} from "./chatTypes";
import type { CodexEntry } from "@/features/codex/api";
import {
  normalizePinnedCodex,
  type PinnedCodexEntry,
} from "./pinnedCodexTypes";
import { sanitizeSceneContent } from "./contextBuilder";

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
  inputTokens?: number;
  outputTokens?: number;
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
    reasoningEnabled: null,
    reasoningEffort: null,
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
        `===シーン本文===\n${sanitizeSceneContent(sceneContent)}`,
    },
  ];
  const response = await invoke<ChatResponsePayload>("send_chat_message", {
    messages,
    thinking: null,
    effort: null,
    reasoningEnabled: null,
    reasoningEffort: null,
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
import { buildThinkingParams, getEffortForTask } from "./agent/modelLimits";

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
    reasoningEnabled: thinkingParams?.reasoningEnabled ?? null,
    reasoningEffort: thinkingParams?.reasoningEffort ?? null,
  });
}

export interface ChatMessageResult {
  text: string;
  thinkingBlocks: Array<{
    thinking: string;
    summary?: string;
    signature?: string;
  }>;
  inputTokens?: number;
  outputTokens?: number;
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
    reasoningEnabled: thinkingParams?.reasoningEnabled ?? null,
    reasoningEffort: thinkingParams?.reasoningEffort ?? null,
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
  return {
    text,
    thinkingBlocks,
    inputTokens: response.inputTokens,
    outputTokens: response.outputTokens,
  };
}

// ---------------------------------------------------------------------------
// G1: Streaming API
// ---------------------------------------------------------------------------

interface StreamChunkPayload {
  delta: string;
  block_type: "text" | "thinking";
}

interface StreamDonePayload {
  stop_reason: string;
  input_tokens?: number;
  output_tokens?: number;
}

interface StreamErrorPayload {
  message: string;
}

export interface StreamCallbacks {
  onTextDelta: (delta: string) => void;
  onThinkingDelta: (delta: string) => void;
  onDone: (info: {
    stopReason: string;
    inputTokens?: number;
    outputTokens?: number;
  }) => void;
  onError: (message: string) => void;
}

/**
 * Send a chat message with streaming response.
 * Returns a cleanup function to remove event listeners.
 */
export async function sendChatMessageStream(
  messages: { role: string; content: string }[],
  thinkingParams: ThinkingParams | undefined,
  callbacks: StreamCallbacks,
): Promise<() => void> {
  const unlisteners = await Promise.all([
    listen<StreamChunkPayload>("chat:stream-chunk", (payload) => {
      if (payload.block_type === "thinking") {
        callbacks.onThinkingDelta(payload.delta);
      } else {
        callbacks.onTextDelta(payload.delta);
      }
    }),
    listen<StreamDonePayload>("chat:stream-done", (payload) => {
      callbacks.onDone({
        stopReason: payload.stop_reason,
        inputTokens: payload.input_tokens,
        outputTokens: payload.output_tokens,
      });
    }),
    listen<StreamErrorPayload>("chat:stream-error", (payload) => {
      callbacks.onError(payload.message);
    }),
  ]);

  const cleanup = () => {
    unlisteners.forEach((u) => u());
  };

  // Fire-and-forget the stream command (events arrive via listeners above)
  invoke<void>("send_chat_message_stream", {
    messages,
    thinking: thinkingParams?.thinking ?? null,
    effort: thinkingParams?.effort ?? null,
    reasoningEnabled: thinkingParams?.reasoningEnabled ?? null,
    reasoningEffort: thinkingParams?.reasoningEffort ?? null,
  }).catch((e: unknown) => {
    // Error is also emitted as chat:stream-error from Rust, but handle here too
    const msg = e instanceof Error ? e.message : String(e);
    callbacks.onError(msg);
  });

  return cleanup;
}

/** Abort an in-progress streaming response. */
export async function abortChatStream(): Promise<void> {
  await invoke<void>("abort_chat_stream");
}

/**
 * セッションタイトルを軽量モデルで自動生成する (P1-2)
 * Returns the generated title, or null if generation failed.
 */
export async function generateSessionTitle(
  userMessage: string,
  assistantReply: string,
  model: string,
): Promise<string | null> {
  try {
    const thinkingParams = buildThinkingParams(
      model,
      getEffortForTask("session_title"),
      "omitted",
    );
    const messages = [
      {
        role: "user",
        content:
          `以下のチャットのやり取りに、3〜6語の短いタイトルを付けてください。\n` +
          `タイトルのみを出力してください。\n\n` +
          `ユーザー: ${userMessage.slice(0, 500)}\n\n` +
          `AI: ${assistantReply.slice(0, 500)}`,
      },
    ];
    const response = await invoke<ChatResponsePayload>("send_chat_message", {
      messages,
      thinking: thinkingParams.thinking ?? null,
      effort: thinkingParams.effort ?? null,
      reasoningEnabled: thinkingParams.reasoningEnabled ?? null,
      reasoningEffort: thinkingParams.reasoningEffort ?? null,
    });
    const title = response.blocks
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; content: string }).content)
      .join("")
      .trim();
    return title || null;
  } catch {
    return null;
  }
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
    isStarred: row.isStarred ?? 0,
    isSummarized: row.isSummarized ?? 0,
    createdAt: row.createdAt,
  };
}

/**
 * nodeId = string  → そのシーンのセッションのみ
 * nodeId = null    → nodeId IS NULL (プロジェクトスコープ) のセッションのみ
 * nodeId = undefined → 全セッション
 */
export async function listSessions(
  nodeId?: string | null,
): Promise<ChatSession[]> {
  const query =
    nodeId !== undefined
      ? nodeId === null
        ? db
            .select()
            .from(chatSessions)
            .where(isNull(chatSessions.nodeId))
            .orderBy(desc(chatSessions.updatedAt))
        : db
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
    id?: string;
    model?: string;
    tokensIn?: number;
    tokensOut?: number;
    durationMs?: number;
    metadata?: string;
  },
): Promise<ChatMessage> {
  const id = extra?.id ?? crypto.randomUUID();
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

export async function deleteMessage(messageId: string): Promise<void> {
  await db.delete(chatMessages).where(eq(chatMessages.id, messageId));
}

export async function deleteMessagesFrom(
  sessionId: string,
  fromCreatedAt: string,
): Promise<void> {
  await db
    .delete(chatMessages)
    .where(
      and(
        eq(chatMessages.sessionId, sessionId),
        gte(chatMessages.createdAt, fromCreatedAt),
      ),
    );
}

export async function updateMessageMetadata(
  messageId: string,
  metadataUpdate: Record<string, unknown>,
): Promise<void> {
  const rows = await db
    .select({ metadata: chatMessages.metadata })
    .from(chatMessages)
    .where(eq(chatMessages.id, messageId));
  if (!rows[0]) return;

  const existing: Record<string, unknown> = rows[0].metadata
    ? (JSON.parse(rows[0].metadata) as Record<string, unknown>)
    : {};
  const merged = { ...existing, ...metadataUpdate };

  await db
    .update(chatMessages)
    .set({ metadata: JSON.stringify(merged) })
    .where(eq(chatMessages.id, messageId));
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
  pinnedType: "codex" | "snippet";
  /** ピンの起源: "manual" = 手動ピン, "chat_mention" = チャット@メンション */
  pinSource?: "manual" | "chat_mention";
};

/** A snippet entry returned as a pinned item. */
export interface PinnedSnippetEntryWithData {
  id: string;
  title: string;
  content: string; // ProseMirror JSON
  pinnedType: "snippet";
}

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

  // Only fetch codex-type entries from codexEntries table
  const codexPinned = pinned.filter((p) => p.type !== "snippet");
  if (codexPinned.length === 0) return [];

  const ids = codexPinned.map((p) => p.id);
  const entries = await db
    .select()
    .from(codexEntries)
    .where(inArray(codexEntries.id, ids));

  const entryMap = new Map(entries.map((e) => [e.id, e]));
  const withChildrenMap = new Map(
    codexPinned.map((p) => [p.id, p.withChildren ?? false]),
  );
  const pinSourceMap = new Map(codexPinned.map((p) => [p.id, p.source]));
  // codexPinned の順序（ピンした順）を維持してソート
  return codexPinned
    .map((p) => entryMap.get(p.id))
    .filter((e): e is (typeof entries)[0] => e !== undefined)
    .map((e) => ({
      ...e,
      withChildren: withChildrenMap.get(e.id) ?? false,
      pinnedType: "codex" as const,
      pinSource: pinSourceMap.get(e.id),
    }));
}

/** List pinned snippet entries (type="snippet") for a session. */
export async function listPinnedSnippetEntries(
  sessionId: string,
): Promise<PinnedSnippetEntryWithData[]> {
  const rows = await db
    .select({ pinnedCodex: chatSessions.pinnedCodex })
    .from(chatSessions)
    .where(eq(chatSessions.id, sessionId));
  if (!rows[0]) return [];

  const pinned = safeParsePinnedCodex(rows[0].pinnedCodex);
  const snippetPinned = pinned.filter((p) => p.type === "snippet");
  if (snippetPinned.length === 0) return [];

  const ids = snippetPinned.map((p) => p.id);
  const entries = await db
    .select()
    .from(snippets)
    .where(inArray(snippets.id, ids));

  return entries.map((e) => ({
    id: e.id,
    title: e.title,
    content: e.content,
    pinnedType: "snippet" as const,
  }));
}

export async function pinCodexEntry(
  sessionId: string,
  entryId: string,
  withChildren = false,
  source: "manual" | "chat_mention" = "manual",
  type: "codex" | "snippet" = "codex",
): Promise<void> {
  const rows = await db
    .select({ pinnedCodex: chatSessions.pinnedCodex })
    .from(chatSessions)
    .where(eq(chatSessions.id, sessionId));
  if (!rows[0]) return;

  const pinned = safeParsePinnedCodex(rows[0].pinnedCodex);
  if (!pinned.some((p) => p.id === entryId)) {
    pinned.push({ id: entryId, type, withChildren, source });
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

/**
 * G20: Unpin entries matching the given IDs and source filter.
 * Only entries whose `source` matches `sourceFilter` are removed.
 */
export async function unpinCodexEntriesByIds(
  sessionId: string,
  entryIds: string[],
  sourceFilter: "chat_mention",
): Promise<void> {
  if (entryIds.length === 0) return;
  const rows = await db
    .select({ pinnedCodex: chatSessions.pinnedCodex })
    .from(chatSessions)
    .where(eq(chatSessions.id, sessionId));
  if (!rows[0]) return;

  const pinned = safeParsePinnedCodex(rows[0].pinnedCodex);
  const idSet = new Set(entryIds);
  const filtered = pinned.filter(
    (p) => !(idSet.has(p.id) && p.source === sourceFilter),
  );
  if (filtered.length === pinned.length) return; // nothing changed
  await db
    .update(chatSessions)
    .set({ pinnedCodex: JSON.stringify(filtered) })
    .where(eq(chatSessions.id, sessionId));
}

// ---------------------------------------------------------------------------
// G17: Progressive Summarization CRUD
// ---------------------------------------------------------------------------

export async function toggleStarMessage(
  messageId: string,
  starred: boolean,
): Promise<void> {
  await db
    .update(chatMessages)
    .set({ isStarred: starred ? 1 : 0 })
    .where(eq(chatMessages.id, messageId));
}

function toSummary(row: typeof chatSummaries.$inferSelect): ChatSummary {
  let ids: string[];
  try {
    ids = JSON.parse(row.sourceMessageIds) as string[];
  } catch {
    ids = [];
  }
  return {
    id: row.id,
    sessionId: row.sessionId,
    summary: row.summary,
    sourceMessageIds: ids,
    tokenCount: row.tokenCount,
    createdAt: row.createdAt,
  };
}

export async function listSummaries(sessionId: string): Promise<ChatSummary[]> {
  const rows = await db
    .select()
    .from(chatSummaries)
    .where(eq(chatSummaries.sessionId, sessionId))
    .orderBy(chatSummaries.createdAt);
  return rows.map(toSummary);
}

export async function addSummary(
  sessionId: string,
  summary: string,
  sourceMessageIds: string[],
  tokenCount?: number,
): Promise<ChatSummary> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const rows = await db
    .insert(chatSummaries)
    .values({
      id,
      sessionId,
      summary,
      sourceMessageIds: JSON.stringify(sourceMessageIds),
      tokenCount: tokenCount ?? null,
      createdAt: now,
    })
    .returning();
  return toSummary(rows[0]);
}

export async function markMessagesSummarized(
  messageIds: string[],
): Promise<void> {
  if (messageIds.length === 0) return;
  await db
    .update(chatMessages)
    .set({ isSummarized: 1 })
    .where(inArray(chatMessages.id, messageIds));
}
