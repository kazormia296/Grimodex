import { describe, expect, it } from "vitest";

import { canAutoExpandNarrativeScope, validateNarrativeScope } from "./scope";

describe("narrative scope", () => {
  it("does not treat an unresolved empty scope as global truth", () => {
    const scope = { scopeStatus: "unresolved" as const };
    expect(validateNarrativeScope(scope)).toEqual({ valid: true });
    expect(canAutoExpandNarrativeScope(scope)).toBe(false);
  });

  it("requires an explicit scope to name at least one axis", () => {
    expect(validateNarrativeScope({ scopeStatus: "explicit" })).toEqual({
      valid: false,
      reason: "explicit-scope-axis-required",
    });
  });
});
