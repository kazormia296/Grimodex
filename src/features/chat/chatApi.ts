import { invoke } from "@/lib/tauri";
import { db } from "@/db/client";
import {
  chatSessions,
  chatMessages,
  chatMessagePrompts,
  chatSummaries,
  chatSummaryMessages,
  chatSessionPinnedCodex,
  codexEntries,
  snippets,
  mapStickies,
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
import {
  recordChatMessageAdd,
  recordChatMessageDelete,
  recordChatMessagesDeleteFrom,
} from "@/features/timelapse/captureChat";
import type { CodexEntry } from "@/features/codex/api";
import { prosemirrorToText } from "@/lib/prosemirror";
import type { LayerBreakdown } from "./contextBuilder";
import { scheduleChatIndex } from "@/features/semantic-search/scheduler";
import type { TurnToolProtocol } from "@/features/ai-context/finalizeTurnPayload";
import type { AiProvider } from "./types";
import { getCurrentImeWorkspaceIdentity } from "@/features/ime/workspaceScope";
import { pendingCompletedTurnPersistence } from "@/application/chat/pendingCompletedTurnPersistence";
import type { AiAuditTransportContext } from "@/features/ai-audit/transportContext";
import type { AiAuditJsonObject } from "@/features/ai-audit/types";
import {
  abortChatStream,
  loadAiAuditRuntime,
  loadSingleShotTransport,
  sendChatMessageStream,
} from "./lazyTransportApi";

export {
  generateSessionTitle,
  generateSynopsisFromContent,
} from "./chatContentGeneration";

// --- AI message sending (existing) ---

export async function sendChatMessage(
  messages: ChatMessage[],
  onChunk: (chunk: string) => void,
  auditContext: AiAuditTransportContext,
  model?: string | null,
): Promise<void> {
  const { invokeSingleShotChat } = await loadSingleShotTransport();
  const payload = messages.map((m) => ({ role: m.role, content: m.content }));
  const response = await invokeSingleShotChat(
    {
      messages: payload,
      thinking: null,
      effort: null,
      reasoningEnabled: null,
      reasoningEffort: null,
      model: model ?? null,
    },
    auditContext,
  );
  const text = response.blocks
    .filter((b) => b.type === "text")
    .map((b) => (b as { type: "text"; content: string }).content)
    .join("\n");
  onChunk(text);
}

/**
 * A/B 比較 (③) 用の非ストリーミング 1 ショット送信。ライブ ChatPanel の
 * 単一ストリーム描画には一切触れず、専用の比較サーフェスから 2 構成を
 * 並列に投げるためのヘルパ。model override 付き、テキストだけを返す。
 * usage は呼び出し側 (dispatcher) で recordAiUsage する。
 */
export async function sendChatMessageOnceAb(
  messages: { role: string; content: string }[],
  auditContext: AiAuditTransportContext,
  model?: string | null,
  /**
   * A/B 比較 (③): プロバイダ override。None/空なら設定の既定プロバイダ。
   * 値は `AiProvider` 文字列 ("openrouter" / "sakana" 等)。
   */
  provider?: string | null,
  /**
   * provider を上書きする枠の API 経路 (variant)。Sakana など `/responses` 必須の
   * プロバイダで "responses" を明示するために使う。他は未指定 (= backend 既定解決)。
   */
  apiVariant?: string | null,
  /**
   * OpenAI 互換: この枠だけ別エンドポイントへ向ける override。null/未指定なら
   * 設定の active エンドポイント。provider が openai-compatible 以外なら無視される。
   */
  endpointId?: string | null,
): Promise<{ text: string; inputTokens?: number; outputTokens?: number }> {
  const { invokeSingleShotChat } = await loadSingleShotTransport();
  const response = await invokeSingleShotChat(
    {
      messages,
      thinking: null,
      effort: null,
      reasoningEnabled: null,
      reasoningEffort: null,
      apiVariant: apiVariant ?? null,
      model: model ?? null,
      provider: provider ?? null,
      endpointId: endpointId ?? null,
    },
    auditContext,
  );
  const text = response.blocks
    .filter((b) => b.type === "text")
    .map((b) => (b as { type: "text"; content: string }).content)
    .join("\n");
  return {
    text,
    inputTokens: response.inputTokens,
    outputTokens: response.outputTokens,
  };
}

import type {
  AgentMessagePayload,
  AgentLLMResponse,
  AgentToolDefinition,
  WebSearchConfig,
} from "./agent/agentTypes";
import type { ThinkingParams } from "./agent/modelLimits";

/** Send a tool-aware agent message and return a structured response. */
export async function sendAgentMessage(
  messages: AgentMessagePayload[],
  tools: AgentToolDefinition[],
  auditContext: AiAuditTransportContext,
  thinkingParams?: ThinkingParams,
  systemCacheSegments?: string[],
  apiVariant?: string | null,
  webSearch?: WebSearchConfig | null,
  systemVolatileTail?: string,
  /** agent ロールのモデル override（undefined/null = 既定モデルへフォールバック）。 */
  model?: string | null,
  /**
   * Chat の別プロバイダ一時送信: プロバイダ override（null/未指定 = 設定の既定プロバイダ）。
   * 値は `AiProvider` 文字列。送信モデル(model)と同じプロバイダの名前空間に属していること。
   */
  provider?: string | null,
  /**
   * OpenAI 互換: この agent 送信だけ別エンドポイントへ向ける override。
   * null/未指定なら設定の active エンドポイント。provider!=互換 では無視される。
   */
  endpointId?: string | null,
  /** Finalized output limit; backend uses this exact value on the provider wire. */
  requestMaxOutputTokens?: number | null,
  /** Immutable route snapshot; takes precedence over the legacy override. */
  resolvedProvider?: string | null,
  resolvedEndpointId?: string | null,
  /** Turn-start protocol snapshot; prevents backend settings drift mid-turn. */
  resolvedToolProtocol?: TurnToolProtocol | null,
  /** Ollama endpoint authority snapshot; backend compares but never trusts it as a URL. */
  expectedOllamaEndpoint?: string | null,
): Promise<AgentLLMResponse> {
  const auditRuntime = await loadAiAuditRuntime();
  const chatMessageId = auditContext.chatMessageId;
  const args: Record<string, unknown> = {
    messages,
    tools,
    thinking: thinkingParams?.thinking ?? null,
    effort: thinkingParams?.effort ?? null,
    reasoningEnabled: thinkingParams?.reasoningEnabled ?? null,
    reasoningEffort: thinkingParams?.reasoningEffort ?? null,
    systemCacheSegments: systemCacheSegments ?? null,
    apiVariant: apiVariant ?? null,
    webSearch: webSearch ?? null,
    systemVolatileTail: systemVolatileTail ?? null,
    model: model ?? null,
    provider: resolvedProvider ?? provider ?? null,
    endpointId: resolvedEndpointId ?? endpointId ?? null,
    expectedOllamaEndpoint: expectedOllamaEndpoint ?? null,
    ...(requestMaxOutputTokens != null ? { requestMaxOutputTokens } : {}),
    ...(resolvedToolProtocol != null ? { resolvedToolProtocol } : {}),
    ...(chatMessageId ? { chatMessageId } : {}),
  };
  const route = auditRuntime.resolveChatAuditRoute(args);
  const audit = await auditRuntime.beginAiAuditExecution({
    ...auditContext,
    request: auditRuntime.auditRequestFromChatArgs(args, route),
    ...auditRuntime.chatAuditRouteCoverage(route),
  });
  args.auditContext = auditRuntime.nativeAiAuditContext(audit);
  await auditRuntime.markAiAuditDispatched(
    audit,
    auditRuntime.beforeIpcDispatchDetails("send_agent_message"),
  );
  let response: AgentLLMResponse;
  try {
    response = await invoke<AgentLLMResponse>("send_agent_message", args);
  } catch (error) {
    await auditRuntime.failAiAuditExecution(audit, {
      error: auditRuntime.auditErrorSnapshot(error),
    });
    throw error;
  }
  await auditRuntime.completeAiAuditExecution(audit, {
    response: response as unknown as AiAuditJsonObject,
    usage: {
      inputTokens: response.inputTokens ?? null,
      outputTokens: response.outputTokens ?? null,
      cacheReadTokens: response.cacheReadTokens ?? null,
      cacheWriteTokens: response.cacheWriteTokens ?? null,
      cost: response.cost ?? null,
      stopReason: response.stopReason,
    },
  });
  return response;
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

/**
 * Send a simple (non-tool) chat message with optional thinking params.
 * `model` は機能別モデル override（None/空なら Rust が settings.model に解決）。
 * 省略時は従来どおり既定モデルを使う＝後方互換。
 */
export async function sendChatMessageWithThinking(
  messages: { role: string; content: string }[],
  auditContext: AiAuditTransportContext,
  thinkingParams?: ThinkingParams,
  systemCacheSegments?: string[],
  apiVariant?: string | null,
  systemVolatileTail?: string,
  model?: string | null,
  /**
   * 機能別モデルのプロバイダ横断: provider override（null/未指定 = 設定の既定プロバイダ）。
   * 値は `AiProvider` 文字列。model と同じプロバイダの名前空間に属すること。
   */
  provider?: string | null,
  /**
   * OpenAI 互換: この送信だけ別エンドポイントへ向ける override。
   * null/未指定なら設定の active エンドポイント。provider!=互換 では無視される。
   */
  endpointId?: string | null,
  requestMaxOutputTokens?: number | null,
  resolvedProvider?: string | null,
  resolvedEndpointId?: string | null,
  /** Ollama endpoint authority snapshot; backend compares but never trusts it as a URL. */
  expectedOllamaEndpoint?: string | null,
): Promise<ChatMessageResult> {
  const { invokeSingleShotChat } = await loadSingleShotTransport();
  const response = await invokeSingleShotChat(
    {
      messages,
      thinking: thinkingParams?.thinking ?? null,
      effort: thinkingParams?.effort ?? null,
      reasoningEnabled: thinkingParams?.reasoningEnabled ?? null,
      reasoningEffort: thinkingParams?.reasoningEffort ?? null,
      systemCacheSegments: systemCacheSegments ?? null,
      apiVariant: apiVariant ?? null,
      systemVolatileTail: systemVolatileTail ?? null,
      model: model ?? null,
      provider: resolvedProvider ?? provider ?? null,
      endpointId: resolvedEndpointId ?? endpointId ?? null,
      expectedOllamaEndpoint: expectedOllamaEndpoint ?? null,
      ...(requestMaxOutputTokens != null ? { requestMaxOutputTokens } : {}),
    },
    auditContext,
  );
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

export type { StreamCallbacks } from "./chatStreamTransport";
export { abortChatStream, sendChatMessageStream };

// --- Session/message persistence ---

function toSession(row: typeof chatSessions.$inferSelect): ChatSession {
  return {
    id: row.id,
    projectId: row.projectId,
    nodeId: row.nodeId,
    codexAnchorId: row.codexAnchorId,
    snippetAnchorId: row.snippetAnchorId,
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
 * nodeId = null    → nodeId IS NULL かつ codex/snippet anchor も NULL (プロジェクトスコープ)
 * nodeId = undefined → 全セッション
 * codexAnchorId = string → その Codex アンカーのセッションのみ
 * snippetAnchorId = string → その Snippet アンカーのセッションのみ
 */
export async function listSessions(
  projectId: string,
  nodeId?: string | null,
  codexAnchorId?: string | null,
  snippetAnchorId?: string | null,
): Promise<ChatSession[]> {
  if (codexAnchorId !== undefined && codexAnchorId !== null) {
    const rows = await db
      .select()
      .from(chatSessions)
      .where(
        and(
          eq(chatSessions.projectId, projectId),
          eq(chatSessions.codexAnchorId, codexAnchorId),
        ),
      )
      .orderBy(desc(chatSessions.updatedAt));
    return rows.map(toSession);
  }

  if (snippetAnchorId !== undefined && snippetAnchorId !== null) {
    const rows = await db
      .select()
      .from(chatSessions)
      .where(
        and(
          eq(chatSessions.projectId, projectId),
          eq(chatSessions.snippetAnchorId, snippetAnchorId),
        ),
      )
      .orderBy(desc(chatSessions.updatedAt));
    return rows.map(toSession);
  }

  const query =
    nodeId !== undefined
      ? nodeId === null
        ? db
            .select()
            .from(chatSessions)
            .where(
              and(
                eq(chatSessions.projectId, projectId),
                isNull(chatSessions.nodeId),
                isNull(chatSessions.codexAnchorId),
                isNull(chatSessions.snippetAnchorId),
              ),
            )
            .orderBy(desc(chatSessions.updatedAt))
        : db
            .select()
            .from(chatSessions)
            .where(
              and(
                eq(chatSessions.projectId, projectId),
                eq(chatSessions.nodeId, nodeId),
              ),
            )
            .orderBy(desc(chatSessions.updatedAt))
      : db
          .select()
          .from(chatSessions)
          .where(eq(chatSessions.projectId, projectId))
          .orderBy(desc(chatSessions.updatedAt));
  const rows = await query;
  return rows.map(toSession);
}

/**
 * Resolve a session only when both authorities match the persisted row.
 * Turn setup must use this instead of trusting a session id captured from UI
 * state, because session ids alone do not establish project ownership.
 */
export async function getSessionForProject(
  sessionId: string,
  projectId: string,
): Promise<ChatSession | null> {
  const rows = await db
    .select()
    .from(chatSessions)
    .where(
      and(
        eq(chatSessions.id, sessionId),
        eq(chatSessions.projectId, projectId),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row || row.id !== sessionId || row.projectId !== projectId) return null;
  return toSession(row);
}

export async function createSession(
  projectId: string,
  title: string,
  nodeId?: string,
  codexAnchorId?: string,
  snippetAnchorId?: string,
  model?: string,
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
      codexAnchorId: codexAnchorId ?? null,
      snippetAnchorId: snippetAnchorId ?? null,
      ...(model !== undefined ? { model } : {}),
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return toSession(rows[0]);
}

export async function deleteSession(id: string): Promise<void> {
  pendingCompletedTurnPersistence.assertNone({
    kind: "session-id",
    sessionId: id,
  });
  await db.delete(chatSessions).where(eq(chatSessions.id, id));
}

/**
 * プロジェクトのチャット履歴を全消去する。chat_sessions を 1 文で消すだけで、
 * chat_messages / chat_summaries / chat_summary_messages / chat_message_prompts /
 * chat_session_pinned_codex はすべて FK ON DELETE CASCADE (foreign_keys=ON) で
 * 連鎖削除される。子テーブルを個別に DELETE すると N+1 かつ非原子（別 IPC ごとに
 * lock/unlock され、途中失敗で中途半端に消える）になるため、単一 statement に閉じる。
 */
export async function clearProjectChatHistory(
  projectId: string,
): Promise<void> {
  pendingCompletedTurnPersistence.assertNone({
    kind: "project",
    workspaceIdentity: getCurrentImeWorkspaceIdentity(),
    projectId,
  });
  await db.delete(chatSessions).where(eq(chatSessions.projectId, projectId));
}

export async function getSessionTitleForMessage(
  messageId: string,
): Promise<string | null> {
  const rows = await db
    .select({ title: chatSessions.title })
    .from(chatMessages)
    .innerJoin(chatSessions, eq(chatMessages.sessionId, chatSessions.id))
    .where(eq(chatMessages.id, messageId))
    .limit(1);
  return rows[0]?.title ?? null;
}

export async function listMessages(sessionId: string): Promise<ChatMessage[]> {
  const rows = await db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.sessionId, sessionId))
    .orderBy(chatMessages.createdAt);
  return rows.map(toMessage);
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonSubset(expected: unknown, actual: unknown): boolean {
  if (Object.is(expected, actual)) {
    return true;
  }
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      expected.length === actual.length &&
      expected.every((value, index) => isJsonSubset(value, actual[index]))
    );
  }
  if (!isJsonRecord(expected) || !isJsonRecord(actual)) {
    return false;
  }
  return Object.entries(expected).every(
    ([key, value]) =>
      Object.hasOwn(actual, key) && isJsonSubset(value, actual[key]),
  );
}

function isRetryCompatibleMetadata(
  expected: string | null,
  actual: string | null,
): boolean {
  if (expected === actual) {
    return true;
  }
  try {
    const actualValue = actual === null ? null : JSON.parse(actual);
    if (expected === null) {
      return isJsonRecord(actualValue);
    }
    return isJsonSubset(JSON.parse(expected), actualValue);
  } catch {
    // Legacy non-JSON metadata remains byte-for-byte only.
    return false;
  }
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
    /** Stable completion time captured before transport; retained on retry. */
    createdAt?: string;
    /**
     * Completed turns reserve their forward-only Chronicle events before the
     * durable write. Their retries disable the legacy insert-time capture.
     */
    recordTimelapse?: boolean;
  },
): Promise<ChatMessage> {
  const id = extra?.id ?? crypto.randomUUID();
  const now = new Date().toISOString();
  const createdAt = extra?.createdAt ?? now;
  const values = {
    id,
    sessionId,
    role,
    content,
    model: extra?.model ?? null,
    tokensIn: extra?.tokensIn ?? null,
    tokensOut: extra?.tokensOut ?? null,
    durationMs: extra?.durationMs ?? null,
    metadata: extra?.metadata ?? null,
    createdAt,
  };
  const rows = await db
    .insert(chatMessages)
    .values(values)
    .onConflictDoNothing({ target: chatMessages.id })
    .returning();
  const inserted = rows[0] !== undefined;
  let stored = rows[0];
  if (!stored) {
    const existing = await db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.id, id))
      .limit(1);
    stored = existing[0];
    if (
      !stored ||
      stored.sessionId !== values.sessionId ||
      stored.role !== values.role ||
      stored.content !== values.content ||
      stored.model !== values.model ||
      stored.tokensIn !== values.tokensIn ||
      stored.tokensOut !== values.tokensOut ||
      stored.durationMs !== values.durationMs ||
      (extra?.createdAt !== undefined &&
        stored.createdAt !== values.createdAt) ||
      !isRetryCompatibleMetadata(values.metadata, stored.metadata)
    ) {
      throw new Error(`chat message id collision: ${id}`);
    }
  }

  if (inserted) {
    // 執筆タイムラプス: 会話フローの forward-only 記録 (§17 P0)。
    // session updatedAt が失敗して同じIDをretryしても二重記録しないよう、
    // insertの成否を境界にする。
    if (extra?.recordTimelapse !== false) {
      recordChatMessageAdd({
        sessionId,
        messageId: id,
        role,
        text: content,
        model: extra?.model ?? null,
        createdAt,
      });
    }

    // エピソード記憶 index: user/assistant の非空メッセージを意味検索に載せる
    // (system / 空本文は Rust 側でも対象外)。2.5s デバウンスで畳む。
    if (
      (role === "user" || role === "assistant") &&
      content.trim().length > 0
    ) {
      scheduleChatIndex(id);
    }
  }

  await db
    .update(chatSessions)
    .set({ updatedAt: now })
    .where(eq(chatSessions.id, sessionId));
  return toMessage(stored);
}

