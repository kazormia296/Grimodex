import type { CoreTokenizer } from "./tokenizer.js";

/**
 * The count tests use: one Unicode code point is one token. It is not a
 * product count; no product path may build it (its kind is distinct, so a test
 * of the product wiring can refuse it).
 */
export function createPerCodePointTokenizer(): CoreTokenizer {
  return {
    kind: "test-per-code-point",
    ensureReady: () => Promise.resolve(),
    countTokens: (text) => Array.from(text).length,
  };
}
