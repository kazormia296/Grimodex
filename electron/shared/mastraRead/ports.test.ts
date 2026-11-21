import { describe, expect, it } from "vitest";

import { assertCoreProjectId } from "./ports.js";
import { createPerCodePointTokenizer } from "./tokenizer.testSupport.js";

describe("assertCoreProjectId", () => {
  it("accepts a non-empty string", () => {
    expect(() => assertCoreProjectId("p1")).not.toThrow();
  });

  it.each([undefined, null, "", "   ", 1, {}, []])(
    "refuses %j (it would drop the project condition of a read)",
    (value) => {
      expect(() => assertCoreProjectId(value)).toThrow(/projectId is required/);
    },
  );
});

describe("the test tokenizer", () => {
  const tokenizer = createPerCodePointTokenizer();

  it("counts one token per code point, 0 for the empty string", () => {
    expect(tokenizer.countTokens("")).toBe(0);
    expect(tokenizer.countTokens("abc")).toBe(3);
    expect(tokenizer.countTokens("灯台の灯")).toBe(4);
    // One astral code point is one token (two UTF-16 units).
    expect(tokenizer.countTokens("a\u{1F4A1}b")).toBe(3);
  });

  it("has its own kind, so a product wiring can refuse it", async () => {
    expect(tokenizer.kind).toBe("test-per-code-point");
    await expect(tokenizer.ensureReady()).resolves.toBeUndefined();
  });
});