export async function deleteMessage(messageId: string): Promise<void> {
  assertMessageMutationAllowed(messageId);
  await db.delete(chatMessages).where(eq(chatMessages.id, messageId));
  recordChatMessageDelete({ messageId });
}

export async function deleteMessagesFrom(
  sessionId: string,
  fromCreatedAt: string,
): Promise<void> {
  pendingCompletedTurnPersistence.assertNone({
    kind: "session-id",
    sessionId,
  });
  await db
    .delete(chatMessages)
    .where(
      and(
        eq(chatMessages.sessionId, sessionId),
        gte(chatMessages.createdAt, fromCreatedAt),
      ),
    );
  recordChatMessagesDeleteFrom({ sessionId, fromCreatedAt });
}

export async function updateMessageMetadata(
  messageId: string,
  metadataUpdate: Record<string, unknown>,
): Promise<void> {
  assertMessageMutationAllowed(messageId);
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

  // 効果信号 (insertedToEditor / extractedCodex 等) が変わったので episodic index の
  // weight 列を更新するため再 index をスケジュール。content 不変でも hash に signal を
  // 含めるため Rust 側で列が更新される。fire-and-forget。
  scheduleChatIndex(messageId);
}

/**
 * Synchronous guard for cross-feature actions (Editor insert, Codex/Snippet
 * extraction) whose side effect must not outrun the source Chat row.
 */
