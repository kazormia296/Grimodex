import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ContextWindowExceededError,
  finalizeTurnPayload,
  OllamaContextWindowTooSmallError,
  OllamaContextWindowUnknownError,
  type FinalizeTurnPayloadInput,
} from "./turnPayloadFinalizer.js";

interface GoldenFixture {
  cases: Array<{
    name: string;
    input: FinalizeTurnPayloadInput;
  }>;
}

function outcome(input: FinalizeTurnPayloadInput): unknown {
  try {
    return finalizeTurnPayload(input, (text) => text.length);
  } catch (error) {
    if (error instanceof ContextWindowExceededError) {
      return {
        error: {
          name: error.name,
          code: error.code,
          overflowTokens: error.overflowTokens,
          usage: error.usage,
        },
      };
    }
    if (error instanceof OllamaContextWindowTooSmallError) {
      return {
        error: {
          name: error.name,
          code: error.code,
          overflowTokens: error.overflowTokens,
          limitKind: error.limitKind,
          availableContextWindow: error.availableContextWindow,
          modelContextWindow: error.modelContextWindow,
          usage: error.usage,
        },
      };
    }
    if (error instanceof OllamaContextWindowUnknownError) {
      return {
        error: {
          name: error.name,
          code: error.code,
          requiredTokens: error.requiredTokens,
          modelContextWindow: error.modelContextWindow,
          usage: error.usage,
        },
      };
    }
    throw error;
  }
}

describe("shared finalizeTurnPayload", () => {
  it("matches the pre-move golden JSON byte for byte", () => {
    const fixtureBytes = readFileSync(
      new URL(
        "../../src/features/ai-context/__fixtures__/finalizeTurnPayload/golden.json",
        import.meta.url,
      ),
      "utf8",
    );
    const fixture = JSON.parse(fixtureBytes) as GoldenFixture;
    const output = {
      cases: fixture.cases.map(({ name, input }) => ({
        name,
        input,
        outcome: outcome(input),
      })),
    };
    expect(JSON.stringify(output)).toBe(JSON.stringify(fixture));
  });
});
