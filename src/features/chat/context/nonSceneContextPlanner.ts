import { createContextPlan } from "@/features/ai-context/types";
import {
  countTokens,
  type BuildSystemPromptInput,
  type LayerBreakdown,
} from "../contextBuilder";
import type { LegacyPromptResult } from "./legacyPromptAdapter";
import {
  collectNonSceneContext,
  type NonSceneContextCollection,
  type NonSceneContextSourceDeps,
  type NonSceneScopeAnchor,
} from "./sources/nonSceneContextSource";
import type { NonSceneTurnContextRequest } from "./turnContextRequest";
import {
  fullyInjectedCodexIdsFromPlan,
  type ChatContextItemKind,
  type ChatContextPayload,
  type ChatContextPlan,
} from "./types";
import { ContextPlanningError } from "./chatContextPlanner";

export interface NonSceneContextPlannerDeps {
  ensureTokenizer: () => Promise<void>;
  collectContext: (
    request: NonSceneTurnContextRequest,
    deps: NonSceneContextSourceDeps,
  ) => Promise<NonSceneContextCollection>;
  source: NonSceneContextSourceDeps;
  renderPrompt: (input: BuildSystemPromptInput) => LegacyPromptResult;
}

export interface NonSceneContextPlanResult {
  prompt: string;
  totalTokens: number;
  layers: LayerBreakdown[];
  cacheSegments?: string[];
  volatileTail?: string;
  contextPlan: ChatContextPlan;
  detectedEntries: NonSceneContextCollection["detectedEntries"];
  alwaysEntries: NonSceneContextCollection["alwaysEntries"];
  fullyInjectedIds: string[];
  stableContextIds: string[];
  scopeAnchor: NonSceneScopeAnchor | null;
  projectOutline: string | undefined;
  chapterOutlines: Array<{ title: string; outline: string }>;
}

function emptyContextPlan(requestId: string): ChatContextPlan {
  return createContextPlan<ChatContextPayload, ChatContextItemKind>({
    requestId,
    items: [],
    decisions: [],
    usage: {
      candidateTokens: 0,
      selectedTokens: 0,
      trimmedTokens: 0,
      budgetTokens: null,
    },
  });
}

/** Plan and render a folder/project/codex/snippet/thread context turn. */
export async function planNonSceneChatContext(
  request: NonSceneTurnContextRequest,
  deps: NonSceneContextPlannerDeps,
): Promise<NonSceneContextPlanResult> {
  try {
    await deps.ensureTokenizer();
  } catch (cause) {
    throw new ContextPlanningError([
      {
        source: "tokenizer",
        severity: "fatal",
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      },
    ]);
  }

  let collected: NonSceneContextCollection;
  try {
    collected = await deps.collectContext(request, deps.source);
  } catch (cause) {
    throw new ContextPlanningError([
      {
        source: "non-scene-context",
        severity: "fatal",
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      },
    ]);
  }

  const conversationTokens = request.messages
    .filter((message) => message.role !== "system" && !message.isSummarized)
    .reduce((sum, message) => sum + countTokens(message.content), 0);
  const rendered = deps.renderPrompt({
    ...collected.promptInput,
    contextRequestId: request.requestId,
    commandInstruction: request.commandInstruction,
    agentMode: request.mode === "agent",
    customChatInstruction: request.settings.customChatInstruction,
    contextWindow: request.budget.contextWindow,
    maxOutputTokens: request.budget.maxOutputTokens,
    outputReservationTokens: request.budget.responseReservationTokens,
    inputOverheadTokens: request.budget.inputOverheadTokens,
    deliveryMode: request.budget.deliveryMode,
    conversationTokens,
  });
  const contextPlan =
    rendered.contextPlan ?? emptyContextPlan(request.requestId);

  return {
    prompt: rendered.prompt,
    totalTokens: rendered.totalTokens,
    layers: rendered.layers,
    cacheSegments: rendered.cacheSegments,
    volatileTail: rendered.volatileTail,
    contextPlan,
    detectedEntries: collected.detectedEntries,
    alwaysEntries: collected.alwaysEntries,
    fullyInjectedIds: fullyInjectedCodexIdsFromPlan(contextPlan),
    stableContextIds: contextPlan.items
      .filter((item) => item.stability === "session-stable")
      .map((item) => item.provenance.sourceId),
    scopeAnchor: collected.scopeAnchor,
    projectOutline: collected.projectOutline,
    chapterOutlines: collected.chapterOutlines,
  };
}

export function createNonSceneContextPlannerDeps(input: {
  source: NonSceneContextSourceDeps;
  ensureTokenizer: () => Promise<void>;
  renderPrompt: NonSceneContextPlannerDeps["renderPrompt"];
}): NonSceneContextPlannerDeps {
  return {
    collectContext: collectNonSceneContext,
    ...input,
  };
}
