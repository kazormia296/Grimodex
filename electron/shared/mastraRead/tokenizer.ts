/**
 * The tokenizer port of Electron main's read core (Mastra migration MP-4b,
 * DR-MP4-18). Only the type is here. The implementation (o200k_base with its
 * WASM and ranks) belongs to 4c-1, after the packaging measurement.
 *
 * A read tool cuts its result and judges its budget by a token count, so the
 * count decides what the model sees. The kind is closed on purpose:
 *   - `o200k_base` is the real count, the same as the renderer's exact mode;
 *   - `test-per-code-point` is the count tests use (see `tokenizer.testSupport`).
 * There is no heuristic kind. The renderer falls back to a character estimate
 * without saying so when its tokenizer is not ready; main does not: a tokenizer
 * that cannot be made ready is a refusal to start the turn (fail closed), not a
 * quieter number.
 */
export type CoreTokenizerKind = "o200k_base" | "test-per-code-point";

export interface CoreTokenizer {
  readonly kind: CoreTokenizerKind;
  /**
   * Resolves when `countTokens` is exact. Rejects when it cannot be made
   * ready; the caller then refuses the turn instead of counting differently.
   */
  ensureReady(): Promise<void>;
  /** Synchronous, like the renderer's `countTokens`. 0 for the empty string. */
  countTokens(text: string): number;
}
