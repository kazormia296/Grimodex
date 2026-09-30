import { describe, expect, it } from "vitest";

import { shouldEnableWorkLayerPreview } from "./useWorkLayerPreviewPort";

describe("shouldEnableWorkLayerPreview", () => {
  it("stays off by default and in every production build", () => {
    expect(
      shouldEnableWorkLayerPreview({
        development: true,
        fixtureFlag: undefined,
        surfaceActive: true,
      }),
    ).toBe(false);
    expect(
      shouldEnableWorkLayerPreview({
        development: false,
        fixtureFlag: "true",
        surfaceActive: true,
      }),
    ).toBe(false);
  });

  it("requires an explicit development fixture flag", () => {
    expect(
      shouldEnableWorkLayerPreview({
        development: true,
        fixtureFlag: "true",
        surfaceActive: true,
      }),
    ).toBe(true);
    expect(
      shouldEnableWorkLayerPreview({
        development: true,
        fixtureFlag: "TRUE",
        surfaceActive: true,
      }),
    ).toBe(false);
  });

  it("does not import a preview for non-primary or locked surfaces", () => {
    expect(
      shouldEnableWorkLayerPreview({
        development: true,
        fixtureFlag: "true",
        surfaceActive: false,
      }),
    ).toBe(false);
  });
});
