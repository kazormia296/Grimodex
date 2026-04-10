import { create } from "zustand";
import { toast } from "sonner";
import * as chatApi from "./chatApi";
import { debugLog, errorDetail } from "@/lib/debugLog";

// ---------------------------------------------------------------------------
// D-17: Error classification and retry helpers
// ---------------------------------------------------------------------------

function classifyError(
  e: unknown,
): "auth" | "rate_limit" | "network" | "unknown" {
  const msg = e instanceof Error ? e.message : String(e);
  if (/401|unauthorized|authentication|api\.key|invalid\.key/i.test(msg))
    return "auth";
  if (/429|rate.?limit|too.?many.?request/i.test(msg)) return "rate_limit";
  if (/network|connect|timeout|fetch|ECONNREFUSED/i.test(msg)) return "network";
  return "unknown";
}

async function withNetworkRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  baseDelayMs = 1000,
): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (e) {
      // Only retry transient network errors
      const kind = classifyError(e);
      if (kind !== "network") throw e;
      attempt++;
      if (attempt >= maxRetries) throw e;
      const delay = baseDelayMs * Math.pow(2, attempt - 1);
      await new Promise((res) => setTimeout(res, delay));
    }
  }
}

import {
  buildSystemPrompt,
  buildAgentSystemPrompt,
  buildStorySoFar,
  countTokens,
  allocateLayerBudgets,
} from "./contextBuilder";
import type {
  SceneContext,
  ProjectContext,
  CodexContext,
  LayerBreakdown,
} from "./contextBuilder";
import { extractPlainText } from "@/features/codex/prosemirrorTextExtractor";
import { runAgentLoop } from "./agent/agentLoop";
import { executeTool } from "./agent/toolExecutors";
import { AGENT_TOOLS } from "./agent/toolDefinitions";
import {
  getToolTokenBudget,
  buildThinkingParams,
  getEffortForTask,
  getModelCapabilities,
} from "./agent/modelLimits";
import { useAiSettingsStore } from "./store";
import type {
  AgentMessagePayload,
  ToolCallRecord,
  AgentLoopProgress,
} from "./agent/agentTypes";
import { useTreeStore } from "@/features/tree/treeStore";
import { loadSceneContent } from "@/features/tree/api";
import { getNode } from "@/features/tree/api";
import { getProject } from "@/features/project/api";
import { useSettingsStore } from "@/features/settings/settingsStore";
import { listCodexEntries } from "@/features/codex/api";
import { findMentionedEntriesAsync } from "@/features/codex/rustMatcher";
import {
  getDescendantsBFS,
  getChildrenFromArray,
  buildChildrenContext,
  computeChildrenTokenBudget,
} from "@/features/codex/childrenBudget";
import type { ChatMessage, ChatSession, MessageRole } from "./chatTypes";

interface ChatState {
  // Session management
  sessions: ChatSession[];
  activeSessionId: string | null;
  isLoadingSessions: boolean;

  // Messages & streaming
  messages: ChatMessage[];
  isStreaming: boolean;
  error: string | null;
  activeSceneId: string;
  activeProjectId: string | null;
  contextTokenCount: number;
  contextLayers: LayerBreakdown[];

  // Session actions
  loadSessions: (nodeId?: string | null) => Promise<void>;
  selectSession: (sessionId: string | null) => Promise<void>;
  createNewSession: (
    projectId: string,
    title: string,
    nodeId?: string,
  ) => Promise<void>;
  deleteSession: (sessionId: string) => Promise<void>;
  persistMessage: (role: MessageRole, content: string) => Promise<void>;

  // Agent mode
  agentMode: boolean;
  agentProgress: AgentLoopProgress | null;
  setAgentMode: (on: boolean) => void;

  // Global chat (project scope, no scene context)
  isGlobalChat: boolean;
  setIsGlobalChat: (on: boolean) => void;

  // Existing actions
  sendMessage: (content: string, commandInstruction?: string) => Promise<void>;
  buildPromptForCopy: (userInput: string) => Promise<string>;
  stopGeneration: () => void;
  deleteMessage: (messageId: string) => Promise<void>;
  editUserMessage: (messageId: string) => string;
  regenerate: (assistantMessageId: string) => Promise<void>;
  refreshContextLayers: () => Promise<void>;
  clearMessages: () => void;
  clearError: () => void;
  setActiveSceneId: (id: string) => void;
  setActiveProjectId: (id: string | null) => void;
}