export function assertMessageMutationAllowed(messageId: string): void {
  pendingCompletedTurnPersistence.assertNone({
    kind: "message-id",
    messageId,
  });
}

/** 過去メッセージのプロンプト確認用スナップショット (chat_message_prompts)。 */
export interface MessagePromptSnapshot {
  systemPrompt: string;
  layers: LayerBreakdown[];
  totalTokens: number | null;
  model: string | null;
  provider: AiProvider | null;
  contextWindow: number | null;
}

interface MessagePromptPayload {
  layers: LayerBreakdown[];
  provider: AiProvider | null;
  contextWindow: number | null;
}

function parseSnapshotPayload(raw: string | null): MessagePromptPayload {
  const empty: MessagePromptPayload = {
    layers: [],
    provider: null,
    contextWindow: null,
  };
  if (!raw) return empty;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      // Legacy rows stored the layer array directly.
      return { ...empty, layers: parsed as LayerBreakdown[] };
    }
    if (parsed && typeof parsed === "object") {
      const payload = parsed as Record<string, unknown>;
      return {
        layers: Array.isArray(payload.layers)
          ? (payload.layers as LayerBreakdown[])
          : [],
        provider:
          typeof payload.provider === "string"
            ? (payload.provider as AiProvider)
            : null,
        contextWindow:
          typeof payload.contextWindow === "number" &&
          Number.isSafeInteger(payload.contextWindow) &&
          payload.contextWindow > 0
            ? payload.contextWindow
            : null,
      };
    }
    return empty;
  } catch {
    return empty;
  }
}

