import {
  isChatContextPreparationAuthorityCurrent,
  prepareChatContext,
  type ChatContextPreparationInput,
} from "./chatContextPreparation";
import { unavailablePromptPreview, type ChatState } from "./chatStoreTypes";
import {
  resolveCurrentChatTurnPolicy,
  resolveCurrentTurnWebSearchConfig,
} from "./chatTurnRouting";
import {
  estimateContextInputOverhead,
  estimateContextWindowUsage,
  resolveContextPreparationBudget,
} from "./chatTurnPayload";
import { snapshotAgentTools } from "@/features/chat/agent/toolDefinitions";
import {
  trackRecallForPromote,
  type RecallPromoteState,
} from "@/features/chat/chatRecallPromote";
import { countTokens } from "@/features/chat/contextBuilder";
import { getCurrentProjectId } from "@/application/project/currentProjectAuthority";
import { resolvedChatTurnRouteAuthorityKey } from "@/features/chat/turn/resolveTurnRoute";

let contextRefreshGeneration = 0;
let inputDraftProvider:
  | (() => {
      markdown: string;
      mentionedSceneIds: string[];
      mentionedCodexIds: string[];
      commandInstruction?: string;
    })
  | null = null;

/** Local UI authority key; source revisions are owned by the application port. */
export function contextPromptKey(
  state: Pick<
    ChatState,
    | "chatScope"
    | "scopeAnchorId"
    | "activeSceneId"
    | "activeSessionId"
    | "threadFocusOverride"
  >,
): string {
  return [
    state.chatScope,
    state.scopeAnchorId ?? "",
    state.activeSceneId,
    state.activeSessionId ?? "",
    state.threadFocusOverride?.threadId ?? "",
  ].join("\u0000");
}

type ChatStoreSet = (
  partial: Partial<ChatState> | ((state: ChatState) => Partial<ChatState>),
) => void;

export function createChatContextStoreActions(deps: {
  set: ChatStoreSet;
  get: () => ChatState;
  recallPromoteTracker: RecallPromoteState;
}): Pick<
  ChatState,
  | "buildPromptForCopy"
  | "refreshContextLayers"
  | "buildPreviewPrompt"
  | "registerInputDraftProvider"
