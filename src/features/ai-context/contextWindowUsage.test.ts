import { describe, expect, it } from "vitest";
import {
  contextWindowUsageFromError,
  contextWindowUsageFromTurnPayloadUsage,
  createContextWindowUsage,
} from "./contextWindowUsage";

const exceededUsage = {
  systemTokens: 800,
  conversationTokens: 237,
  toolTokens: 5_591,
  envelopeTokens: 0,
  safetyMarginTokens: 32,
  inputTokens: 6_628,
  outputReservedTokens: 3_072,
  reservedTotalTokens: 9_732,
  remainingTokens: -5_636,
};

describe("contextWindowUsage", () => {
  it("counts Agent tools, output reserve, and safety in the displayed request total", () => {
    expect(
      createContextWindowUsage({
        contextTokens: 1_037,
        toolTokens: 5_591,
        outputReservedTokens: 3_072,
        safetyMarginTokens: 32,
        contextWindow: 4_096,
        estimated: true,
      }),
    ).toEqual({
      contextTokens: 1_037,
      toolTokens: 5_591,
      envelopeTokens: 0,
      safetyMarginTokens: 32,
      inputTokens: 6_628,
      outputReservedTokens: 3_072,
      reservedTotalTokens: 9_732,
      contextWindow: 4_096,
      remainingTokens: -5_636,
      overflowTokens: 5_636,
      estimated: true,
    });
  });

  it("projects finalized usage and preserves an over-capacity request", () => {
    expect(contextWindowUsageFromTurnPayloadUsage(exceededUsage)).toMatchObject(
      {
        contextTokens: 1_037,
        toolTokens: 5_591,
        inputTokens: 6_628,
        reservedTotalTokens: 9_732,
        contextWindow: 4_096,
        overflowTokens: 5_636,
        estimated: false,
      },
    );
  });

  it("recovers finalized usage from a typed payload error without relying on its class", () => {
    expect(
      contextWindowUsageFromError({
        code: "OLLAMA_CONTEXT_WINDOW_TOO_SMALL",
        usage: exceededUsage,
      }),
    ).toMatchObject({
      reservedTotalTokens: 9_732,
      contextWindow: 4_096,
      overflowTokens: 5_636,
      estimated: false,
    });
    expect(contextWindowUsageFromError(new Error("unrelated"))).toBeNull();
  });
});
