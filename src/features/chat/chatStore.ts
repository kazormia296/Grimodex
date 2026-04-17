import { create } from "zustand";
import { toast } from "sonner";
import i18next from "@/lib/i18n";
import * as chatApi from "./chatApi";
import { debugLog, errorDetail } from "@/lib/debugLog";

// ---------------------------------------------------------------------------
// D-17: Error classification and retry helpers
// ---------------------------------------------------------------------------

function classifyError(
  e: unknown,
): "auth" | "rate_limit" | "network" | "context_length" | "unknown" {
  const msg = e instanceof Error ? e.message : String(e);
  if (/401|unauthorized|authentication|api\.key|invalid\.key/i.test(msg))
    return "auth";
  if (/429|rate.?limit|too.?many.?request/i.test(msg)) return "rate_limit";
  if (/network|connect|timeout|fetch|ECONNREFUSED/i.test(msg)) return "network";
  if (
    /context.length.exceeded|maximum.context|token.limit|too.long|content.too.large/i.test(
      msg,
    )
  )
    return "context_length";
  return "unknown";
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
import { loadSceneContent, getNode } from "@/features/tree/api";
import { prosemirrorToText } from "@/lib/prosemirror";
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
import {
  shouldSummarize,
  selectSummarizationCandidates,
  runSummarization,
} from "./summarization";
import type { CodexEntry } from "@/features/codex/api";
import {
  listContextDetailsByEntryIds,
  listRawDetailValuesByEntryIds,
} from "@/features/codex/detailApi";
import {
  listPhasesByEntryIds,
  listDetailOverridesByPhaseIds,
} from "@/features/codex/phaseApi";
import type { CodexEntryPhase } from "@/features/codex/phaseApi";
import { resolveCodexState } from "@/features/codex/phaseResolver";
import type { ResolvedCodexState } from "@/features/codex/phaseResolver";
import { usePhaseStore } from "@/features/codex/phaseStore";
import { useTabStore } from "@/features/editor/tabStore";
import { getSnippet } from "@/features/snippets/api";
import { listPinnedSnippetEntries } from "./chatApi";
import type { PinnedSnippetContext } from "./contextBuilder";

// フェーズ解決ヘルパー: エントリ配列に対してフェーズを一括解決する
async function resolveEntriesForContext(
  entries: CodexEntry[],
  effectiveSceneId: string | null,
): Promise<{
  resolved: Map<string, ResolvedCodexState>;
  phases: Map<string, CodexEntryPhase[]>;
}> {
  const resolved = new Map<string, ResolvedCodexState>();
  const phasesMap = new Map<string, CodexEntryPhase[]>();

  if (entries.length === 0) return { resolved, phases: phasesMap };

  const entryIds = entries.map((e) => e.id);

  // フェーズと上書き情報を一括取得
  const allPhases = await listPhasesByEntryIds(entryIds);
  const phaseIds = allPhases.map((p) => p.id);
  const allOverrides = await listDetailOverridesByPhaseIds(phaseIds);

  // phaseId → overrides マップ
  const overridesByPhase = new Map<
    string,
    import("@/features/codex/phaseApi").CodexPhaseDetailOverride[]
  >();
  for (const ov of allOverrides) {
    const arr = overridesByPhase.get(ov.phaseId) ?? [];
    arr.push(ov);
    overridesByPhase.set(ov.phaseId, arr);
  }

  // entryId → phases マップ
  const phasesByEntry = new Map<string, CodexEntryPhase[]>();
  for (const phase of allPhases) {
    const arr = phasesByEntry.get(phase.entryId) ?? [];
    arr.push(phase);
    phasesByEntry.set(phase.entryId, arr);
  }

  // ベースdetailValues取得 (definitionId → value)
  const rawDetails = await listRawDetailValuesByEntryIds(entryIds);
  const detailsByEntry = new Map<string, Map<string, string | null>>();
  for (const row of rawDetails) {
    const m =
      detailsByEntry.get(row.entryId) ?? new Map<string, string | null>();
    m.set(row.definitionId, row.value);
    detailsByEntry.set(row.entryId, m);
  }

  const globalSceneOrder = usePhaseStore.getState().globalSceneOrder;

  for (const entry of entries) {
    const phases = phasesByEntry.get(entry.id) ?? [];
    phasesMap.set(entry.id, phases);

    const phaseDetailsMap = new Map<
      string,
      import("@/features/codex/phaseApi").CodexPhaseDetailOverride[]
    >();
    for (const phase of phases) {
      phaseDetailsMap.set(phase.id, overridesByPhase.get(phase.id) ?? []);
    }

    const baseDetails =
      detailsByEntry.get(entry.id) ?? new Map<string, string | null>();

    resolved.set(
      entry.id,
      resolveCodexState(
        {
          summary: entry.summary ?? null,
          content: entry.content,
          contextMode: entry.contextMode,
        },
        phases,
        phaseDetailsMap,
        baseDetails,
        effectiveSceneId,
        globalSceneOrder,
      ),
    );
  }

  return { resolved, phases: phasesMap };
}

// G14: Enrich CodexContext array with customDetails (batch query, no N+1)
async function enrichWithCustomDetails(
  entries: CodexContext[],
  allEntries: CodexEntry[],
): Promise<CodexContext[]> {
  if (entries.length === 0) return entries;
  const entryIds = entries.map((e) => e.id);
  const details = await listContextDetailsByEntryIds(entryIds);

  // Group by entryId
  const byEntryId = new Map<
    string,
    Array<{ fieldName: string; value: string }>
  >();
  for (const d of details) {
    if (d.value == null) continue;
    let resolved = d.value;
    // codex_reference: resolve entry ID → name
    if (d.fieldType === "codex_reference") {
      const ref = allEntries.find((e) => e.id === d.value);
      resolved = ref ? ref.name : d.value;
    }
    const arr = byEntryId.get(d.entryId) ?? [];
    arr.push({ fieldName: d.fieldName, value: resolved });
    byEntryId.set(d.entryId, arr);
  }

  return entries.map((entry) => {
    const customDetails = byEntryId.get(entry.id);
    return customDetails?.length ? { ...entry, customDetails } : entry;
  });
}

// Helper: compute childrenContext for pinned/G21 entries based on childrenBudget
function buildChildrenCtxForEntry(
  entry: CodexEntry,
  allEntries: CodexEntry[],
  l4Budget: number,
): string | undefined {
  const preset = entry.childrenBudget ?? "compact";
  if (preset === "none") return undefined;
  const budget = computeChildrenTokenBudget(preset, l4Budget);
  const descendants = getDescendantsBFS(entry.id, allEntries);
  return buildChildrenContext(descendants, budget) || undefined;
}

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
  lastSystemPrompt: string;

  // G15: auto-detected and always-mode entries (excluding pinned)
  detectedEntries: CodexEntry[];
  alwaysEntries: CodexEntry[];

  // G21: input-typed entries detected by CodexHighlight (in-memory, pre-send)
  inputPinnedEntryIds: string[];
  setInputPinnedEntryIds: (ids: string[]) => void;

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
  /** G17: スターのトグル（要約対象外フラグ） */
  starMessage: (messageId: string, starred: boolean) => Promise<void>;
  /** G20: stores old message content when editing, to detect removed @mentions */
  _editingOldContent: string | null;
  /** autoリストから特定エントリを即時除去（ピン直後のBug#1修正用） */
  removeEntryFromAuto: (entryId: string) => void;
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
    return {
      id: node.id,
      title: node.title,
      synopsis: node.synopsis ?? undefined,
      content: prosemirrorToText(content ?? ""),
    };
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

// Module-level cleanup function for the active stream
let _streamCleanup: (() => void) | null = null;

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
  lastSystemPrompt: "",
  detectedEntries: [],
  alwaysEntries: [],
  inputPinnedEntryIds: [],
  agentMode: false,
  agentProgress: null,
  isGlobalChat: false,
  _editingOldContent: null,

  removeEntryFromAuto: (entryId: string) => {
    set((state) => ({
      detectedEntries: state.detectedEntries.filter((e) => e.id !== entryId),
      alwaysEntries: state.alwaysEntries.filter((e) => e.id !== entryId),
    }));
  },

  setInputPinnedEntryIds: (ids: string[]) => {
    const { isStreaming, inputPinnedEntryIds } = get();
    if (isStreaming) return;
    const sorted = [...ids].sort();
    const prev = [...inputPinnedEntryIds].sort();
    if (sorted.join(",") === prev.join(",")) return;
    set({ inputPinnedEntryIds: ids });
    get().refreshContextLayers();
  },

  // --- Session management ---

  loadSessions: async (nodeId?: string | null) => {
    set({ isLoadingSessions: true });
    try {
      const sessions = await chatApi.listSessions(nodeId);
      set({ sessions, isLoadingSessions: false });
    } catch (e) {
      set({ isLoadingSessions: false });
      toast.error(i18next.t("chat.loadSessionsFailed"));
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
      toast.error(i18next.t("chat.loadMessagesFailed"));
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
      toast.error(i18next.t("chat.createSessionFailed"));
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
      toast.error(i18next.t("chat.deleteSessionFailed"));
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
      toast.error(i18next.t("chat.saveMessageFailed"));
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
              return { id: e.id, type: e.type, name: e.name, summary: "" };
            const summary = fullEntry.summary ?? "";
            // G13: summary空ならcontent全文をフォールバック
            const contentFallback = summary.trim()
              ? undefined
              : extractPlainText(fullEntry.content) || undefined;
            const preset = fullEntry.childrenBudget ?? "compact";
            if (preset === "none")
              return {
                id: e.id,
                type: e.type,
                name: e.name,
                summary,
                contentFallback,
              };
            const budget = computeChildrenTokenBudget(preset, L4_TOTAL_BUDGET);
            const descendants = getDescendantsBFS(fullEntry.id, allEntries);
            const childrenContext = buildChildrenContext(descendants, budget);
            return childrenContext
              ? {
                  id: e.id,
                  type: e.type,
                  name: e.name,
                  summary,
                  contentFallback,
                  childrenContext,
                }
              : {
                  id: e.id,
                  type: e.type,
                  name: e.name,
                  summary,
                  contentFallback,
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
              const childrenCtx = buildChildrenCtxForEntry(
                e,
                allEntries,
                L4_TOTAL_BUDGET,
              );
              return {
                id: e.id,
                type: e.type,
                name: e.name,
                summary: e.summary ?? "",
                fullContent: extractPlainText(e.content) || undefined,
                withChildren: e.withChildren,
                children,
                ...(childrenCtx ? { childrenContext: childrenCtx } : {}),
              };
            });
          }

          // G21: include input-typed detected entries not yet pinned to DB
          {
            const dbPinnedIdSet = new Set(pinnedCodexEntries.map((e) => e.id));
            const inputIds = get().inputPinnedEntryIds;
            const extraPinned = inputIds
              .filter((id) => !dbPinnedIdSet.has(id))
              .flatMap((id) => {
                const e = allEntries.find((a) => a.id === id);
                if (!e) return [];
                const childrenCtx = buildChildrenCtxForEntry(
                  e,
                  allEntries,
                  L4_TOTAL_BUDGET,
                );
                const ctx: import("./contextBuilder").PinnedCodexContext = {
                  id: e.id,
                  type: e.type,
                  name: e.name,
                  summary: e.summary ?? "",
                  fullContent: extractPlainText(e.content) || undefined,
                  withChildren: false,
                  ...(childrenCtx ? { childrenContext: childrenCtx } : {}),
                };
                return [ctx];
              });
            if (extraPinned.length > 0) {
              pinnedCodexEntries = [...pinnedCodexEntries, ...extraPinned];
            }
          }

          // G14: enrich with custom details
          const enrichedCodexEntries = await enrichWithCustomDetails(
            codexEntries,
            allEntries,
          );

          const storySoFar = buildStorySoFar(
            sceneCtx.id,
            allNodes,
            storySoFarBudget,
          );
          const { prompt } = buildSystemPrompt({
            scene: sceneCtx,
            project: projectCtx ?? undefined,
            storySoFar: storySoFar || undefined,
            codexEntries: enrichedCodexEntries,
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
          set({
            contextTokenCount: countTokens(systemPrompt),
            lastSystemPrompt: systemPrompt,
          });
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
          toast.error(i18next.t("chat.invalidApiKey"));
        } else if (kind === "network") {
          toast.error(i18next.t("chat.networkError"));
        } else {
          toast.error(i18next.t("chat.agentFailed", { message: msg }));
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

      // G17: 要約トリガーチェック
      let currentMessages = get().messages;
      if (sessionIdForPersist && shouldSummarize(prevMessages)) {
        try {
          const candidates = selectSummarizationCandidates(prevMessages);
          if (candidates.length > 0) {
            const summaryText = await runSummarization(
              candidates,
              chatApi.sendChatMessageWithThinking,
            );
            const candidateIds = candidates.map((m) => m.id);
            const chatSummary = await chatApi.addSummary(
              sessionIdForPersist,
              summaryText,
              candidateIds,
            );
            await chatApi.markMessagesSummarized(candidateIds);
            // Update in-memory state: mark candidates as summarized, inject summary into messages
            set((s) => {
              const updatedMessages = s.messages.map((m) =>
                candidateIds.includes(m.id) ? { ...m, isSummarized: 1 } : m,
              );
              const summaryMarkerMsg: ChatMessage = {
                id: `summary-${chatSummary.id}`,
                sessionId: sessionIdForPersist ?? "",
                role: "assistant",
                content: summaryText,
                metadata: JSON.stringify({ summary_id: chatSummary.id }),
                createdAt: chatSummary.createdAt,
                isSummarized: 0,
              };
              // Insert summary marker after the last summarized message
              const lastCandidateIdx = updatedMessages.reduce(
                (acc, m, idx) => (candidateIds.includes(m.id) ? idx : acc),
                -1,
              );
              const withSummary = [
                ...updatedMessages.slice(0, lastCandidateIdx + 1),
                summaryMarkerMsg,
                ...updatedMessages.slice(lastCandidateIdx + 1),
              ];
              return { messages: withSummary };
            });
            currentMessages = get().messages;
          }
        } catch (e) {
          debugLog.error("ChatStore", "summarization", errorDetail(e));
          // 要約失敗は警告のみ、チャットは続行
        }
      }

      // G17: 要約済みメッセージを除外（starred は保持）し、APIペイロードを構築
      const messagesForApi: ChatMessage[] = [
        ...currentMessages.filter(
          (m) =>
            m.id !== userMsg.id && m.id !== assistantMsg.id && !m.isSummarized,
        ),
        userMsg,
      ];

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
        const withChildrenCtx: CodexContext[] = baseCodexEntries.map((ctx) => {
          const fullEntry = allEntries.find((e) => e.id === ctx.id);
          if (!fullEntry) return ctx;
          const preset = fullEntry.childrenBudget ?? "compact";
          if (preset === "none") return ctx;
          const budget = computeChildrenTokenBudget(preset, L4_TOTAL_BUDGET);
          const descendants = getDescendantsBFS(fullEntry.id, allEntries);
          const childrenContext = buildChildrenContext(descendants, budget);
          return childrenContext ? { ...ctx, childrenContext } : ctx;
        });

        // G14: enrich with custom details (includeInContext=1)
        const enrichedCodexEntries: CodexContext[] =
          await enrichWithCustomDetails(withChildrenCtx, allEntries);

        // フェーズ解決: rawCodexEntriesに対応するfullEntryを取得しフェーズ適用
        const rawFullEntries = rawCodexEntries
          .map((e) => allEntries.find((a) => a.id === e.id))
          .filter((e): e is CodexEntry => e !== undefined);
        const { resolved: phaseResolved, phases: entryPhases } =
          await resolveEntriesForContext(rawFullEntries, effectiveSceneId);

        const codexEntries: CodexContext[] = enrichedCodexEntries.map((ctx) => {
          const rs = phaseResolved.get(ctx.id);
          if (!rs) return ctx;
          const phases = entryPhases.get(ctx.id) ?? [];
          const lastPhaseId = rs.appliedPhaseIds[rs.appliedPhaseIds.length - 1];
          const lastPhase = lastPhaseId
            ? phases.find((p) => p.id === lastPhaseId)
            : undefined;
          return {
            ...ctx,
            summary: rs.summary ?? ctx.summary,
            ...(lastPhase ? { phaseLabel: lastPhase.label } : {}),
          };
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

          // G20: メッセージ編集時に削除された@言及のピンを解除
          const { _editingOldContent } = get();
          if (_editingOldContent !== null) {
            try {
              const oldMentioned = await findMentionedEntriesAsync(
                _editingOldContent,
                allEntries,
              );
              const newMentionedIds = new Set(chatMentioned.map((e) => e.id));
              const removedIds = oldMentioned
                .filter((e) => !newMentionedIds.has(e.id))
                .map((e) => e.id);
              if (removedIds.length > 0) {
                await chatApi
                  .unpinCodexEntriesByIds(
                    sessionIdForPersist,
                    removedIds,
                    "chat_mention",
                  )
                  .catch(() => {});
              }
            } catch {
              // 解除失敗は無視
            }
            set({ _editingOldContent: null });
          }
        }

        const effectiveSessionId = sessionIdForPersist ?? activeSessionId;
        let pinnedCodexEntries: import("./contextBuilder").PinnedCodexContext[] =
          [];
        if (effectiveSessionId) {
          const pinned =
            await chatApi.listPinnedCodexEntries(effectiveSessionId);
          pinnedCodexEntries = pinned.map((e) => {
            const children = e.withChildren
              ? getChildrenFromArray(e.id, allEntries).map((c) => ({
                  id: c.id,
                  type: c.type,
                  name: c.name,
                  summary: c.summary ?? "",
                }))
              : undefined;
            const childrenCtx = buildChildrenCtxForEntry(
              e,
              allEntries,
              L4_TOTAL_BUDGET,
            );
            return {
              id: e.id,
              type: e.type,
              name: e.name,
              summary: e.summary ?? "",
              fullContent: extractPlainText(e.content) || undefined,
              withChildren: e.withChildren,
              children,
              ...(childrenCtx ? { childrenContext: childrenCtx } : {}),
            };
          });
        }

        // G21: include input-typed detected entries not yet pinned to DB
        {
          const dbPinnedIdSet = new Set(pinnedCodexEntries.map((e) => e.id));
          const inputIds = get().inputPinnedEntryIds;
          const extraPinned = inputIds
            .filter((id) => !dbPinnedIdSet.has(id))
            .flatMap((id) => {
              const e = allEntries.find((a) => a.id === id);
              if (!e) return [];
              const childrenCtx = buildChildrenCtxForEntry(
                e,
                allEntries,
                L4_TOTAL_BUDGET,
              );
              const ctx: import("./contextBuilder").PinnedCodexContext = {
                id: e.id,
                type: e.type,
                name: e.name,
                summary: e.summary ?? "",
                fullContent: extractPlainText(e.content) || undefined,
                withChildren: false,
                ...(childrenCtx ? { childrenContext: childrenCtx } : {}),
              };
              return [ctx];
            });
          if (extraPinned.length > 0) {
            pinnedCodexEntries = [...pinnedCodexEntries, ...extraPinned];
          }
        }

        // G15: update detectedEntries / alwaysEntries (excluding pinned)
        {
          const pinnedIdSet = new Set(pinnedCodexEntries.map((e) => e.id));
          const mentionedNotPinned = mentioned
            .filter((e) => !pinnedIdSet.has(e.id))
            .map((e) => allEntries.find((a) => a.id === e.id))
            .filter((e): e is CodexEntry => e !== undefined);
          const alwaysNotPinned = alwaysEntries.filter(
            (e) => !pinnedIdSet.has(e.id) && !mentionedIds.has(e.id),
          );
          set({
            detectedEntries: mentionedNotPinned,
            alwaysEntries: alwaysNotPinned,
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

        // G9: conversationTokens: system message を除いた会話履歴のトークン数
        const conversationTokens = messagesForApi
          .filter((m) => m.role !== "system")
          .reduce((sum, m) => sum + countTokens(m.content), 0);

        // G17: 会話要約を取得してL5に注入
        let conversationSummary: string | undefined;
        if (sessionIdForPersist) {
          try {
            const summaries = await chatApi.listSummaries(sessionIdForPersist);
            if (summaries.length > 0) {
              conversationSummary = summaries
                .map((s) => s.summary)
                .join("\n\n");
            }
          } catch {
            // 要約取得失敗は無視
          }
        }

        // G16: fetch pinned snippets and build PinnedSnippetContext[]
        let pinnedSnippets: PinnedSnippetContext[] = [];
        if (effectiveSessionId) {
          try {
            const snippetItems =
              await listPinnedSnippetEntries(effectiveSessionId);
            pinnedSnippets = snippetItems.map((s) => ({
              id: s.id,
              title: s.title,
              content: extractPlainText(s.content) || s.title,
            }));
          } catch {
            // 取得失敗は無視
          }
        }

        // G19: アクティブタブのコンテンツをL3に注入
        let activeTabContent:
          | { type: "codex" | "snippet"; title: string; content: string }
          | undefined;
        try {
          const tabState = useTabStore.getState();
          const activeTab = tabState.tabs.find(
            (t) => t.nodeId === tabState.activeTabId,
          );
          if (activeTab?.contentType === "codex") {
            const codexEntry = allEntries.find(
              (e) => e.id === activeTab.nodeId,
            );
            if (codexEntry) {
              activeTabContent = {
                type: "codex",
                title: codexEntry.name,
                content:
                  extractPlainText(codexEntry.content) ||
                  codexEntry.summary ||
                  "",
              };
            }
          } else if (activeTab?.contentType === "snippet") {
            const snippet = await getSnippet(activeTab.nodeId).catch(
              () => undefined,
            );
            if (snippet) {
              activeTabContent = {
                type: "snippet",
                title: snippet.title,
                content: extractPlainText(snippet.content) || snippet.title,
              };
            }
          }
        } catch {
          // アクティブタブ取得失敗は無視
        }

        const promptResult = buildSystemPrompt({
          scene: sceneCtx,
          project: projectCtx ?? undefined,
          storySoFar: storySoFar || undefined,
          previousScene,
          codexEntries,
          pinnedCodexEntries,
          pinnedSnippets:
            pinnedSnippets.length > 0 ? pinnedSnippets : undefined,
          activeTabContent,
          commandInstruction,
          conversationTokens,
          contextWindow,
          conversationSummary,
        });

        set({
          contextTokenCount: promptResult.totalTokens,
          contextLayers: promptResult.layers,
          lastSystemPrompt: promptResult.prompt,
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

      // Accumulate thinking text locally during streaming
      let thinkingAccumulator = "";
      const isFirstResponse =
        prevMessages.filter((m) => m.role === "assistant").length === 0;

      // Start streaming — returns a Promise<cleanup_fn>
      await new Promise<void>((resolve, reject) => {
        chatApi
          .sendChatMessageStream(apiPayload, chatThinkingParams, {
            onTextDelta: (delta) => {
              set((s) => {
                const msgs = [...s.messages];
                const idx = msgs.findIndex((m) => m.id === assistantMsg.id);
                if (idx >= 0) {
                  msgs[idx] = {
                    ...msgs[idx],
                    content: msgs[idx].content + delta,
                  };
                }
                return { messages: msgs };
              });
            },
            onThinkingDelta: (delta) => {
              thinkingAccumulator += delta;
            },
            onDone: (info) => {
              const chatDurationMs = Math.round(
                performance.now() - chatStartTime,
              );

              // Build metadata: thinking blocks + stopped flag
              const metadataObj: Record<string, unknown> = {};
              if (thinkingAccumulator) {
                metadataObj.thinking_blocks = [
                  { thinking: thinkingAccumulator },
                ];
              }
              if (info.stopReason === "stopped") {
                metadataObj.stopped = true;
              }
              const chatMetadata =
                Object.keys(metadataObj).length > 0
                  ? JSON.stringify(metadataObj)
                  : undefined;

              // Update final assistant message state
              set((s) => {
                const msgs = [...s.messages];
                const idx = msgs.findIndex((m) => m.id === assistantMsg.id);
                if (idx >= 0 && chatMetadata) {
                  msgs[idx] = { ...msgs[idx], metadata: chatMetadata };
                }
                return { messages: msgs };
              });

              // Persist to DB
              const persistToDb = async () => {
                if (!sessionIdForPersist) return;
                const finalMessages = get().messages;
                const lastMsg = finalMessages[finalMessages.length - 1];
                await chatApi.addMessage(sessionIdForPersist, "user", content, {
                  id: userMsg.id,
                });
                if (
                  lastMsg &&
                  lastMsg.role === "assistant" &&
                  lastMsg.content
                ) {
                  await chatApi.addMessage(
                    sessionIdForPersist,
                    "assistant",
                    lastMsg.content,
                    {
                      id: assistantMsg.id,
                      model: chatModel || undefined,
                      tokensIn: info.inputTokens,
                      tokensOut: info.outputTokens,
                      durationMs: chatDurationMs,
                      ...(chatMetadata ? { metadata: chatMetadata } : {}),
                    },
                  );
                }

                // セッションタイトル自動生成 (P1-2) — fire-and-forget
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
                        title = content.slice(0, 30);
                      }
                      if (sessionIdForPersist) {
                        await chatApi.updateSessionTitle(
                          sessionIdForPersist,
                          title,
                        );
                        set((state) => ({
                          sessions: state.sessions.map((s) =>
                            s.id === sessionIdForPersist ? { ...s, title } : s,
                          ),
                        }));
                      }
                    })
                    .catch((e) => {
                      debugLog.error(
                        "ChatStore",
                        "title generation",
                        errorDetail(e),
                      );
                    });
                }
              };

              persistToDb()
                .catch((e) => {
                  debugLog.error(
                    "ChatStore",
                    "persist after stream",
                    errorDetail(e),
                  );
                })
                .finally(() => {
                  _streamCleanup?.();
                  _streamCleanup = null;
                  set({ isStreaming: false });
                  resolve();
                });
            },
            onError: (message) => {
              _streamCleanup?.();
              _streamCleanup = null;
              reject(new Error(message));
            },
          })
          .then((cleanup) => {
            _streamCleanup = cleanup;
          })
          .catch(reject);
      });
    } catch (e) {
      const kind = classifyError(e);
      const msg = e instanceof Error ? e.message : String(e);

      if (kind === "auth") {
        toast.error(i18next.t("chat.invalidApiKey"), {
          action: {
            label: i18next.t("chat.openSettings"),
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
        toast.warning(i18next.t("chat.rateLimited"));
        setTimeout(() => {
          get().sendMessage(content);
        }, 10_000);
        set({ isStreaming: false });
        return;
      } else if (kind === "network") {
        toast.error(i18next.t("chat.networkError"));
      } else {
        toast.error(i18next.t("chat.sendFailed", { message: msg }));
      }

      set({ error: msg });
    } finally {
      // isStreaming is set to false inside onDone/onError callbacks
      // but guard here in case of early exit
      if (get().isStreaming) {
        set({ isStreaming: false });
      }
    }
  },

  refreshContextLayers: async () => {
    const { activeSceneId, activeProjectId, activeSessionId, isGlobalChat } =
      get();
    const effectiveSceneId = isGlobalChat ? null : activeSceneId;
    if (!effectiveSceneId) {
      // グローバルチャット: L1(project) + L4(pinned + always) のみ計算
      try {
        const [projectCtx, allEntries] = await Promise.all([
          fetchProjectContext(activeProjectId),
          listCodexEntries(),
        ]);

        const globalAlwaysEntries = allEntries.filter(
          (e) => e.contextMode === "always",
        );

        const L4_TOTAL_BUDGET = 60_000;
        let globalPinnedCodex: import("./contextBuilder").PinnedCodexContext[] =
          [];
        let globalPinnedSnippets: PinnedSnippetContext[] = [];
        if (activeSessionId) {
          const [pinned, snippetItems] = await Promise.all([
            chatApi.listPinnedCodexEntries(activeSessionId),
            listPinnedSnippetEntries(activeSessionId),
          ]);
          globalPinnedCodex = pinned.map((e) => {
            const children = e.withChildren
              ? getChildrenFromArray(e.id, allEntries).map((c) => ({
                  id: c.id,
                  type: c.type,
                  name: c.name,
                  summary: c.summary ?? "",
                }))
              : undefined;
            const childrenCtx = buildChildrenCtxForEntry(
              e,
              allEntries,
              L4_TOTAL_BUDGET,
            );
            return {
              id: e.id,
              type: e.type,
              name: e.name,
              summary: e.summary ?? "",
              fullContent: extractPlainText(e.content) || undefined,
              withChildren: e.withChildren,
              children,
              ...(childrenCtx ? { childrenContext: childrenCtx } : {}),
            };
          });
          globalPinnedSnippets = snippetItems.map((s) => ({
            id: s.id,
            title: s.title,
            content: extractPlainText(s.content) || s.title,
          }));
        }

        const globalPinnedIdSet = new Set(globalPinnedCodex.map((e) => e.id));

        // G21: include input-typed detected entries not yet pinned to DB
        const inputIds = get().inputPinnedEntryIds;
        const extraPinned = inputIds
          .filter((id) => !globalPinnedIdSet.has(id))
          .flatMap((id) => {
            const e = allEntries.find((a) => a.id === id);
            if (!e) return [];
            const childrenCtx = buildChildrenCtxForEntry(
              e,
              allEntries,
              L4_TOTAL_BUDGET,
            );
            const ctx: import("./contextBuilder").PinnedCodexContext = {
              id: e.id,
              type: e.type,
              name: e.name,
              summary: e.summary ?? "",
              fullContent: extractPlainText(e.content) || undefined,
              withChildren: false,
              ...(childrenCtx ? { childrenContext: childrenCtx } : {}),
            };
            return [ctx];
          });
        const mergedGlobalPinnedCodex = [...globalPinnedCodex, ...extraPinned];
        const mergedGlobalPinnedIdSet = new Set(
          mergedGlobalPinnedCodex.map((e) => e.id),
        );

        const alwaysNotPinned = globalAlwaysEntries.filter(
          (e) => !mergedGlobalPinnedIdSet.has(e.id),
        );
        const globalCodexEntries: CodexContext[] = alwaysNotPinned.map((e) => ({
          id: e.id,
          type: e.type,
          name: e.name,
          summary: e.summary ?? "",
        }));

        const promptResult = buildSystemPrompt({
          scene: { id: "", title: "", content: "" },
          project: projectCtx ?? undefined,
          codexEntries:
            globalCodexEntries.length > 0 ? globalCodexEntries : undefined,
          pinnedCodexEntries:
            mergedGlobalPinnedCodex.length > 0
              ? mergedGlobalPinnedCodex
              : undefined,
          pinnedSnippets:
            globalPinnedSnippets.length > 0 ? globalPinnedSnippets : undefined,
        });

        set({
          contextTokenCount: promptResult.totalTokens,
          contextLayers: promptResult.layers,
          lastSystemPrompt: promptResult.prompt,
          detectedEntries: [],
          alwaysEntries: alwaysNotPinned,
        });
      } catch {
        set({ contextTokenCount: 0, contextLayers: [] });
      }
      return;
    }
    try {
      const [sceneCtx, projectCtx] = await Promise.all([
        fetchSceneContext(effectiveSceneId),
        fetchProjectContext(activeProjectId),
      ]);
      if (!sceneCtx) return;

      const allEntries = await listCodexEntries();

      // G12: context_mode filter (same as sendMessage)
      const detectableEntries = allEntries.filter(
        (e) => e.contextMode !== "hidden" && e.contextMode !== "suppress",
      );
      const refreshAlwaysEntries = allEntries.filter(
        (e) => e.contextMode === "always",
      );

      const mentioned = await findMentionedEntriesAsync(
        sceneCtx.content,
        detectableEntries,
      );

      const mentionedIds = new Set(mentioned.map((e) => e.id));
      const alwaysNotMentioned = refreshAlwaysEntries.filter(
        (e) => !mentionedIds.has(e.id),
      );
      const rawCodexEntries = [...mentioned, ...alwaysNotMentioned];

      const L4_TOTAL_BUDGET = 60_000;
      const baseCodexEntries: CodexContext[] = rawCodexEntries.map((e) => {
        const fullEntry = allEntries.find((a) => a.id === e.id);
        if (!fullEntry)
          return { id: e.id, type: e.type, name: e.name, summary: "" };
        const summary = fullEntry.summary ?? "";
        // G13: summary空ならcontent全文をフォールバック
        const contentFallback = summary.trim()
          ? undefined
          : extractPlainText(fullEntry.content) || undefined;
        const preset = fullEntry.childrenBudget ?? "compact";
        if (preset === "none")
          return {
            id: e.id,
            type: e.type,
            name: e.name,
            summary,
            contentFallback,
          };
        const budget = computeChildrenTokenBudget(preset, L4_TOTAL_BUDGET);
        const descendants = getDescendantsBFS(fullEntry.id, allEntries);
        const childrenContext = buildChildrenContext(descendants, budget);
        return childrenContext
          ? {
              id: e.id,
              type: e.type,
              name: e.name,
              summary,
              contentFallback,
              childrenContext,
            }
          : { id: e.id, type: e.type, name: e.name, summary, contentFallback };
      });

      // G14: enrich with custom details
      const codexEntries = await enrichWithCustomDetails(
        baseCodexEntries,
        allEntries,
      );

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
          const childrenCtx = buildChildrenCtxForEntry(
            e,
            allEntries,
            L4_TOTAL_BUDGET,
          );
          return {
            id: e.id,
            type: e.type,
            name: e.name,
            summary: e.summary ?? "",
            fullContent: extractPlainText(e.content) || undefined,
            withChildren: e.withChildren,
            children,
            ...(childrenCtx ? { childrenContext: childrenCtx } : {}),
          };
        });
      }

      // G15: update detectedEntries / alwaysEntries (excluding pinned)
      {
        const pinnedIdSet = new Set(pinnedCodexEntries.map((e) => e.id));
        const mentionedNotPinned = mentioned
          .filter((e) => !pinnedIdSet.has(e.id))
          .map((e) => allEntries.find((a) => a.id === e.id))
          .filter((e): e is CodexEntry => e !== undefined);
        const alwaysNotPinned = refreshAlwaysEntries.filter(
          (e) => !pinnedIdSet.has(e.id) && !mentionedIds.has(e.id),
        );
        set({
          detectedEntries: mentionedNotPinned,
          alwaysEntries: alwaysNotPinned,
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

      // G16: fetch pinned snippets for context display
      let refreshPinnedSnippets: PinnedSnippetContext[] = [];
      if (activeSessionId) {
        try {
          const snippetItems = await listPinnedSnippetEntries(activeSessionId);
          refreshPinnedSnippets = snippetItems.map((s) => ({
            id: s.id,
            title: s.title,
            content: extractPlainText(s.content) || s.title,
          }));
        } catch {
          // 取得失敗は無視
        }
      }

      // G19: アクティブタブのコンテンツをL3に注入
      let refreshActiveTabContent:
        | { type: "codex" | "snippet"; title: string; content: string }
        | undefined;
      try {
        const tabState = useTabStore.getState();
        const activeTab = tabState.tabs.find(
          (t) => t.nodeId === tabState.activeTabId,
        );
        if (activeTab?.contentType === "codex") {
          const codexEntry = allEntries.find((e) => e.id === activeTab.nodeId);
          if (codexEntry) {
            refreshActiveTabContent = {
              type: "codex",
              title: codexEntry.name,
              content:
                extractPlainText(codexEntry.content) ||
                codexEntry.summary ||
                "",
            };
          }
        } else if (activeTab?.contentType === "snippet") {
          const snippet = await getSnippet(activeTab.nodeId).catch(
            () => undefined,
          );
          if (snippet) {
            refreshActiveTabContent = {
              type: "snippet",
              title: snippet.title,
              content: extractPlainText(snippet.content) || snippet.title,
            };
          }
        }
      } catch {
        // アクティブタブ取得失敗は無視
      }

      // G21: include input-typed detected entries not yet pinned to DB
      {
        const dbPinnedIdSet = new Set(pinnedCodexEntries.map((e) => e.id));
        const inputIds = get().inputPinnedEntryIds;
        const extraPinned = inputIds
          .filter((id) => !dbPinnedIdSet.has(id))
          .flatMap((id) => {
            const e = allEntries.find((a) => a.id === id);
            if (!e) return [];
            const childrenCtx = buildChildrenCtxForEntry(
              e,
              allEntries,
              L4_TOTAL_BUDGET,
            );
            const ctx: import("./contextBuilder").PinnedCodexContext = {
              id: e.id,
              type: e.type,
              name: e.name,
              summary: e.summary ?? "",
              fullContent: extractPlainText(e.content) || undefined,
              withChildren: false,
              ...(childrenCtx ? { childrenContext: childrenCtx } : {}),
            };
            return [ctx];
          });
        if (extraPinned.length > 0) {
          pinnedCodexEntries = [...pinnedCodexEntries, ...extraPinned];
        }
      }

      const promptResult = buildSystemPrompt({
        scene: sceneCtx,
        project: projectCtx ?? undefined,
        storySoFar: storySoFar || undefined,
        codexEntries,
        pinnedCodexEntries,
        pinnedSnippets:
          refreshPinnedSnippets.length > 0 ? refreshPinnedSnippets : undefined,
        activeTabContent: refreshActiveTabContent,
      });
      set({
        contextTokenCount: promptResult.totalTokens,
        contextLayers: promptResult.layers,
        lastSystemPrompt: promptResult.prompt,
      });
    } catch {
      // コンテキスト計算失敗は無視（送信時に再計算される）
    }
  },

  setAgentMode: (on: boolean) => set({ agentMode: on }),
  setIsGlobalChat: (on: boolean) => set({ isGlobalChat: on }),

  // --- P2-1: ストリーミング中断 ---
  stopGeneration: () => {
    void chatApi.abortChatStream().catch(() => {});
    _streamCleanup?.();
    _streamCleanup = null;
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
      toast.error(i18next.t("chat.deleteMessageFailed"));
      debugLog.error("ChatStore", "deleteMessage", errorDetail(e));
    }
  },

  // --- G17: スターのトグル ---
  starMessage: async (messageId: string, starred: boolean) => {
    try {
      await chatApi.toggleStarMessage(messageId, starred);
      set((s) => ({
        messages: s.messages.map((m) =>
          m.id === messageId ? { ...m, isStarred: starred ? 1 : 0 } : m,
        ),
      }));
    } catch (e) {
      toast.error(i18next.t("chat.starUpdateFailed"));
      debugLog.error("ChatStore", "starMessage", errorDetail(e));
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
    // G20: save old content to detect removed @mentions on re-send
    set({ messages: messages.slice(0, idx), _editingOldContent: content });
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