/**
 * 送信時に確定したシステムプロンプトを userMsg.id にひも付けて保存する。
 * 再生成 / 編集再送で同一 ID が来たら最新の送信内容で上書きする (最後に送った
 * 内容を正とする)。fire-and-forget 前提なので失敗は呼び出し側で握りつぶす。
 */
export async function saveMessagePrompt(
  messageId: string,
  snapshot: {
    systemPrompt: string;
    layers: LayerBreakdown[];
    totalTokens: number | null;
    model: string | null;
    provider?: AiProvider | null;
    contextWindow?: number | null;
  },
): Promise<void> {
  const layersJson = JSON.stringify({
    layers: snapshot.layers ?? [],
    provider: snapshot.provider ?? null,
    contextWindow: snapshot.contextWindow ?? null,
  });
  await db
    .insert(chatMessagePrompts)
    .values({
      messageId,
      systemPrompt: snapshot.systemPrompt,
      layers: layersJson,
      totalTokens: snapshot.totalTokens ?? null,
      model: snapshot.model ?? null,
      createdAt: new Date().toISOString(),
    })
    .onConflictDoUpdate({
      target: chatMessagePrompts.messageId,
      set: {
        systemPrompt: snapshot.systemPrompt,
        layers: layersJson,
        totalTokens: snapshot.totalTokens ?? null,
        model: snapshot.model ?? null,
        createdAt: new Date().toISOString(),
      },
    });
}

