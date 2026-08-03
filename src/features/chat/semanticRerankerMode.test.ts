import { describe, expect, it } from "vitest";

import {
  resolveSemanticRerankerCapability,
  resolveSemanticRerankerLanguage,
  resolveSemanticRerankerMode,
} from "./semanticRerankerMode";

const availableCapability = {
  language: "ja",
  electronRuntime: true,
  resourcesAvailable: true,
};

describe("resolveSemanticRerankerMode", () => {
  it("keeps the product path off by default", () => {
    expect(
      resolveSemanticRerankerMode({
        applyEnabled: false,
        devShadowEnabled: false,
        semanticRecallEnabled: true,
        hybridRecallEnabled: true,
        capability: availableCapability,
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
        capability: availableCapability,
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
        capability: availableCapability,
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
        capability: availableCapability,
        ...prerequisites,
      }),
    ).toBe("off");
  });

  it.each([
    { language: "zh", electronRuntime: true, resourcesAvailable: true },
    { language: "ko", electronRuntime: true, resourcesAvailable: true },
    { language: "ja", electronRuntime: false, resourcesAvailable: true },
    { language: "en", electronRuntime: true, resourcesAvailable: false },
  ])(
    "fails closed when the local reranker is unavailable: %o",
    (capability) => {
      expect(
        resolveSemanticRerankerMode({
          applyEnabled: true,
          devShadowEnabled: true,
          semanticRecallEnabled: true,
          hybridRecallEnabled: true,
          capability,
        }),
      ).toBe("off");
    },
  );
});

describe("semantic reranker capability", () => {
  it.each([
    ["ja", "ja"],
    ["ja-JP", "ja"],
    ["en", "en"],
    ["en-US", "en"],
    ["zh", null],
    ["ko-KR", null],
    ["", null],
  ] as const)(
    "resolves %s without collapsing unsupported languages",
    (input, expected) => {
      expect(resolveSemanticRerankerLanguage(input)).toBe(expected);
    },
  );

  it("reports one shared language, host, and resource gate", () => {
    expect(
      resolveSemanticRerankerCapability({
        language: "ja-JP",
        electronRuntime: true,
        resourcesAvailable: true,
      }),
    ).toEqual({
      available: true,
      language: "ja",
      unavailableReason: null,
    });
    expect(
      resolveSemanticRerankerCapability({
        language: "zh",
        electronRuntime: true,
        resourcesAvailable: true,
      }),
    ).toEqual({
      available: false,
      language: null,
      unavailableReason: "unsupported-language",
    });
  });
});
