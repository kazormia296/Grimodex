import type { LayerBreakdown } from "../contextBuilder";
import type { CodexContextEntry } from "@/features/codex/api";
import {
  createContextPlan,
  type ContextDecision,
} from "@/features/ai-context/types";
import type {
  ContextDiagnostic,
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

export type { ContextDiagnostic } from "./contextPlannerDeps";

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

type ContextDiagnosticInput = Omit<ContextDiagnostic, "code"> & {
  code?: string;
};

export class ContextPlanningError extends Error {
  readonly diagnostics: ContextDiagnostic[];

  constructor(diagnostics: ContextDiagnosticInput[]) {
    const normalized = diagnostics.map((diagnostic) => ({
      ...diagnostic,
      code: diagnostic.code ?? "CONTEXT_PLANNING_FAILED",
    }));
    super(normalized.map((diagnostic) => diagnostic.message).join("; "));
    this.name = "ContextPlanningError";
    this.diagnostics = normalized;
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

function compareStableText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function diagnosticUnavailableDecisions(
  diagnostics: readonly ContextDiagnostic[],
): ContextDecision[] {
  const uniqueBySourceAndCode = new Map<string, ContextDiagnostic>();
  for (const diagnostic of diagnostics) {
    const identity = `${diagnostic.source}\u0000${diagnostic.code}`;
    if (!uniqueBySourceAndCode.has(identity)) {
      uniqueBySourceAndCode.set(identity, diagnostic);
    }
  }

  return [...uniqueBySourceAndCode.values()]
    .sort(
      (left, right) =>
        compareStableText(left.source, right.source) ||
        compareStableText(left.code, right.code),
    )
    .map((diagnostic) => ({
      key: `source:${diagnostic.source}:${diagnostic.code}`,
      status: "unavailable",
      reason: diagnostic.code.toLowerCase().replaceAll("_", "-"),
      tokensBefore: 0,
      tokensAfter: 0,
    }));
}

export function attachDiagnosticDecisions(
  contextPlan: ChatContextPlan,
  diagnostics: readonly ContextDiagnostic[],
): ChatContextPlan {
  const existingKeys = new Set(
    contextPlan.decisions.map((decision) => decision.key),
  );
  const diagnosticDecisions = diagnosticUnavailableDecisions(
    diagnostics,
  ).filter((decision) => !existingKeys.has(decision.key));
  if (diagnosticDecisions.length === 0) return contextPlan;

  return createContextPlan<ChatContextPayload, ChatContextItemKind>({
    requestId: contextPlan.requestId,
    items: contextPlan.items,
    decisions: [...contextPlan.decisions, ...diagnosticDecisions],
    usage: contextPlan.usage,
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
        code: "TOKENIZER_UNAVAILABLE",
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
        code: "REQUIRED_SCENE_CONTEXT_UNAVAILABLE",
        message: messageOf(cause),
        cause,
      },
    ]);
  }

  const diagnostics: ContextDiagnostic[] = [...required.diagnostics];
  let optional = {};
  try {
    optional = await deps.collectOptionalSceneContext(request, required);
  } catch (cause) {
    diagnostics.push({
      source: "optional-scene-context",
      severity: "warning",
      code: "OPTIONAL_SCENE_CONTEXT_UNAVAILABLE",
      message: "Optional scene context is unavailable; continuing without it.",
      cause,
    });
  }

  const rendered = deps.renderPrompt({
    ...required.promptInput,
    ...optional,
    // A live refresh only feeds the ContextBar display cache. Provider-bound
    // surfaces rebuild from their immutable request and keep exact BPE counts.
    tokenCountingMode: request.purpose === "live" ? "live-estimate" : "exact",
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
  const contextPlan = attachDiagnosticDecisions(
    rendered.contextPlan ?? emptyContextPlan(request.requestId),
    diagnostics,
  );

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
