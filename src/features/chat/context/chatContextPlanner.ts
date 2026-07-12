import type { LayerBreakdown } from "../contextBuilder";
import type { CodexContextEntry } from "@/features/codex/api";
import { createContextPlan } from "@/features/ai-context/types";
import type {
  ContextPlannerDeps,
  RecalledMessageForPromotion,
} from "./contextPlannerDeps";
import type { SceneTurnContextRequest } from "./turnContextRequest";
import {
  fullyInjectedCodexIdsFromPlan,
  type ChatContextItemKind,
  type ChatContextPayload,
  type ChatContextPlan,
} from "./types";

export interface ContextDiagnostic {
  source: string;
  severity: "warning" | "fatal";
  message: string;
  cause?: unknown;
}

export interface ChatContextPlanResult {
  prompt: string;
  totalTokens: number;
  layers: LayerBreakdown[];
  cacheSegments?: string[];
  volatileTail?: string;
  contextPlan: ChatContextPlan;
  detectedEntries: CodexContextEntry[];
  alwaysEntries: CodexContextEntry[];
  fullyInjectedIds: string[];
  stableCodexIds: string[];
  projectOutline: string | undefined;
  chapterOutlines: Array<{ title: string; outline: string }>;
  recalledMessages: RecalledMessageForPromotion[];
  diagnostics: ContextDiagnostic[];
}

export class ContextPlanningError extends Error {
  readonly diagnostics: ContextDiagnostic[];

  constructor(diagnostics: ContextDiagnostic[]) {
    super(diagnostics.map((diagnostic) => diagnostic.message).join("; "));
    this.name = "ContextPlanningError";
    this.diagnostics = diagnostics;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

/**
 * Scene-context application service. It depends only on the immutable request
 * and injected source adapters; Zustand and project-global lookups stay in the
 * production composition root.
 */
export async function planChatContext(
  request: SceneTurnContextRequest,
  deps: ContextPlannerDeps,
): Promise<ChatContextPlanResult> {
  try {
    await deps.ensureTokenizer();
  } catch (cause) {
    throw new ContextPlanningError([
      {
        source: "tokenizer",
        severity: "fatal",
        message: messageOf(cause),
        cause,
      },
    ]);
  }

  let required;
  try {
    required = await deps.collectRequiredSceneContext(request);
  } catch (cause) {
    throw new ContextPlanningError([
      {
        source: "scene",
        severity: "fatal",
        message: messageOf(cause),
        cause,
      },
    ]);
  }

  const diagnostics: ContextDiagnostic[] = [];
  let optional = {};
  try {
    optional = await deps.collectOptionalSceneContext(request, required);
  } catch (cause) {
    diagnostics.push({
      source: "optional-scene-context",
      severity: "warning",
      message: messageOf(cause),
      cause,
    });
  }

  const rendered = deps.renderPrompt({
    ...required.promptInput,
    ...optional,
    contextRequestId: request.requestId,
    commandInstruction: request.commandInstruction,
    agentMode: request.mode === "agent",
    customChatInstruction: request.settings.customChatInstruction,
    contextWindow: request.budget.contextWindow,
    maxOutputTokens: request.budget.maxOutputTokens,
    outputReservationTokens: request.budget.responseReservationTokens,
    inputOverheadTokens: request.budget.inputOverheadTokens,
    deliveryMode: request.budget.deliveryMode,
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
    detectedEntries: required.detectedEntries,
    alwaysEntries: required.alwaysEntries,
    fullyInjectedIds: fullyInjectedCodexIdsFromPlan(contextPlan),
    stableCodexIds: required.stableCodexIds,
    projectOutline: required.projectOutline,
    chapterOutlines: required.chapterOutlines,
    recalledMessages: required.recalledMessages,
    diagnostics,
  };
}
