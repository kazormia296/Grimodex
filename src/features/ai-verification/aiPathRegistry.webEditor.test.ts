import { describe, expect, it } from "vitest";
import { AI_RUNTIME_ROUTES } from "./aiPathRegistry";

describe("Web Editor AI runtime route registry", () => {
  it("registers only user-selected Local LLM or BYOK transport", () => {
    expect(AI_RUNTIME_ROUTES.map(({ id }) => id)).toEqual([
      "browser_byok_web",
    ]);
    expect(AI_RUNTIME_ROUTES[0]).toMatchObject({
      consentRoute: "byok",
      providerAuthority: "user-selection",
    });
    expect(JSON.stringify(AI_RUNTIME_ROUTES)).not.toMatch(
      /scan|hosted|server-runtime|openrouter/i,
    );
  });
});
