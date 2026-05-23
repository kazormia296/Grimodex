import { invoke, listen } from "@/lib/tauri";
import { db } from "@/db/client";
import {
  chatSessions,
  chatMessages,
  chatSummaries,
  chatSummaryMessages,
  chatSessionPinnedCodex,
  codexEntries,
  snippets,
} from "@/db/schema";
import {
  eq,
  desc,
  asc,
  inArray,
  isNull,
  isNotNull,
  gte,
  and,
  or,
  max,
} from "drizzle-orm";
import type {
  ChatSession,
  ChatMessage,
  ChatSummary,
  MessageRole,
} from "./chatTypes";
import type { CodexEntry } from "@/features/codex/api";
import { sanitizeSceneContent } from "./contextBuilder";
import { getPromptCatalog } from "@/prompts/index";
import { useTreeStore } from "@/features/tree/treeStore";
import { getProject } from "@/features/project/api";

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
  const projectId = useTreeStore.getState().projectId;
  const project = await getProject(projectId).catch(() => null);
  const lang = project?.language ?? "ja";
  const messages = [
    {
      role: "user",
      content: getPromptCatalog(lang).chatApi.buildSynopsisFromContentPrompt(
        sceneTitle,
        sanitizeSceneContent(sceneContent),
      ),
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
  systemCacheSegments?: string[],
  apiVariant?: string | null,
): Promise<AgentLLMResponse> {
  return invoke<AgentLLMResponse>("send_agent_message", {
    messages,
    tools,
    thinking: thinkingParams?.thinking ?? null,
    effort: thinkingParams?.effort ?? null,
    reasoningEnabled: thinkingParams?.reasoningEnabled ?? null,
    reasoningEffort: thinkingParams?.reasoningEffort ?? null,
    systemCacheSegments: systemCacheSegments ?? null,
    apiVariant: apiVariant ?? null,
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
  systemCacheSegments?: string[],
  apiVariant?: string | null,
): Promise<ChatMessageResult> {
  const response = await invoke<ChatResponsePayload>("send_chat_message", {
    messages,
    thinking: thinkingParams?.thinking ?? null,
    effort: thinkingParams?.effort ?? null,
    reasoningEnabled: thinkingParams?.reasoningEnabled ?? null,
    reasoningEffort: thinkingParams?.reasoningEffort ?? null,
    systemCacheSegments: systemCacheSegments ?? null,
    apiVariant: apiVariant ?? null,
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
  systemCacheSegments?: string[],
  apiVariant?: string | null,
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
    systemCacheSegments: systemCacheSegments ?? null,
    apiVariant: apiVariant ?? null,
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
  lang = "ja",
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
        content: getPromptCatalog(lang).chatApi.buildSessionTitlePrompt(
          userMessage,
          assistantReply,
        ),
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
      nodeId: nodeId ? nodeId : null,
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

// --- Pinned Codex entries (normalized: chat_session_pinned_codex table) ---

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
  const codexPinRows = await db
    .select({
      codexEntryId: chatSessionPinnedCodex.codexEntryId,
      withChildren: chatSessionPinnedCodex.withChildren,
      pinSource: chatSessionPinnedCodex.pinSource,
    })
    .from(chatSessionPinnedCodex)
    .where(
      and(
        eq(chatSessionPinnedCodex.sessionId, sessionId),
        isNotNull(chatSessionPinnedCodex.codexEntryId),
      ),
    )
    .orderBy(asc(chatSessionPinnedCodex.createdAt));

  if (codexPinRows.length === 0) return [];

  const ids = codexPinRows
    .map((r) => r.codexEntryId)
    .filter((id): id is string => id !== null);
  const entries = await db
    .select()
    .from(codexEntries)
    .where(inArray(codexEntries.id, ids));
  const entryMap = new Map(entries.map((e) => [e.id, e]));

  return codexPinRows
    .map((r) => {
      if (r.codexEntryId === null) return null;
      const entry = entryMap.get(r.codexEntryId);
      if (!entry) return null;
      return {
        ...entry,
        withChildren: r.withChildren === 1,
        pinnedType: "codex" as const,
        pinSource: r.pinSource,
      };
    })
    .filter((e): e is NonNullable<typeof e> => e !== null);
}

/** List pinned snippet entries for a session. */
export async function listPinnedSnippetEntries(
  sessionId: string,
): Promise<PinnedSnippetEntryWithData[]> {
  const pinRows = await db
    .select({ snippetId: chatSessionPinnedCodex.snippetId })
    .from(chatSessionPinnedCodex)
    .where(
      and(
        eq(chatSessionPinnedCodex.sessionId, sessionId),
        isNotNull(chatSessionPinnedCodex.snippetId),
      ),
    )
    .orderBy(asc(chatSessionPinnedCodex.createdAt));

  const ids = pinRows
    .map((r) => r.snippetId)
    .filter((id): id is string => id !== null);
  if (ids.length === 0) return [];

  const entries = await db
    .select()
    .from(snippets)
    .where(inArray(snippets.id, ids));
  const entryMap = new Map(entries.map((e) => [e.id, e]));

  return ids
    .map((id) => entryMap.get(id))
    .filter((e): e is NonNullable<typeof e> => e !== undefined)
    .map((e) => ({
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
  const values =
    type === "snippet"
      ? {
          id: crypto.randomUUID(),
          sessionId,
          snippetId: entryId,
          codexEntryId: null,
          withChildren: withChildren ? 1 : 0,
          pinSource: source,
        }
      : {
          id: crypto.randomUUID(),
          sessionId,
          codexEntryId: entryId,
          snippetId: null,
          withChildren: withChildren ? 1 : 0,
          pinSource: source,
        };
  await db.insert(chatSessionPinnedCodex).values(values).onConflictDoNothing();
}

/**
 * Codex 専用: pinned codex entry の withChildren フラグを切り替える。
 * snippet にはツリー子孫の概念がないため、`codexEntryId` のみを対象にする。
 */
export async function togglePinChildren(
  sessionId: string,
  codexEntryId: string,
  withChildren: boolean,
): Promise<void> {
  const result = await db
    .update(chatSessionPinnedCodex)
    .set({ withChildren: withChildren ? 1 : 0 })
    .where(
      and(
        eq(chatSessionPinnedCodex.sessionId, sessionId),
        eq(chatSessionPinnedCodex.codexEntryId, codexEntryId),
      ),
    )
    .returning({ id: chatSessionPinnedCodex.id });
  if (result.length === 0) {
    // No pin row matched — most likely the caller passed a snippet id by
    // mistake. Surface it instead of failing silently.
    console.warn(
      `togglePinChildren: no pinned codex entry matched (session=${sessionId}, codexEntryId=${codexEntryId})`,
    );
  }
}

export async function unpinCodexEntry(
  sessionId: string,
  entryId: string,
): Promise<void> {
  // entryId may refer to either a codex entry or a snippet — match both columns
  // in a single statement (only one will hit due to the polymorphic CHECK).
  await db
    .delete(chatSessionPinnedCodex)
    .where(
      and(
        eq(chatSessionPinnedCodex.sessionId, sessionId),
        or(
          eq(chatSessionPinnedCodex.codexEntryId, entryId),
          eq(chatSessionPinnedCodex.snippetId, entryId),
        ),
      ),
    );
}

/**
 * G20: Unpin entries matching the given IDs and source filter.
 * Only entries whose pin_source matches `sourceFilter` are removed.
 */
export async function unpinCodexEntriesByIds(
  sessionId: string,
  entryIds: string[],
  sourceFilter: "chat_mention",
): Promise<void> {
  if (entryIds.length === 0) return;
  await db
    .delete(chatSessionPinnedCodex)
    .where(
      and(
        eq(chatSessionPinnedCodex.sessionId, sessionId),
        eq(chatSessionPinnedCodex.pinSource, sourceFilter),
        inArray(chatSessionPinnedCodex.codexEntryId, entryIds),
      ),
    );
}

// ---------------------------------------------------------------------------
// G17: Progressive Summarization CRUD
// ---------------------------------------------------------------------------

async function buildSummary(
  row: typeof chatSummaries.$inferSelect,
): Promise<ChatSummary> {
  const messageRows = await db
    .select({ messageId: chatSummaryMessages.messageId })
    .from(chatSummaryMessages)
    .where(eq(chatSummaryMessages.summaryId, row.id));
  return {
    id: row.id,
    sessionId: row.sessionId,
    summary: row.summary,
    sourceMessageIds: messageRows.map((r) => r.messageId),
    tokenCount: row.tokenCount,
    generation: row.generation ?? 1,
    sourceMsgCount: row.sourceMsgCount ?? 0,
    lastMsgId: row.lastMsgId ?? null,
    createdAt: row.createdAt,
  };
}

export async function listSummaries(sessionId: string): Promise<ChatSummary[]> {
  const rows = await db
    .select()
    .from(chatSummaries)
    .where(eq(chatSummaries.sessionId, sessionId))
    .orderBy(chatSummaries.createdAt);
  if (rows.length === 0) return [];

  const summaryIds = rows.map((r) => r.id);
  const linkRows = await db
    .select({
      summaryId: chatSummaryMessages.summaryId,
      messageId: chatSummaryMessages.messageId,
    })
    .from(chatSummaryMessages)
    .where(inArray(chatSummaryMessages.summaryId, summaryIds));

  const idsBySummary = new Map<string, string[]>();
  for (const link of linkRows) {
    const list = idsBySummary.get(link.summaryId) ?? [];
    list.push(link.messageId);
    idsBySummary.set(link.summaryId, list);
  }

  return rows.map((row) => ({
    id: row.id,
    sessionId: row.sessionId,
    summary: row.summary,
    sourceMessageIds: idsBySummary.get(row.id) ?? [],
    tokenCount: row.tokenCount,
    generation: row.generation ?? 1,
    sourceMsgCount: row.sourceMsgCount ?? 0,
    lastMsgId: row.lastMsgId ?? null,
    createdAt: row.createdAt,
  }));
}

/** Returns the next generation number for a new summary (max + 1, or 1). */
export async function getSummaryGeneration(sessionId: string): Promise<number> {
  const rows = await db
    .select({ maxGen: max(chatSummaries.generation) })
    .from(chatSummaries)
    .where(eq(chatSummaries.sessionId, sessionId));
  const current = rows[0]?.maxGen ?? 0;
  return (current ?? 0) + 1;
}

export async function addSummary(
  sessionId: string,
  summary: string,
  sourceMessageIds: string[],
  options?: {
    tokenCount?: number;
    generation?: number;
    sourceMsgCount?: number;
    lastMsgId?: string | null;
  },
): Promise<ChatSummary> {
  // Invariant: a summary always references at least one source message.
  if (sourceMessageIds.length === 0) {
    throw new Error("addSummary requires at least one sourceMessageId");
  }
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const rows = await db
    .insert(chatSummaries)
    .values({
      id,
      sessionId,
      summary,
      tokenCount: options?.tokenCount ?? null,
      generation: options?.generation ?? 1,
      sourceMsgCount: options?.sourceMsgCount ?? sourceMessageIds.length,
      lastMsgId: options?.lastMsgId ?? sourceMessageIds.at(-1) ?? null,
      createdAt: now,
    })
    .returning();
  try {
    await db.insert(chatSummaryMessages).values(
      sourceMessageIds.map((messageId) => ({
        summaryId: id,
        messageId,
      })),
    );
  } catch (err) {
    // sqlite-proxy does not expose transactions; compensate by deleting the
    // orphaned summary so the invariant summary-has-sources holds. If the
    // compensation itself fails we still re-throw the original error but log
    // the leak so it surfaces in dev consoles.
    try {
      await db.delete(chatSummaries).where(eq(chatSummaries.id, id));
    } catch (cleanupErr) {
      console.error(
        `addSummary: failed to roll back orphan summary ${id}`,
        cleanupErr,
      );
    }
    throw err;
  }
  return buildSummary(rows[0]);
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
