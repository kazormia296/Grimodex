import type { AiProvider } from "@/features/chat/types";

const DEFAULT_VISIBLE_OUTPUT_TOKENS = 4_096;
const REASONING_OUTPUT_TOKENS = 32_000;
const MINIMUM_INPUT_HEADROOM_TOKENS = 1_024;

interface ThinkingLike {
  thinking?: {
    type?: string;
    budget_tokens?: number;
    /** Accepted for normalized callers outside the current chat ThinkingParams. */
    budgetTokens?: number;
  } | null;
  reasoningEnabled?: boolean;
}

export interface ResolveOutputBudgetPlanInput {
  provider: AiProvider;
  model: string;
  apiVariant?: string | null;
  contextWindow: number;
  modelMaxOutputTokens?: number;
  thinking?: ThinkingLike;
}

export interface OutputBudgetPlan {
  /** Value forwarded to Rust. Null only for CLI, whose wire has no max flag. */
  requestMaxOutputTokens: number | null;
  /** Tokens removed from the context window before input selection. */
  responseReservationTokens: number;
  /** False only when a transport has no enforceable output limit (currently CLI). */
  exactOnWire: boolean;
}

function requirePositiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}

function modelBasename(model: string): string {
  return model.split("/").at(-1) ?? model;
}

function isReasoningModelName(model: string): boolean {
  const name = modelBasename(model);
  if (name.startsWith("gpt-5-chat")) return false;
  return (
    name.startsWith("gpt-5") ||
    name.startsWith("o1") ||
    name.startsWith("o3") ||
    name.startsWith("o4") ||
    name.startsWith("deepseek-r1")
  );
}

function supportsReasoningNone(model: string): boolean {
  const name = modelBasename(model).replaceAll(".", "-");
  if (name.startsWith("gpt-5-pro") || name.startsWith("gpt-5-chat")) {
    return false;
  }
  const match = name.match(/^gpt-5-(\d+)/);
  return match ? Number(match[1]) >= 1 : false;
}

function usesResponsesApi(input: ResolveOutputBudgetPlanInput): boolean {
  return (
    input.apiVariant === "responses" &&
    ["openai", "openai-compatible", "openrouter", "sakana"].includes(
      input.provider,
    )
  );
}

function aiNovelistFallback(model: string): number {
  if (model === "spiko_ultra") return 32_768;
  if (["derrida_03", "spiko", "spiko_solid", "spiko_max"].includes(model)) {
    return 4_096;
  }
  return 400;
}

function manualThinkingBudget(thinking?: ThinkingLike): number | null {
  if (thinking?.thinking?.type !== "enabled") return null;
  const value =
    thinking.thinking.budget_tokens ?? thinking.thinking.budgetTokens ?? null;
  if (value === null) return null;
  requirePositiveSafeInteger(value, "thinking budget");
  return value;
}

/**
 * Resolve the single output limit used both by context reservation and the
 * provider request body. Rust receives this value and only chooses the field
 * name (`max_tokens`, `max_completion_tokens`, or `max_output_tokens`).
 */
export function resolveOutputBudgetPlan(
  input: ResolveOutputBudgetPlanInput,
): OutputBudgetPlan {
  requirePositiveSafeInteger(input.contextWindow, "contextWindow");
  if (input.modelMaxOutputTokens !== undefined) {
    requirePositiveSafeInteger(
      input.modelMaxOutputTokens,
      "modelMaxOutputTokens",
    );
  }

  if (input.provider === "cli") {
    const policyReservation = Math.max(
      DEFAULT_VISIBLE_OUTPUT_TOKENS,
      Math.round(input.contextWindow * 0.05),
    );
    return {
      requestMaxOutputTokens: null,
      responseReservationTokens: policyReservation,
      exactOnWire: false,
    };
  }

  let requestMaxOutputTokens: number;
  if (input.provider === "ai-novelist") {
    requestMaxOutputTokens =
      input.modelMaxOutputTokens ?? aiNovelistFallback(input.model);
  } else if (input.provider === "anthropic") {
    const thinkingBudget = manualThinkingBudget(input.thinking);
    requestMaxOutputTokens = thinkingBudget
      ? thinkingBudget + DEFAULT_VISIBLE_OUTPUT_TOKENS
      : DEFAULT_VISIBLE_OUTPUT_TOKENS;
  } else if (usesResponsesApi(input)) {
    const reasoningActive =
      input.thinking?.reasoningEnabled === true ||
      (input.thinking?.reasoningEnabled === false &&
        supportsReasoningNone(input.model)) ||
      (input.provider === "openrouter" && isReasoningModelName(input.model));
    requestMaxOutputTokens =
      input.provider === "openai" ||
      input.provider === "sakana" ||
      reasoningActive
        ? REASONING_OUTPUT_TOKENS
        : DEFAULT_VISIBLE_OUTPUT_TOKENS;
  } else {
    requestMaxOutputTokens =
      input.provider === "openai" ||
      input.provider === "sakana" ||
      isReasoningModelName(input.model)
        ? REASONING_OUTPUT_TOKENS
        : DEFAULT_VISIBLE_OUTPUT_TOKENS;
  }

  requirePositiveSafeInteger(requestMaxOutputTokens, "requestMaxOutputTokens");
  // Never put an impossible max-output value on a small/custom context window.
  // The same clamped value is sent on wire and reserved locally.
  requestMaxOutputTokens = Math.min(
    requestMaxOutputTokens,
    input.modelMaxOutputTokens ?? Number.POSITIVE_INFINITY,
    Math.max(1, input.contextWindow - MINIMUM_INPUT_HEADROOM_TOKENS),
  );
  return {
    requestMaxOutputTokens,
    responseReservationTokens: requestMaxOutputTokens,
    exactOnWire: true,
  };
}
