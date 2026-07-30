import { describe, expect, it } from "vitest";

import { resolveSemanticRerankerMode } from "./semanticRerankerMode";

describe("resolveSemanticRerankerMode", () => {
  it("keeps the product path off by default", () => {
    expect(
      resolveSemanticRerankerMode({
        applyEnabled: false,
        devShadowEnabled: false,
        semanticRecallEnabled: true,
        hybridRecallEnabled: true,
      }),
    ).toBe("off");
  });

  it("gives explicit opt-in apply precedence over developer shadow", () => {
    expect(
      resolveSemanticRerankerMode({
        applyEnabled: true,
        devShadowEnabled: true,
        semanticRecallEnabled: true,
        hybridRecallEnabled: true,
      }),
    ).toBe("apply");
  });

  it("retains developer shadow as an observational diagnostic", () => {
    expect(
      resolveSemanticRerankerMode({
        applyEnabled: false,
        devShadowEnabled: true,
        semanticRecallEnabled: true,
        hybridRecallEnabled: true,
      }),
    ).toBe("shadow");
  });

  it.each([
    { semanticRecallEnabled: false, hybridRecallEnabled: true },
    { semanticRecallEnabled: true, hybridRecallEnabled: false },
  ])("fails closed when recall prerequisites are disabled", (prerequisites) => {
    expect(
      resolveSemanticRerankerMode({
        applyEnabled: true,
        devShadowEnabled: true,
        ...prerequisites,
      }),
    ).toBe("off");
  });
});
