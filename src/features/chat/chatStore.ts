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
} from "./contextBuilder";
import type {
  SceneContext,
  ProjectContext,
  CodexContext,
  LayerBreakdown,
} from "./contextBuilder";
import { runAgentLoop } from "./agent/agentLoop";
import { executeTool } from "./agent/toolExecutors";
import { AGENT_TOOLS } from "./agent/toolDefinitions";
import {
  getToolTokenBudget,
  buildThinkingParams,
  getEffortForTask,
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
import { findMentionedEntries } from "@/features/codex/codexMatcher";
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
  sendMessage: (content: string) => Promise<void>;
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

  // --- Streaming chat ---

  sendMessage: async (content: string) => {
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
        const mentioned = findMentionedEntries(sceneCtx.content, allEntries);
        const baseCodExEntries: CodexContext[] = mentioned.map((e) => ({
          id: e.id,
          type: e.type,
          name: e.name,
          summary: allEntries.find((a) => a.id === e.id)?.summary ?? "",
        }));

        // Enrich with children context (subtree token budget)
        const L4_TOTAL_BUDGET = 60_000;
        const codexEntries: CodexContext[] = baseCodExEntries.map((ctx) => {
          const fullEntry = allEntries.find((e) => e.id === ctx.id);
          if (!fullEntry) return ctx;
          const preset = fullEntry.childrenBudget ?? "compact";
          if (preset === "none") return ctx;
          const budget = computeChildrenTokenBudget(preset, L4_TOTAL_BUDGET);
          const descendants = getDescendantsBFS(fullEntry.id, allEntries);
          const childrenContext = buildChildrenContext(descendants, budget);
          return childrenContext ? { ...ctx, childrenContext } : ctx;
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

        // Layer 2: storySoFar — use L2 context budget % from settings (default 10%)
        const allNodes = useTreeStore.getState().nodes;
        const l2Pct = useSettingsStore
          .getState()
          .getNumber("ai.contextBudget.l2", 10);
        const storySoFarBudget = Math.round((l2Pct / 100) * 200_000);
        const storySoFar = buildStorySoFar(
          sceneCtx.id,
          allNodes,
          storySoFarBudget,
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
      const mentioned = findMentionedEntries(sceneCtx.content, allEntries);
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
