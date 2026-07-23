import { describe, expect, it } from "vitest";
import { shouldMountZenAmbientBackdrop } from "./zenAmbientBackdropPolicy";

describe("shouldMountZenAmbientBackdrop", () => {
  it("mounts in the normal workspace and editor-only capture", () => {
    expect(
      shouldMountZenAmbientBackdrop({
        panelWindowTarget: null,
        screenshotPanelId: null,
      }),
    ).toBe(true);
    expect(
      shouldMountZenAmbientBackdrop({
        panelWindowTarget: null,
        screenshotPanelId: "editor",
      }),
    ).toBe(true);
  });

  it.each(["chat", "timeline", "codex"] as const)(
    "mounts WebGL behind a detached %s panel window",
    (panelWindowTarget) => {
      expect(
        shouldMountZenAmbientBackdrop({
          panelWindowTarget,
          screenshotPanelId: null,
        }),
      ).toBe(true);
    },
  );

  it("mounts WebGL behind a non-editor solo screenshot panel", () => {
    expect(
      shouldMountZenAmbientBackdrop({
        panelWindowTarget: null,
        screenshotPanelId: "chat",
      }),
    ).toBe(true);
  });
});
