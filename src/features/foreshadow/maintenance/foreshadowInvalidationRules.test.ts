import { describe, expect, it } from "vitest";
import { adviseForeshadowInvalidation } from "./foreshadowInvalidationRules";

describe("adviseForeshadowInvalidation", () => {
  it("never auto-deletes foreshadow roots when payoff quote is removed", () => {
    const advice = adviseForeshadowInvalidation("payoff-quote-removed");
    expect(advice.autoDeleteRoot).toBe(false);
    expect(advice.policy).toBe("revalidate-exact");
  });
});
