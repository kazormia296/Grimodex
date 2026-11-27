import type { AiProvider } from "@/features/chat/types";

const DEFAULT_VISIBLE_OUTPUT_TOKENS = 4_096;
const DEFAULT_REASONING_RESERVATION_TOKENS = 32_000;
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
  /** Model capability default for user-visible response tokens. */
  defaultVisibleOutputTokens?: number;
  /** Model capability reservation when hidden reasoning shares the output cap. */
  defaultReasoningReservationTokens?: number;
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

/**
 * thinking が既定で常に働く Anthropic の世代（Fable／Mythos の全版、Opus／Sonnet／Haiku の
 * 5 以降）。thinking の切替が off でも考えるので、request に thinking が無くても上限を
 * 広げる。Rust の `anthropic_model_thinking_always_on` と同じ規則にする。
 */
export function anthropicThinkingAlwaysOn(model: string): boolean {
  return /^claude-(?:fable-|mythos-|(?:opus|sonnet|haiku)-(?:[5-9]|\d\d))/.test(
    modelBasename(model),
  );
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
  for (const key of [
    "modelMaxOutputTokens",
    "defaultVisibleOutputTokens",
    "defaultReasoningReservationTokens",
  ] as const) {
    const value = input[key];
    if (value !== undefined) requirePositiveSafeInteger(value, key);
  }

  const visibleOutputTokens =
    input.defaultVisibleOutputTokens ?? DEFAULT_VISIBLE_OUTPUT_TOKENS;
  const reasoningReservationTokens =
    input.defaultReasoningReservationTokens ??
    DEFAULT_REASONING_RESERVATION_TOKENS;

  if (input.provider === "cli") {
    const policyReservation = Math.max(
      visibleOutputTokens,
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
    // thinking の token も max_tokens に数える。adaptive を送るときと、常に考える世代は
    // 4,096 では thinking だけで打ち切られる。
    requestMaxOutputTokens = thinkingBudget
      ? thinkingBudget + visibleOutputTokens
      : input.thinking?.thinking?.type === "adaptive" ||
          anthropicThinkingAlwaysOn(input.model)
        ? reasoningReservationTokens
        : visibleOutputTokens;
  } else if (usesResponsesApi(input)) {
    const reasoningActive =
      input.thinking?.reasoningEnabled === true ||
      (input.thinking?.reasoningEnabled === false &&
        supportsReasoningNone(input.model)) ||
      isReasoningModelName(input.model);
    requestMaxOutputTokens = reasoningActive
      ? reasoningReservationTokens
      : visibleOutputTokens;
  } else {
    requestMaxOutputTokens = isReasoningModelName(input.model)
      ? reasoningReservationTokens
      : visibleOutputTokens;
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