/** 遅延取得: プレビューを開いたときだけ呼ぶ。未記録 (旧メッセージ) は null。 */
export async function getMessagePrompt(
  messageId: string,
): Promise<MessagePromptSnapshot | null> {
  const rows = await db
    .select()
    .from(chatMessagePrompts)
    .where(eq(chatMessagePrompts.messageId, messageId));
  const row = rows[0];
  if (!row) return null;
  const payload = parseSnapshotPayload(row.layers);
  return {
    systemPrompt: row.systemPrompt,
    layers: payload.layers,
    totalTokens: row.totalTokens,
    model: row.model,
    provider: payload.provider,
    contextWindow: payload.contextWindow,
  };
}

export async function updateSessionTitle(
  id: string,
  title: string,
): Promise<void> {
  await db
    .update(chatSessions)
    .set({ title, titleManual: 1, updatedAt: new Date().toISOString() })
    .where(eq(chatSessions.id, id));
}

export async function updateSessionTitleIfAutomatic(
  id: string,
  title: string,
): Promise<boolean> {
  const updated = await db
    .update(chatSessions)
    .set({ title, updatedAt: new Date().toISOString() })
    .where(and(eq(chatSessions.id, id), eq(chatSessions.titleManual, 0)))
    .returning({ id: chatSessions.id });
  return updated.length > 0;
}

