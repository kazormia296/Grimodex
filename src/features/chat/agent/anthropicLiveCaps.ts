/**
 * Anthropic `GET /v1/models` の model object から「live の能力」を取り出す純粋関数。
 *
 * 段 1（観測）専用：まだ製品の能力解決（modelLimits.ts）からは呼ばない。
 * 設計は docs/plans/model-capability-discovery.md の §3、§4、§7。
 *
 * 守ること：
 * - 「返さない」と「非対応」を区別する。応答に field が無ければ `undefined`、
 *   `supported: false` が明示されていれば `false`（または空配列）。
 * - thinking は boolean にせず `{ supported, types[], effortLevels[], canDisable }` で持つ。
 *   request の形は provider の adapter（Rust の apply_thinking_to_body）が決める。
 * - 入力は信頼しない（unknown）。型の合わない値は「返さない」と同じく `undefined`。
 */

/** Anthropic の thinking の方式（`capabilities.thinking.types` のキー）。 */
export type AnthropicThinkingType =
  | "enabled"
  | "adaptive"
  | "disabled"
  | "between_tools";

/** Anthropic の effort の段階（`capabilities.effort` のキー）。xhigh は製品の EffortLevel に無い。 */
export type AnthropicEffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

export interface LiveThinkingCaps {
  /** `capabilities.thinking.supported`。thinking の object が無ければ呼び出し側で undefined。 */
  supported: boolean | undefined;
  /**
   * `supported: true` の方式だけ（応答の順）。`types` が応答に無ければ undefined。
   * `types` があって方式が 1 つも supported でなければ空配列。
   */
  types: AnthropicThinkingType[] | undefined;
  /**
   * `capabilities.effort` の `supported: true` の段階（low→max の順）。
   * `effort` が応答に無ければ undefined、`effort.supported: false` なら空配列。
   */
  effortLevels: AnthropicEffortLevel[] | undefined;
  /**
   * thinking を明示的に無効化できるか（`types.disabled.supported`）。
   * `types` が応答に無ければ undefined。`types` があって `disabled` が無いか false なら false。
   */
  canDisable: boolean | undefined;
}

export interface AnthropicLiveCaps {
  id: string;
  displayName: string | undefined;
  /** `max_input_tokens`。 */
  contextWindow: number | undefined;
  /** `max_tokens`（最大出力）。 */
  maxOutput: number | undefined;
  /** thinking／effort をまとめたもの。`capabilities.thinking` も `capabilities.effort` も無ければ undefined。 */
  thinking: LiveThinkingCaps | undefined;
  imageInput: boolean | undefined;
  pdfInput: boolean | undefined;
  structuredOutputs: boolean | undefined;
  /** `lifecycle`（"active"／"deprecated" など）。 */
  lifecycle: string | undefined;
  /** `retires_at`（null は「予定なし」として undefined にする）。 */
  retiresAt: string | undefined;
}

const THINKING_TYPE_ORDER: readonly AnthropicThinkingType[] = [
  "enabled",
  "adaptive",
  "disabled",
  "between_tools",
];

const EFFORT_LEVEL_ORDER: readonly AnthropicEffortLevel[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveSafeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** `{ supported: boolean }` の形から supported を取る。形が違えば undefined。 */
function supportedOf(value: unknown): boolean | undefined {
  return isRecord(value) && typeof value.supported === "boolean"
    ? value.supported
    : undefined;
}

function parseThinking(
  capabilities: Record<string, unknown>,
): LiveThinkingCaps | undefined {
  const thinking = isRecord(capabilities.thinking)
    ? capabilities.thinking
    : undefined;
  const effort = isRecord(capabilities.effort)
    ? capabilities.effort
    : undefined;
  if (!thinking && !effort) return undefined;

  const typesRaw =
    thinking && isRecord(thinking.types) ? thinking.types : undefined;
  const types = typesRaw
    ? THINKING_TYPE_ORDER.filter((t) => supportedOf(typesRaw[t]) === true)
    : undefined;

  let effortLevels: AnthropicEffortLevel[] | undefined;
  if (effort) {
    const effortSupported = supportedOf(effort);
    if (effortSupported === false) {
      effortLevels = [];
    } else if (effortSupported === true) {
      effortLevels = EFFORT_LEVEL_ORDER.filter(
        (level) => supportedOf(effort[level]) === true,
      );
    }
  }

  return {
    supported: supportedOf(thinking),
    types,
    effortLevels,
    canDisable: typesRaw ? supportedOf(typesRaw.disabled) === true : undefined,
  };
}

/**
 * Anthropic の model object を live の能力へ変換する。`id` が無い object は undefined。
 * 副作用なし。製品の `ModelCapabilities` には変換しない（それは段 2 の merge の仕事）。
 */
export function parseAnthropicLiveCaps(
  model: unknown,
): AnthropicLiveCaps | undefined {
  if (!isRecord(model)) return undefined;
  const id = nonEmptyString(model.id);
  if (id === undefined) return undefined;
  const capabilities = isRecord(model.capabilities)
    ? model.capabilities
    : undefined;

  return {
    id,
    displayName: nonEmptyString(model.display_name),
    contextWindow: positiveSafeInteger(model.max_input_tokens),
    maxOutput: positiveSafeInteger(model.max_tokens),
    thinking: capabilities ? parseThinking(capabilities) : undefined,
    imageInput: capabilities
      ? supportedOf(capabilities.image_input)
      : undefined,
    pdfInput: capabilities ? supportedOf(capabilities.pdf_input) : undefined,
    structuredOutputs: capabilities
      ? supportedOf(capabilities.structured_outputs)
      : undefined,
    lifecycle: nonEmptyString(model.lifecycle),
    retiresAt: nonEmptyString(model.retires_at),
  };
}
