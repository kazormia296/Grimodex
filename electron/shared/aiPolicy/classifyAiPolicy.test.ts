import { describe, expect, it } from "vitest";

import vector from "../../../src/features/ai-policy/policyDecisionVector.v2.fixture.json" with { type: "json" };
import { classifyAiPolicy } from "./classifyAiPolicy.js";

describe("classifyAiPolicy", () => {
  it("matches every v2 decision vector", () => {
    for (const { label, raw, state, expected } of vector) {
      expect(classifyAiPolicy(raw), label).toEqual({
        state,
        preset: state === "valid" ? JSON.parse(raw as string).preset : "custom",
        toggles: expected,
      });
    }
  });

  it.each([undefined, true, 1, {}, []])(
    "rejects non-string input %s",
    (raw) => {
      expect(classifyAiPolicy(raw).state).toBe("invalid");
    },
  );

  it("does not accept an inherited preset name", () => {
    expect(
      classifyAiPolicy(
        JSON.stringify({
          preset: "constructor",
          toggles: { chat: true, bodyWrite: true, analysis: true },
        }),
      ).state,
    ).toBe("invalid");
  });
});
