import { describe, expect, it } from "vitest";
import { shouldUseAdaptiveWorkspace } from "./adaptiveWorkspacePolicy";

describe("shouldUseAdaptiveWorkspace", () => {
  it("keeps adaptive chrome out of detached panel windows", () => {
    expect(
      shouldUseAdaptiveWorkspace({
        featureEnabled: true,
        panelWindow: true,
        screenshotPanelId: null,
      }),
    ).toBe(false);
  });

  it("keeps adaptive chrome out of dedicated screenshot panels", () => {
    expect(
      shouldUseAdaptiveWorkspace({
        featureEnabled: true,
        panelWindow: false,
        screenshotPanelId: "scenes",
      }),
    ).toBe(false);
  });

  it("enables adaptive chrome only for the normal workspace", () => {
    expect(
      shouldUseAdaptiveWorkspace({
        featureEnabled: true,
        panelWindow: false,
        screenshotPanelId: null,
      }),
    ).toBe(true);
  });
});