async function fetchSceneContext(
  sceneId: string,
): Promise<SceneContext | null> {
  try {
    const [node, content] = await Promise.all([
      getNode(sceneId),
      loadSceneContent(sceneId),
    ]);
    if (!node) return null;
    return { id: node.id, title: node.title, content: content ?? "" };
  } catch {
    return null;
  }
}

async function fetchProjectContext(
  projectId: string | null,
): Promise<ProjectContext | null> {
  if (projectId == null) return null;
  try {
    const project = await getProject(projectId);
    if (!project) return null;
    return {
      title: project.title,
      genre: project.genre,
      pov: project.pov,
      tense: project.tense,
      styleGuide: project.styleGuide,
      aiInstructions: project.aiInstructions,
    };
  } catch {
    return null;
  }
}

export const useChatStore = create<ChatState>()((set, get) => ({
  sessions: [],
  activeSessionId: null,
  isLoadingSessions: false,
  messages: [],
  isStreaming: false,
  error: null,
  activeSceneId: "",
  activeProjectId: null,
  contextTokenCount: 0,
  contextLayers: [],
  agentMode: false,
  agentProgress: null,
  isGlobalChat: false,

  // --- Session management ---

  loadSessions: async (nodeId?: string | null) => {
    set({ isLoadingSessions: true });
    try {
      const sessions = await chatApi.listSessions(nodeId);
      set({ sessions, isLoadingSessions: false });
    } catch (e) {
      set({ isLoadingSessions: false });
      toast.error("チャットセッションの読み込みに失敗しました");
      debugLog.error("ChatStore", "loadSessions", errorDetail(e));
    }
  },

  selectSession: async (sessionId: string | null) => {
    if (sessionId === null) {
      set({ activeSessionId: null, messages: [] });
      return;
    }
    try {
      const messages = await chatApi.listMessages(sessionId);
      set({ activeSessionId: sessionId, messages });
    } catch (e) {
      toast.error("メッセージの読み込みに失敗しました");
      debugLog.error("ChatStore", "selectSession", errorDetail(e));
    }
  },

  createNewSession: async (
    projectId: string,
    title: string,
    nodeId?: string,
  ) => {
    try {
      const session = await chatApi.createSession(projectId, title, nodeId);
      set((state) => ({
        sessions: [session, ...state.sessions],
        activeSessionId: session.id,
        messages: [],
      }));
    } catch (e) {
      toast.error("セッションの作成に失敗しました");
      debugLog.error("ChatStore", "createNewSession", errorDetail(e));
    }
  },

  deleteSession: async (sessionId: string) => {
    try {
      await chatApi.deleteSession(sessionId);
      const { activeSessionId } = get();
      set((state) => ({
        sessions: state.sessions.filter((s) => s.id !== sessionId),
        ...(activeSessionId === sessionId
          ? { activeSessionId: null, messages: [] }
          : {}),
      }));
    } catch (e) {
      toast.error("セッションの削除に失敗しました");
      debugLog.error("ChatStore", "deleteSession", errorDetail(e));
    }
  },

  persistMessage: async (role: MessageRole, content: string) => {
    const { activeSessionId } = get();
    if (!activeSessionId) return;

    try {
      const message = await chatApi.addMessage(activeSessionId, role, content);
      set((state) => ({
        messages: [...state.messages, message],
      }));
    } catch (e) {
      toast.error("メッセージの保存に失敗しました");
      debugLog.error("ChatStore", "persistMessage", errorDetail(e));
    }
  },

  // --- Prompt preview for copy ---

  buildPromptForCopy: async (userInput: string): Promise<string> => {
    const {
      activeSceneId,
      activeProjectId,
      activeSessionId,
      isGlobalChat,
      agentMode,
      messages: prevMessages,
    } = get();
    const effectiveSceneId = isGlobalChat ? null : activeSceneId;

    const parts: string[] = [];

    try {
      const [sceneCtx, projectCtx] = await Promise.all([
        effectiveSceneId ? fetchSceneContext(effectiveSceneId) : null,
        fetchProjectContext(activeProjectId),
      ]);

      if (sceneCtx || projectCtx) {
        const allNodes = useTreeStore.getState().nodes;
        const l2Pct = useSettingsStore
          .getState()
          .getNumber("ai.contextBudget.l2", 10);
        const storySoFarBudget = Math.round((l2Pct / 100) * 200_000);

        if (agentMode) {
          const storySoFar = sceneCtx
            ? buildStorySoFar(sceneCtx.id, allNodes, storySoFarBudget)
            : "";
          const systemPrompt = buildAgentSystemPrompt({
            scene: sceneCtx ?? undefined,
            project: projectCtx ?? undefined,
            storySoFar: storySoFar || undefined,
          });
          parts.push(`[system]\n${systemPrompt}`);
        } else if (sceneCtx) {
          const allEntries = await listCodexEntries();
          const mentioned = await findMentionedEntriesAsync(
            sceneCtx.content,
            allEntries,
          );
          const L4_TOTAL_BUDGET = 60_000;
          const codexEntries: CodexContext[] = mentioned.map((e) => {
            const fullEntry = allEntries.find((a) => a.id === e.id);
            if (!fullEntry)
              return {
                id: e.id,
                type: e.type,
                name: e.name,
                summary: "",
              };
            const preset = fullEntry.childrenBudget ?? "compact";
            if (preset === "none")
              return {
                id: e.id,
                type: e.type,
                name: e.name,
                summary: fullEntry.summary ?? "",
              };
            const budget = computeChildrenTokenBudget(preset, L4_TOTAL_BUDGET);
            const descendants = getDescendantsBFS(fullEntry.id, allEntries);
            const childrenContext = buildChildrenContext(descendants, budget);
            return childrenContext
              ? {
                  id: e.id,
                  type: e.type,
                  name: e.name,
                  summary: fullEntry.summary ?? "",
                  childrenContext,
                }
              : {
                  id: e.id,
                  type: e.type,
                  name: e.name,
                  summary: fullEntry.summary ?? "",
                };
          });

          let pinnedCodexEntries: import("./contextBuilder").PinnedCodexContext[] =
            [];
          if (activeSessionId) {
            const pinned =
              await chatApi.listPinnedCodexEntries(activeSessionId);
            pinnedCodexEntries = pinned.map((e) => {
              const children = e.withChildren
                ? getChildrenFromArray(e.id, allEntries).map((c) => ({
                    id: c.id,
                    type: c.type,
                    name: c.name,
                    summary: c.summary ?? "",
                  }))
                : undefined;
              return {
                id: e.id,
                type: e.type,
                name: e.name,
                summary: e.summary ?? "",
                withChildren: e.withChildren,
                children,
              };
            });
          }

          const storySoFar = buildStorySoFar(
            sceneCtx.id,
            allNodes,
            storySoFarBudget,
          );
          const { prompt } = buildSystemPrompt({
            scene: sceneCtx,
            project: projectCtx ?? undefined,
            storySoFar: storySoFar || undefined,
            codexEntries,
            pinnedCodexEntries,
          });
          parts.push(`[system]\n${prompt}`);
        } else if (projectCtx) {
          // Global chat: project context only (no scene)
          const { prompt } = buildSystemPrompt({
            scene: { id: "", title: "", content: "" },
            project: projectCtx,
          });
          parts.push(`[system]\n${prompt}`);
        }
      }
    } catch {
      // コンテキスト取得失敗は無視してメッセージ履歴のみ出力
    }

    // 会話履歴
    for (const msg of prevMessages) {
      if (msg.role === "system") continue;
      parts.push(`[${msg.role}]\n${msg.content}`);
    }

    // 今回のユーザー入力
    parts.push(`[user]\n${userInput}`);

    return parts.join("\n\n---\n\n");
  },

  // --- Streaming chat ---

  sendMessage: async (content: string, commandInstruction?: string) => {
    const {
      isStreaming,
      activeSceneId,
      activeProjectId,
      activeSessionId,
      isGlobalChat,
    } = get();
    if (isStreaming) return;
    if (!content.trim()) return;
    const effectiveSceneId = isGlobalChat ? null : activeSceneId;

    const sessionId = activeSessionId ?? "";

    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      sessionId,
      role: "user",
      content,
      createdAt: new Date().toISOString(),
    };

    const assistantMsg: ChatMessage = {
      id: crypto.randomUUID(),
      sessionId,
      role: "assistant",
      content: "",
      createdAt: new Date().toISOString(),
    };

    const prevMessages = get().messages;
    set({
      messages: [...prevMessages, userMsg, assistantMsg],
      isStreaming: true,
      error: null,
    });

    // -----------------------------------------------------------------------
    // セッションが未作成の場合は自動作成 (P0-2)
    // -----------------------------------------------------------------------
    let sessionIdForPersist = activeSessionId;
    if (!sessionIdForPersist) {
      const effectiveNodeId = isGlobalChat
        ? undefined
        : (effectiveSceneId ?? undefined);
      try {
        const session = await chatApi.createSession(
          activeProjectId ?? "default-project",
          "New session",
          effectiveNodeId ?? undefined,
        );
        sessionIdForPersist = session.id;
        set((state) => ({
          sessions: [session, ...state.sessions],
          activeSessionId: session.id,
          messages: state.messages.map((m) => ({
            ...m,
            sessionId: session.id,
          })),
        }));
      } catch (e) {
        debugLog.error("ChatStore", "auto-create session", errorDetail(e));
      }
    }

    // -----------------------------------------------------------------------
    // Agent mode path — tool-use loop
    // -----------------------------------------------------------------------
    if (get().agentMode) {
      try {
        const sceneCtx = effectiveSceneId
          ? await fetchSceneContext(effectiveSceneId)
          : null;
        const projectCtx = await fetchProjectContext(activeProjectId);

        // Build agent system prompt (Layer 4 excluded)
        const agentMsgs: AgentMessagePayload[] = [];
        if (sceneCtx ?? projectCtx) {
          const allNodes = useTreeStore.getState().nodes;
          const l2Pct = useSettingsStore
            .getState()
            .getNumber("ai.contextBudget.l2", 10);
          const storySoFarBudget = Math.round((l2Pct / 100) * 200_000);
          const storySoFar = sceneCtx
            ? buildStorySoFar(sceneCtx.id, allNodes, storySoFarBudget)
            : "";
          const systemPrompt = buildAgentSystemPrompt({
            scene: sceneCtx ?? undefined,
            project: projectCtx ?? undefined,
            storySoFar: storySoFar || undefined,
          });
          set({ contextTokenCount: countTokens(systemPrompt) });
          agentMsgs.push({ role: "system", content: systemPrompt });
        }

        // Convert conversation history
        for (const msg of prevMessages) {
          if (msg.role === "system") continue;
          if (msg.role === "user") {
            agentMsgs.push({ role: "user", content: msg.content });
          } else if (msg.role === "assistant") {
            agentMsgs.push({ role: "assistant", content: msg.content });
          }
        }
        agentMsgs.push({ role: "user", content });

        // Token budget + thinking params
        const aiSettings = useAiSettingsStore.getState().settings;
        const currentModel = aiSettings?.model ?? "";
        const tokenBudget = getToolTokenBudget(currentModel);
        const agentThinkingParams = buildThinkingParams(
          currentModel,
          getEffortForTask("agent"),
          "summarized",
          aiSettings?.thinkingEnabled ?? true,
        );

        // Accumulate tool calls for live metadata update
        const accToolCalls: ToolCallRecord[] = [];

        const { toolCallRecords, finalThinkingBlocks } = await runAgentLoop({
          messages: agentMsgs,
          tools: AGENT_TOOLS,
          tokenBudget,
          sendToLLM: (msgs, tools) =>
            chatApi.sendAgentMessage(msgs, tools, agentThinkingParams),
          executeTool,
          onProgress: (progress) => {
            set({ agentProgress: progress });
          },
          onToolComplete: (record) => {
            accToolCalls.push(record);
            set((s) => {
              const msgs = [...s.messages];
              const last = msgs[msgs.length - 1];
              if (last?.role === "assistant") {
                msgs[msgs.length - 1] = {
                  ...last,
                  metadata: JSON.stringify({ tool_calls: accToolCalls }),
                };
              }
              return { messages: msgs };
            });
          },
          onTextChunk: (text) => {
            set((s) => {
              const msgs = [...s.messages];
              const last = msgs[msgs.length - 1];
              if (last?.role === "assistant") {
                const prev = last.content;
                msgs[msgs.length - 1] = {
                  ...last,
                  content: prev ? `${prev}\n\n${text}` : text,
                };
              }
              return { messages: msgs };
            });
          },
        });

        // Persist
        if (sessionIdForPersist) {
          await chatApi.addMessage(sessionIdForPersist, "user", content, {
            id: userMsg.id,
          });
          const finalMessages = get().messages;
          const lastMsg = finalMessages[finalMessages.length - 1];
          if (lastMsg?.role === "assistant" && lastMsg.content) {
            await chatApi.addMessage(
              sessionIdForPersist,
              "assistant",
              lastMsg.content,
              {
                id: assistantMsg.id,
                metadata: JSON.stringify({
                  tool_calls: toolCallRecords,
                  ...(finalThinkingBlocks.length > 0
                    ? { thinking_blocks: finalThinkingBlocks }
                    : {}),
                }),
              },
            );
          }
        }
      } catch (e) {
        const kind = classifyError(e);
        const msg = e instanceof Error ? e.message : String(e);
        if (kind === "auth") {
          toast.error("APIキーが無効です。設定を確認してください。");
        } else if (kind === "network") {
          toast.error(
            "ネットワークエラーが発生しました。接続を確認してください。",
          );
        } else {
          toast.error(`エージェント実行に失敗しました: ${msg}`);
        }
        set({ error: msg });
      } finally {
        set({ isStreaming: false, agentProgress: null });
      }
      return;
    }

    // -----------------------------------------------------------------------
    // Normal mode path (existing)
    // -----------------------------------------------------------------------
    try {
      const sceneCtx = effectiveSceneId
        ? await fetchSceneContext(effectiveSceneId)
        : null;
      const projectCtx = await fetchProjectContext(activeProjectId);

      const messagesForApi: ChatMessage[] = [...prevMessages, userMsg];

      if (sceneCtx) {
        const allEntries = await listCodexEntries();

        // G12: context_mode フィルタ
        // hidden → 除外, always → 無条件追加, mentioned → 検出時のみ, suppress → ピンのみ
        const detectableEntries = allEntries.filter(
          (e) => e.contextMode !== "hidden" && e.contextMode !== "suppress",
        );
        const alwaysEntries = allEntries.filter(
          (e) => e.contextMode === "always",
        );

        const mentioned = await findMentionedEntriesAsync(
          sceneCtx.content,
          detectableEntries,
        );

        // Merge: always + mentioned (deduplicated)
        const mentionedIds = new Set(mentioned.map((e) => e.id));
        const alwaysNotMentioned = alwaysEntries.filter(
          (e) => !mentionedIds.has(e.id),
        );
        const rawCodexEntries = [...mentioned, ...alwaysNotMentioned];

        const buildCodexContext = (e: (typeof allEntries)[0]): CodexContext => {
          const summary = e.summary ?? "";
          // G13: summary空ならcontent全文をフォールバック
          const contentFallback = summary.trim()
            ? undefined
            : extractPlainText(e.content) || undefined;
          return {
            id: e.id,
            type: e.type,
            name: e.name,
            summary,
            contentFallback,
          };
        };

        const baseCodexEntries: CodexContext[] = rawCodexEntries.map((e) => {
          const full = allEntries.find((a) => a.id === e.id);
          return full
            ? buildCodexContext(full)
            : { id: e.id, type: e.type, name: e.name, summary: "" };
        });

        // Enrich with children context (subtree token budget)
        // G8: use ratio-based budget from model contextWindow
        const chatModel = useAiSettingsStore.getState().settings?.model ?? "";
        const { contextWindow } = getModelCapabilities(chatModel);
        const budgets = allocateLayerBudgets(contextWindow);
        const L4_TOTAL_BUDGET = budgets.l4;
        const codexEntries: CodexContext[] = baseCodexEntries.map((ctx) => {
          const fullEntry = allEntries.find((e) => e.id === ctx.id);
          if (!fullEntry) return ctx;
          const preset = fullEntry.childrenBudget ?? "compact";
          if (preset === "none") return ctx;
          const budget = computeChildrenTokenBudget(preset, L4_TOTAL_BUDGET);
          const descendants = getDescendantsBFS(fullEntry.id, allEntries);
          const childrenContext = buildChildrenContext(descendants, budget);
          return childrenContext ? { ...ctx, childrenContext } : ctx;
        });

        // P2-5: チャットメッセージ内のCodex言及を検出し自動ピン留め
        if (sessionIdForPersist) {
          const chatMentioned = await findMentionedEntriesAsync(
            content,
            allEntries,
          );
          for (const entry of chatMentioned) {
            await chatApi
              .pinCodexEntry(
                sessionIdForPersist,
                entry.id,
                false,
                "chat_mention",
              )
              .catch(() => {});
          }
        }

        let pinnedCodexEntries: import("./contextBuilder").PinnedCodexContext[] =
          [];
        if (activeSessionId) {
          const pinned = await chatApi.listPinnedCodexEntries(activeSessionId);
          pinnedCodexEntries = pinned.map((e) => {
            const children = e.withChildren
              ? getChildrenFromArray(e.id, allEntries).map((c) => ({
                  id: c.id,
                  type: c.type,
                  name: c.name,
                  summary: c.summary ?? "",
                }))
              : undefined;
            return {
              id: e.id,
              type: e.type,
              name: e.name,
              summary: e.summary ?? "",
              withChildren: e.withChildren,
              children,
            };
          });
        }

        // G8: ratio-based L2 budget from model contextWindow
        const allNodes = useTreeStore.getState().nodes;
        const storySoFarBudget = budgets.l2;
        const storySoFar = buildStorySoFar(
          sceneCtx.id,
          allNodes,
          storySoFarBudget,
        );

        // G11: 直前シーンのsynopsisを取得
        const currentScene = allNodes.find((n) => n.id === sceneCtx.id);
        const previousSceneNode = currentScene
          ? allNodes
              .filter(
                (n) =>
                  n.nodeType === "scene" &&
                  n.id !== sceneCtx.id &&
                  n.sortOrder < currentScene.sortOrder &&
                  n.synopsis != null &&
                  n.synopsis.trim() !== "",
              )
              .sort((a, b) => b.sortOrder - a.sortOrder)[0]
          : undefined;
        const previousScene = previousSceneNode
          ? {
              title: previousSceneNode.title,
              synopsis: previousSceneNode.synopsis as string,
            }
          : undefined;

        const promptResult = buildSystemPrompt({
          scene: sceneCtx,
          project: projectCtx ?? undefined,
          storySoFar: storySoFar || undefined,
          previousScene,
          codexEntries,
          pinnedCodexEntries,
          commandInstruction,
          contextWindow,
        });

        set({
          contextTokenCount: promptResult.totalTokens,
          contextLayers: promptResult.layers,
        });

        const systemMsg: ChatMessage = {
          id: "system",
          sessionId,
          role: "system",
          content: promptResult.prompt,
          createdAt: new Date().toISOString(),
        };
        messagesForApi.unshift(systemMsg);
      }

      const chatModel = useAiSettingsStore.getState().settings?.model ?? "";
      const chatThinkingParams = buildThinkingParams(
        chatModel,
        getEffortForTask("chat"),
        "summarized",
        useAiSettingsStore.getState().settings?.thinkingEnabled ?? true,
      );
      const apiPayload = messagesForApi.map((m) => ({
        role: m.role,
        content: m.content,
      }));
      const chatStartTime = performance.now();
      const {
        text: responseText,
        thinkingBlocks: chatThinkingBlocks,
        inputTokens: chatInputTokens,
        outputTokens: chatOutputTokens,
      } = await withNetworkRetry(() =>
        chatApi.sendChatMessageWithThinking(apiPayload, chatThinkingParams),
      );
      const chatDurationMs = Math.round(performance.now() - chatStartTime);
      const chatMetadata =
        chatThinkingBlocks.length > 0
          ? JSON.stringify({ thinking_blocks: chatThinkingBlocks })
          : undefined;
      set((s) => {
        const msgs = [...s.messages];
        const last = msgs[msgs.length - 1];
        if (last && last.role === "assistant") {
          msgs[msgs.length - 1] = {
            ...last,
            content: responseText,
            ...(chatMetadata ? { metadata: chatMetadata } : {}),
          };
        }
        return { messages: msgs };
      });

      if (sessionIdForPersist) {
        const finalMessages = get().messages;
        const lastMsg = finalMessages[finalMessages.length - 1];
        await chatApi.addMessage(sessionIdForPersist, "user", content, {
          id: userMsg.id,
        });
        if (lastMsg && lastMsg.role === "assistant" && lastMsg.content) {
          await chatApi.addMessage(
            sessionIdForPersist,
            "assistant",
            lastMsg.content,
            {
              id: assistantMsg.id,
              model: chatModel || undefined,
              tokensIn: chatInputTokens,
              tokensOut: chatOutputTokens,
              durationMs: chatDurationMs,
              ...(chatMetadata ? { metadata: chatMetadata } : {}),
            },
          );
        }

        // セッションタイトル自動生成 (P1-2) — fire-and-forget
        const isFirstResponse =
          prevMessages.filter((m) => m.role === "assistant").length === 0;
        const currentSession = get().sessions.find(
          (s) => s.id === sessionIdForPersist,
        );
        if (
          isFirstResponse &&
          currentSession &&
          currentSession.titleManual === 0 &&
          lastMsg?.role === "assistant" &&
          lastMsg.content
        ) {
          chatApi
            .generateSessionTitle(content, lastMsg.content, chatModel)
            .then(async (title) => {
              if (!title) {
                // フォールバック: ユーザーメッセージの先頭30文字
                title = content.slice(0, 30);
              }
              if (sessionIdForPersist) {
                await chatApi.updateSessionTitle(sessionIdForPersist, title);
                set((state) => ({
                  sessions: state.sessions.map((s) =>
                    s.id === sessionIdForPersist ? { ...s, title } : s,
                  ),
                }));
              }
            })
            .catch((e) => {
              debugLog.error("ChatStore", "title generation", errorDetail(e));
            });
        }
      }
    } catch (e) {
      const kind = classifyError(e);
      const msg = e instanceof Error ? e.message : String(e);

      if (kind === "auth") {
        toast.error("APIキーが無効です。設定を確認してください。", {
          action: {
            label: "設定を開く",
            onClick: () => {
              // Signal to open settings dialog via a custom event
              window.dispatchEvent(
                new CustomEvent("open-settings", {
                  detail: { category: "ai" },
                }),
              );
            },
          },
          duration: 8000,
        });
      } else if (kind === "rate_limit") {
        // Retry after a delay for 429
        toast.warning("レート制限に達しました。10秒後に再試行します…");
        setTimeout(() => {
          get().sendMessage(content);
        }, 10_000);
        set({ isStreaming: false });
        return;
      } else if (kind === "network") {
        toast.error(
          "ネットワークエラーが発生しました。接続を確認してください。",
        );
      } else {
        toast.error(`送信に失敗しました: ${msg}`);
      }

      set({ error: msg });
    } finally {
      set({ isStreaming: false });
    }
  },

  refreshContextLayers: async () => {
    const { activeSceneId, activeProjectId, activeSessionId, isGlobalChat } =
      get();
    const effectiveSceneId = isGlobalChat ? null : activeSceneId;
    if (!effectiveSceneId) {
      set({ contextTokenCount: 0, contextLayers: [] });
      return;
    }
    try {
      const [sceneCtx, projectCtx] = await Promise.all([
        fetchSceneContext(effectiveSceneId),
        fetchProjectContext(activeProjectId),
      ]);
      if (!sceneCtx) return;

      const allEntries = await listCodexEntries();
      const mentioned = await findMentionedEntriesAsync(
        sceneCtx.content,
        allEntries,
      );
      const L4_TOTAL_BUDGET = 60_000;
      const codexEntries: CodexContext[] = mentioned.map((e) => {
        const fullEntry = allEntries.find((a) => a.id === e.id);
        const summary = fullEntry?.summary ?? "";
        if (!fullEntry)
          return { id: e.id, type: e.type, name: e.name, summary };
        const preset = fullEntry.childrenBudget ?? "compact";
        if (preset === "none")
          return { id: e.id, type: e.type, name: e.name, summary };
        const budget = computeChildrenTokenBudget(preset, L4_TOTAL_BUDGET);
        const descendants = getDescendantsBFS(fullEntry.id, allEntries);
        const childrenContext = buildChildrenContext(descendants, budget);
        return childrenContext
          ? { id: e.id, type: e.type, name: e.name, summary, childrenContext }
          : { id: e.id, type: e.type, name: e.name, summary };
      });

      let pinnedCodexEntries: import("./contextBuilder").PinnedCodexContext[] =
        [];
      if (activeSessionId) {
        const pinned = await chatApi.listPinnedCodexEntries(activeSessionId);
        pinnedCodexEntries = pinned.map((e) => {
          const children = e.withChildren
            ? getChildrenFromArray(e.id, allEntries).map((c) => ({
                id: c.id,
                type: c.type,
                name: c.name,
                summary: c.summary ?? "",
              }))
            : undefined;
          return {
            id: e.id,
            type: e.type,
            name: e.name,
            summary: e.summary ?? "",
            withChildren: e.withChildren,
            children,
          };
        });
      }

      const allNodes = useTreeStore.getState().nodes;
      const l2Pct = useSettingsStore
        .getState()
        .getNumber("ai.contextBudget.l2", 10);
      const storySoFar = buildStorySoFar(
        sceneCtx.id,
        allNodes,
        Math.round((l2Pct / 100) * 200_000),
      );

      const promptResult = buildSystemPrompt({
        scene: sceneCtx,
        project: projectCtx ?? undefined,
        storySoFar: storySoFar || undefined,
        codexEntries,
        pinnedCodexEntries,
      });
      set({
        contextTokenCount: promptResult.totalTokens,
        contextLayers: promptResult.layers,
      });
    } catch {
      // コンテキスト計算失敗は無視（送信時に再計算される）
    }
  },

  setAgentMode: (on: boolean) => set({ agentMode: on }),
  setIsGlobalChat: (on: boolean) => set({ isGlobalChat: on }),

  // --- P2-1: ストリーミング中断 ---
  stopGeneration: () => {
    set({ isStreaming: false, agentProgress: null });
  },

  // --- P2-2: メッセージ削除 ---
  deleteMessage: async (messageId: string) => {
    const { activeSessionId, messages } = get();
    const idx = messages.findIndex((m) => m.id === messageId);
    if (idx === -1) return;
    const msg = messages[idx];
    try {
      if (msg.role === "user") {
        // ユーザーメッセージ: 以降のメッセージも全削除
        const toDelete = messages.slice(idx).filter((m) => m.role !== "system");
        if (activeSessionId) {
          for (const m of toDelete) {
            await chatApi.deleteMessage(m.id);
          }
        }
        set({ messages: messages.slice(0, idx) });
      } else {
        // AIメッセージ: 単独削除
        if (activeSessionId) {
          await chatApi.deleteMessage(messageId);
        }
        set({ messages: messages.filter((m) => m.id !== messageId) });
      }
    } catch (e) {
      toast.error("メッセージの削除に失敗しました");
      debugLog.error("ChatStore", "deleteMessage", errorDetail(e));
    }
  },

  // --- P2-2: ユーザーメッセージ編集 (内容を返し、以降を削除) ---
  editUserMessage: (messageId: string) => {
    const { activeSessionId, messages } = get();
    const idx = messages.findIndex((m) => m.id === messageId);
    if (idx === -1) return "";
    const content = messages[idx].content;
    const toDelete = messages.slice(idx).filter((m) => m.role !== "system");
    if (activeSessionId) {
      Promise.all(toDelete.map((m) => chatApi.deleteMessage(m.id))).catch((e) =>
        debugLog.error("ChatStore", "editUserMessage", errorDetail(e)),
      );
    }
    set({ messages: messages.slice(0, idx) });
    return content;
  },

  // --- P2-2: AIメッセージ再生成 ---
  regenerate: async (assistantMessageId: string) => {
    const { messages, activeSessionId } = get();
    const assIdx = messages.findIndex((m) => m.id === assistantMessageId);
    if (assIdx === -1) return;

    // 直前のユーザーメッセージを探す
    const userMsg = [...messages]
      .slice(0, assIdx)
      .reverse()
      .find((m) => m.role === "user");
    if (!userMsg) return;

    // アシスタントメッセージを削除
    if (activeSessionId) {
      try {
        await chatApi.deleteMessage(assistantMessageId);
      } catch (e) {
        debugLog.error("ChatStore", "regenerate delete", errorDetail(e));
      }
    }
    set({ messages: messages.filter((m) => m.id !== assistantMessageId) });

    // 再送信 (ユーザーメッセージは既にstateにある)
    await get().sendMessage(userMsg.content);
  },

  clearMessages: () => set({ messages: [] }),
  clearError: () => set({ error: null }),
  setActiveSceneId: (id: string) => {
    const { activeSceneId } = get();
    // シーンが実際に変わったときのみグローバルモードをOFF + セッションをクリア
    if (id !== activeSceneId) {
      set({
        activeSceneId: id,
        isGlobalChat: false,
        activeSessionId: null,
        messages: [],
      });
    } else {
      set({ activeSceneId: id });
    }
  },
  setActiveProjectId: (id: string | null) => set({ activeProjectId: id }),
}));
