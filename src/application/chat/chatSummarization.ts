import { finalizeChatTurnPayload } from "./chatTurnPayload";
import { getChatApiVariant } from "./chatTurnRouting";
import type { ChatState } from "./chatStoreTypes";
import * as chatApi from "@/features/chat/chatApi";
import { computeL5UsedTokens } from "@/features/chat/conversationHistory";
import { ensureTokenizer } from "@/features/chat/contextBuilder";
import { resolveRolePathConfig } from "@/features/chat/modelRouting";
import { useAiSettingsStore } from "@/features/chat/store";
import {
  estimateSummaryTokenCount,
  getPreviousSummaryText,
  runSummarization,
  selectSummarizationCandidates,
  shouldSummarize,
} from "@/features/chat/summarization";
import type { ChatMessage } from "@/features/chat/chatTypes";
import { resolveChatTurnRoute } from "@/features/chat/turn/resolveTurnRoute";
import { debugLog, errorDetail } from "@/lib/debugLog";

export async function maybeRunSummarization(
  sessionId: string,
  projectId: string,
  operationId: string,
  messages: ChatMessage[],
  l5Budget: number,
  lang: string,
  set: (
    partial: Partial<ChatState> | ((state: ChatState) => Partial<ChatState>),
  ) => void,
  isAuthorized: () => boolean,
): Promise<ChatMessage[]> {
  await ensureTokenizer();
  if (!isAuthorized()) return messages;
  let summaries: Awaited<ReturnType<typeof chatApi.listSummaries>> = [];
  try {
    summaries = await chatApi.listSummaries(sessionId);
  } catch {
    return messages;
  }
  if (!isAuthorized()) return messages;

  const summaryTexts = summaries.map((s) => s.summary);
  const l5Used = computeL5UsedTokens(messages, summaryTexts, l5Budget);
  const maxGen =
    summaries.length > 0 ? Math.max(...summaries.map((s) => s.generation)) : 0;

  if (isAuthorized()) {
    set({
      summaryCount: summaries.length,
      maxSummaryGeneration: maxGen,
    });
  }

  if (!shouldSummarize(messages, l5Budget, l5Used)) {
    return messages;
  }

  const candidates = selectSummarizationCandidates(messages, l5Budget);
  if (candidates.length === 0) return messages;

  try {
    const generation = await chatApi.getSummaryGeneration(sessionId);
    if (!isAuthorized()) return messages;
    const previousSummary = getPreviousSummaryText(summaries);
    const candidateIds = candidates.map((m) => m.id);
    const lastMsgId = candidateIds[candidateIds.length - 1]!;

    const summaryText = await runSummarization(
      candidates,
      // cheap ロール: 要約は injected callback 経由で model/provider/endpoint override を渡す。
      (messages, thinkingParams) => {
        if (!isAuthorized()) {
          return Promise.reject(new Error("chat turn authority changed"));
        }
        const aiState = useAiSettingsStore.getState();
        const role = resolveRolePathConfig(
          "summarization",
          undefined,
          aiState.settings?.provider,
        );
        const route = aiState.settings
          ? resolveChatTurnRoute({
              surface: "chat",
              activeSettings: aiState.settings,
              activeApiVariant: getChatApiVariant(aiState.settings.model),
              role: role
                ? {
                    model: role.model,
                    provider: role.provider,
                    apiVariant: role.provider
                      ? role.variant
                      : getChatApiVariant(role.model),
                    endpointId: role.endpointId,
                  }
                : null,
              taskEffort: "low",
              thinkingDisplay: "summarized",
              thinkingEnabled: aiState.settings.thinkingEnabled,
              reasoningEffortOverride:
                aiState.settings.reasoningEffortOverride ?? undefined,
            })
          : null;
        if (route) {
          finalizeChatTurnPayload({
            route,
            fallbackSystemPrompt: "",
            messages,
          });
        }
        return chatApi.sendChatMessageWithThinking(
          messages,
          {
            projectId,
            pathId: "summarization",
            operationId,
          },
          route?.thinking ?? thinkingParams,
          undefined,
          route?.apiVariant ?? null,
          undefined,
          route?.model ?? role?.model ?? null,
          route ? route.providerOverride : (role?.provider ?? null),
          route ? route.endpointId : (role?.endpointId ?? null),
          route?.outputBudget.requestMaxOutputTokens ?? null,
          route?.provider ?? null,
          route?.resolvedEndpointId ?? null,
          route?.resolvedOllamaEndpoint ?? null,
        );
      },
      {
        lang,
        previousSummary,
        generation,
        sourceMsgCount: candidates.length,
        lastMsgId,
      },
    );
    if (!isAuthorized()) return messages;

    const tokenCount = estimateSummaryTokenCount(summaryText);
    if (!isAuthorized()) return messages;
    const chatSummary = await chatApi.addSummary(
      sessionId,
      summaryText,
      candidateIds,
      {
        tokenCount,
        generation,
        sourceMsgCount: candidates.length,
        lastMsgId,
      },
    );
    if (!isAuthorized()) return messages;
    await chatApi.markMessagesSummarized(candidateIds);
    if (!isAuthorized()) return messages;

    let resultMessages = messages;
    set((s) => {
      if (!isAuthorized()) return {};
      const updatedMessages = s.messages.map((m) =>
        candidateIds.includes(m.id) ? { ...m, isSummarized: 1 } : m,
      );
      const summaryMarkerMsg: ChatMessage = {
        id: `summary-${chatSummary.id}`,
        sessionId,
        role: "assistant",
        content: summaryText,
        metadata: JSON.stringify({ summary_id: chatSummary.id }),
        createdAt: chatSummary.createdAt,
        isSummarized: 0,
      };
      const lastCandidateIdx = updatedMessages.reduce(
        (acc, m, idx) => (candidateIds.includes(m.id) ? idx : acc),
        -1,
      );
      resultMessages = [
        ...updatedMessages.slice(0, lastCandidateIdx + 1),
        summaryMarkerMsg,
        ...updatedMessages.slice(lastCandidateIdx + 1),
      ];
      return {
        messages: resultMessages,
        summaryCount: summaries.length + 1,
        maxSummaryGeneration: generation,
      };
    });

    return resultMessages;
  } catch (e) {
    debugLog.error("ChatStore", "summarization", errorDetail(e));
    return messages;
  }
}