> {
  const { set, get } = deps;
  return {
    // --- Prompt preview for copy ---

    buildPromptForCopy: async (
      userInput: string,
      options?: {
        mentionedSceneIds?: string[];
        mentionedCodexIds?: string[];
        commandInstruction?: string;
      },
    ): Promise<string> => {
      const { messages: previousMessages, agentMode, ragEnabled } = get();
      const routePolicy = resolveCurrentChatTurnPolicy({
        agentMode,
        ragEnabled,
      });
      const copyMessages = [
        ...previousMessages.filter((message) => !message.isSummarized),
        {
          id: "copy-outgoing",
          sessionId: get().activeSessionId ?? "",
          role: "user" as const,
          content: userInput,
          createdAt: new Date().toISOString(),
        },
      ];
      const parts: string[] = [];

      try {
        const prepared = await get().refreshContextLayers({
          purpose: "copy",
          conversationMessages: copyMessages,
          outgoingUserMessage: userInput,
          commandInstruction: options?.commandInstruction,
          mentionedSceneIds: options?.mentionedSceneIds,
          mentionedCodexIds: options?.mentionedCodexIds,
          agentModeOverride: routePolicy.useAgentPath,
          turnRoute: routePolicy.route ?? undefined,
          privacy: routePolicy.publicWebSearchPath ? "public-web" : "private",
          ragActiveOverride: routePolicy.ragActive,
          allowSceneRecallSeedFallback: true,
          strict: true,
        });
        if (prepared?.prompt) {
          parts.push("[system]\n" + prepared.prompt);
        }
      } catch (error) {
        console.error("[buildPromptForCopy] context fetch failed:", error);
      }

      if (!routePolicy.publicWebSearchPath) {
        for (const message of previousMessages) {
          if (message.role === "system") continue;
          parts.push("[" + message.role + "]\n" + message.content);
        }
      }
      parts.push("[user]\n" + userInput);
      return parts.join("\n\n---\n\n");
    },
    refreshContextLayers: async (opts) => {
      const refreshGeneration = ++contextRefreshGeneration;
      const state = get();
      const seed = opts?.preparationSeed;
      const activeSceneId = seed?.activeSceneId ?? state.activeSceneId;
      const activeProjectId = seed
        ? seed.activeProjectId
        : state.activeProjectId;
      const activeSessionId = state.activeSessionId;
      const chatScope = seed?.chatScope ?? state.chatScope;
      const scopeAnchorId = seed ? seed.scopeAnchorId : state.scopeAnchorId;
      const threadFocus = seed
        ? seed.threadFocus
        : state.threadFocusOverride
          ? {
              threadId: state.threadFocusOverride.threadId,
              title: state.threadFocusOverride.title,
            }
          : null;
      const inputPinnedEntryIds =
        seed?.inputPinnedEntryIds ?? state.inputPinnedEntryIds;
      const excludedAutoEntryIds =
        seed?.excludedAutoEntryIds ?? state.excludedAutoEntryIds;
      const sessionStableCodexIds =
        seed?.sessionStableCodexIds ?? state.sessionStableCodexIds;
      const sessionStableContextInitialized =
        seed?.sessionStableContextInitialized ??
        state.sessionStableContextInitialized;
      const includeBodies = seed?.includeBodies ?? state.includeBodies;
      const includeMapBoard = seed?.includeMapBoard ?? state.includeMapBoard;
      const mapBoardId = seed ? seed.mapBoardId : state.mapBoardId;
      const conversationMessages = (
        opts?.conversationMessages ?? state.messages
      ).map((message) => ({ ...message }));
      const requestedAgentMode = opts?.agentModeOverride ?? state.agentMode;
      const inferredRoutePolicy = opts?.turnRoute
        ? null
        : resolveCurrentChatTurnPolicy({
            agentMode: requestedAgentMode,
            ragEnabled: state.ragEnabled,
          });
      const route = opts?.turnRoute ?? inferredRoutePolicy?.route ?? null;
      const effectiveAgentMode =
        inferredRoutePolicy?.route != null
          ? inferredRoutePolicy.useAgentPath
          : requestedAgentMode;
      const publicWebSearchPath =
        opts?.privacy != null
          ? opts.privacy === "public-web"
          : (inferredRoutePolicy?.publicWebSearchPath ?? false);
      const effectiveSceneId = seed
        ? seed.effectiveSceneId
        : chatScope === "scene" && !threadFocus
          ? activeSceneId
          : null;
      const projectId =
        seed?.projectId ?? activeProjectId ?? getCurrentProjectId();
      const purpose = opts?.purpose ?? "live";
      const promptKey = contextPromptKey({
        chatScope,
        scopeAnchorId,
        activeSceneId,
        activeSessionId,
        threadFocusOverride: threadFocus,
      });
      const localAuthorityIsCurrent = (): boolean => {
        const current = get();
        return (
          refreshGeneration === contextRefreshGeneration &&
          (current.activeProjectId ?? getCurrentProjectId()) === projectId &&
          contextPromptKey(current) === promptKey
        );
      };
      const activeSession = activeSessionId
        ? state.sessions.find((session) => session.id === activeSessionId)
        : undefined;
      if (activeSession && activeSession.projectId !== projectId) {
        const error = new Error("chat session project mismatch");
        if (purpose === "live" || purpose === "send") {
          set({
            contextTokenCount: 0,
            contextWindowUsage: null,
            contextWindowSize: null,
            contextModel: null,
            contextProvider: null,
            contextRouteAuthorityKey: null,
            contextLayers: [],
            contextPlan: null,
            lastSystemPrompt: "",
            scopeAnchor: null,
          });
        }
        if (opts?.strict) throw error;
        return null;
      }

      const privateMessages = effectiveSceneId
        ? opts?.conversationMessages
          ? conversationMessages
          : conversationMessages.filter((message) => !message.isSummarized)
        : conversationMessages;
      const publicMessages = opts?.outgoingUserMessage
        ? [{ role: "user", content: opts.outgoingUserMessage }]
        : [];
      const usageMessages = publicWebSearchPath
        ? publicMessages
        : privateMessages.filter((message) => !message.isSummarized);
      const usageAgentTools = effectiveAgentMode
        ? requestedAgentMode
          ? (state.sessionAgentToolsSnapshot ?? snapshotAgentTools())
          : []
        : undefined;
      const usageWebSearchConfig = publicWebSearchPath
        ? resolveCurrentTurnWebSearchConfig({
            agentMode: requestedAgentMode,
            ragActive:
              opts?.ragActiveOverride ??
              inferredRoutePolicy?.ragActive ??
              false,
          })
        : null;
      const inputOverheadTokens =
        opts?.inputOverheadTokens ??
        estimateContextInputOverhead({
          route,
          messages: usageMessages,
          tools: usageAgentTools,
          webSearch: usageWebSearchConfig,
        });
      const mode =
        publicWebSearchPath || !effectiveAgentMode ? "chat" : "agent";
      const input: ChatContextPreparationInput = {
        requestId: crypto.randomUUID(),
        purpose,
        privacy: publicWebSearchPath ? "public-web" : "private",
        projectId,
        sessionId: activeSessionId,
        effectiveSceneId: publicWebSearchPath ? null : effectiveSceneId,
        activeSceneId,
        activeProjectId,
        chatScope,
        scopeAnchorId,
        threadFocus,
        mode,
        agentToolsAvailable: effectiveAgentMode,
        route,
        budget: resolveContextPreparationBudget({
          mode,
          route,
          inputOverheadTokens,
        }),
        messages: publicWebSearchPath ? [] : privateMessages,
        outgoingUserMessage: opts?.outgoingUserMessage ?? "",
        commandInstruction: opts?.commandInstruction,
        mentionedSceneIds: opts?.mentionedSceneIds ?? [],
        mentionedCodexIds: opts?.mentionedCodexIds ?? [],
        inputPinnedEntryIds,
        excludedAutoEntryIds,
        sessionStableCodexIds,
        sessionStableContextInitialized,
        includeBodies,
        includeMapBoard,
        mapBoardId,
        trackRecallPromote: opts?.trackRecallPromote ?? false,
        allowSceneRecallSeedFallback:
          opts?.allowSceneRecallSeedFallback ?? false,
      };

      try {
        const prepared = await prepareChatContext(
          input,
          opts?.preparationSnapshot,
        );
        const contextWindowUsage = estimateContextWindowUsage({
          route,
          contextTokens:
            prepared.totalTokens +
            (publicWebSearchPath
              ? publicMessages.reduce(
                  (sum, message) => sum + countTokens(message.content),
                  0,
                )
              : 0),
          messages: usageMessages,
          tools: usageAgentTools,
          webSearch: usageWebSearchConfig,
          estimated: purpose === "live",
        });
        const result = { ...prepared, contextWindowUsage };
        const applicationAuthorityIsCurrent =
          isChatContextPreparationAuthorityCurrent(prepared.authority);
        const mayPublish =
          (purpose === "live" || purpose === "send") &&
          localAuthorityIsCurrent() &&
          applicationAuthorityIsCurrent;

        if (
          purpose === "send" &&
          input.trackRecallPromote &&
          (opts?.isAuthorized?.() ?? true) &&
          prepared.recalledMessages.length > 0
        ) {
          const suggestion = trackRecallForPromote(
            deps.recallPromoteTracker,
            prepared.recalledMessages,
          );
          if (suggestion) {
            set({ chatRecallPromoteSuggestion: suggestion });
          }
        }

        if (mayPublish) {
          const initializeStableContext =
            purpose === "send" &&
            prepared.privacy === "private" &&
            !get().sessionStableContextInitialized;
          set({
            contextTokenCount: prepared.totalTokens,
            contextWindowUsage,
            contextWindowSize: route?.contextWindow ?? null,
            contextModel: route?.model ?? null,
            contextProvider: route?.provider ?? null,
            contextRouteAuthorityKey: resolvedChatTurnRouteAuthorityKey(route),
            contextLayers: prepared.layers,
            contextPlan: prepared.contextPlan,
            lastSystemPrompt: prepared.prompt,
            detectedEntries: prepared.detectedEntries,
            alwaysEntries: prepared.alwaysEntries,
            scopeAnchor: prepared.scopeAnchor,
            projectOutline: prepared.projectOutline,
            chapterOutlines: prepared.chapterOutlines,
            ...(effectiveSceneId ? { pinsVersion: get().pinsVersion + 1 } : {}),
            ...(initializeStableContext
              ? {
                  sessionStableCodexIds: prepared.stableContextIds,
                  sessionStableContextInitialized: true,
                }
              : {}),
          });
        }
        return result;
      } catch (error) {
        if (
          (purpose === "live" || purpose === "send") &&
          localAuthorityIsCurrent()
        ) {
          set({
            contextTokenCount: 0,
            contextWindowUsage: null,
            contextWindowSize: null,
            contextModel: null,
            contextProvider: null,
            contextRouteAuthorityKey: null,
            contextLayers: [],
            contextPlan: null,
            lastSystemPrompt: "",
            scopeAnchor: null,
            projectOutline: undefined,
            chapterOutlines: [],
            ...(publicWebSearchPath
              ? { detectedEntries: [], alwaysEntries: [] }
              : {}),
          });
        }
        if (opts?.strict) throw error;
        return null;
      }
    },
    buildPreviewPrompt: async () => {
      const { agentMode, ragEnabled } = get();
      let draft: {
        markdown: string;
        mentionedSceneIds: string[];
        mentionedCodexIds: string[];
        commandInstruction?: string;
      } = {
        markdown: "",
        mentionedSceneIds: [],
        mentionedCodexIds: [],
        commandInstruction: undefined,
      };
      try {
        draft = inputDraftProvider?.() ?? draft;
      } catch {
        // The composer may be tearing down; an empty immutable draft is valid.
      }

      const routePolicy = resolveCurrentChatTurnPolicy({
        agentMode,
        ragEnabled,
      });
      const previewMessages = [
        ...get().messages.filter((message) => !message.isSummarized),
        ...(draft.markdown
          ? [
              {
                id: "preview-outgoing",
                sessionId: get().activeSessionId ?? "",
                role: "user" as const,
                content: draft.markdown,
                createdAt: new Date().toISOString(),
              },
            ]
          : []),
      ];
      try {
        const prepared = await get().refreshContextLayers({
          purpose: "preview",
          conversationMessages: previewMessages,
          outgoingUserMessage: draft.markdown,
          commandInstruction: draft.commandInstruction,
          mentionedSceneIds: draft.mentionedSceneIds,
          mentionedCodexIds: draft.mentionedCodexIds,
          agentModeOverride: routePolicy.useAgentPath,
          turnRoute: routePolicy.route ?? undefined,
          privacy: routePolicy.publicWebSearchPath ? "public-web" : "private",
          ragActiveOverride: routePolicy.ragActive,
          allowSceneRecallSeedFallback: true,
          strict: true,
        });
        if (!prepared) return unavailablePromptPreview(draft.markdown);
        return {
          status: "ready",
          prompt: prepared.prompt,
          layers: prepared.layers,
          totalTokens: prepared.totalTokens,
          contextWindowUsage: prepared.contextWindowUsage,
          userMessage: draft.markdown,
        };
      } catch {
        return unavailablePromptPreview(draft.markdown);
      }
    },
    registerInputDraftProvider: (provider) => {
      inputDraftProvider = provider;
    },
  };
}