// --- Pinned Codex entries (normalized: chat_session_pinned_codex table) ---

export type PinnedCodexEntryWithData = CodexEntry & {
  withChildren: boolean;
  pinnedType: "codex" | "snippet";
  /** ピンの起源。`chat_mention` は旧バージョンが保存した互換値。 */
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
/** A map sticky returned as a chat-context pinned item. */
export interface PinnedStickyEntryWithData {
  id: string;
  title: string | null;
  content: string;
  pinnedType: "sticky";
}

export async function listPinnedStickyEntries(
  sessionId: string,
): Promise<PinnedStickyEntryWithData[]> {
  const pinRows = await db
    .select({ stickyId: chatSessionPinnedCodex.stickyId })
    .from(chatSessionPinnedCodex)
    .where(
      and(
        eq(chatSessionPinnedCodex.sessionId, sessionId),
        isNotNull(chatSessionPinnedCodex.stickyId),
      ),
    )
    .orderBy(asc(chatSessionPinnedCodex.createdAt));

  const ids = pinRows
    .map((r) => r.stickyId)
    .filter((id): id is string => id !== null);
  if (ids.length === 0) return [];

  const entries = await db
    .select()
    .from(mapStickies)
    .where(inArray(mapStickies.id, ids));
  const entryMap = new Map(entries.map((e) => [e.id, e]));

  return ids
    .map((id) => entryMap.get(id))
    .filter((e): e is NonNullable<typeof e> => e !== undefined)
    .map((e) => ({
      id: e.id,
      title: e.title,
      content: prosemirrorToText(e.body),
      pinnedType: "sticky" as const,
    }));
}

export async function pinStickyEntry(
  sessionId: string,
  stickyId: string,
): Promise<void> {
  await db
    .insert(chatSessionPinnedCodex)
    .values({
      id: crypto.randomUUID(),
      sessionId,
      stickyId,
      codexEntryId: null,
      snippetId: null,
      withChildren: 0,
      pinSource: "manual",
    })
    .onConflictDoNothing();
}

export async function unpinStickyEntry(
  sessionId: string,
  stickyId: string,
): Promise<void> {
  await db
    .delete(chatSessionPinnedCodex)
    .where(
      and(
        eq(chatSessionPinnedCodex.sessionId, sessionId),
        eq(chatSessionPinnedCodex.stickyId, stickyId),
      ),
    );
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
          stickyId: null,
          withChildren: withChildren ? 1 : 0,
          pinSource: source,
        }
      : {
          id: crypto.randomUUID(),
          sessionId,
          codexEntryId: entryId,
          snippetId: null,
          stickyId: null,
          withChildren: withChildren ? 1 : 0,
          pinSource: source,
        };
  const insert = db.insert(chatSessionPinnedCodex).values(values);
  if (source === "manual") {
    // Older releases persisted current-input mentions in the same unique row
    // with pinSource=chat_mention. Promote that row atomically when the user
    // explicitly chooses Spotlight instead of silently ignoring the insert.
    const conflictTarget =
      type === "snippet"
        ? [chatSessionPinnedCodex.sessionId, chatSessionPinnedCodex.snippetId]
        : [
            chatSessionPinnedCodex.sessionId,
            chatSessionPinnedCodex.codexEntryId,
          ];
    await insert.onConflictDoUpdate({
      target: conflictTarget,
      // The normalized pin table uses partial UNIQUE indexes so nullable
      // polymorphic columns can coexist. SQLite only matches an UPSERT target
      // when its predicate matches the index predicate exactly.
      targetWhere:
        type === "snippet"
          ? isNotNull(chatSessionPinnedCodex.snippetId)
          : isNotNull(chatSessionPinnedCodex.codexEntryId),
      set: {
        pinSource: "manual",
        withChildren: withChildren ? 1 : 0,
      },
    });
  } else {
    await insert.onConflictDoNothing();
  }
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
          eq(chatSessionPinnedCodex.stickyId, entryId),
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
