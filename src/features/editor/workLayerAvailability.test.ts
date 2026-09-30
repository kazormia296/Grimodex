import { describe, expect, it } from "vitest";

import { isWorkLayerAvailable } from "./workLayerAvailability";

const PRIMARY_WORKSPACE = {
  lifecycleLocked: false,
  editorZenMode: false,
  phoneWorkspace: false,
  panelWindow: false,
  screenshotPanelId: null,
} as const;

describe("isWorkLayerAvailable", () => {
  it("activates only in the unlocked primary desktop workspace", () => {
    expect(isWorkLayerAvailable(PRIMARY_WORKSPACE)).toBe(true);

    for (const unavailable of [
      { lifecycleLocked: true },
      { editorZenMode: true },
      { phoneWorkspace: true },
      { panelWindow: true },
      { screenshotPanelId: "editor" },
    ]) {
      expect(
        isWorkLayerAvailable({ ...PRIMARY_WORKSPACE, ...unavailable }),
      ).toBe(false);
    }
  });
});
