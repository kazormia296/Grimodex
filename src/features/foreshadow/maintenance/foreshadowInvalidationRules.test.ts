import { describe, expect, it } from "vitest";
import { adviseForeshadowInvalidation } from "./foreshadowInvalidationRules";

describe("adviseForeshadowInvalidation", () => {
  it("never auto-applies any Gate C0 advice", () => {
    const signals = [
      "setup-or-payoff-content",
      "reading-order",
      "codex-link",
      "payoff-quote-removed",
    ] as const;
    for (const signal of signals) {
      expect(adviseForeshadowInvalidation(signal).autoApply).toBe(false);
    }
  });

  it("never auto-deletes foreshadow roots when payoff quote is removed", () => {
    const advice = adviseForeshadowInvalidation("payoff-quote-removed");
    expect(advice.autoDeleteRoot).toBe(false);
    expect(advice.policy).toBe("revalidate-exact");
  });
});
