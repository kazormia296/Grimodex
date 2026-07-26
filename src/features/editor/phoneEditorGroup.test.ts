import { describe, expect, it } from "vitest";
import { resolvePhoneEditorGroup } from "./phoneEditorGroup";

const splitState = {
  activeTabId: "scene-a",
  secondaryActiveTabId: "scene-b",
  secondaryGroupOpen: true,
  activeGroupIndex: 0 as const,
};

describe("resolvePhoneEditorGroup", () => {
  it("uses the group that already owns the selected document", () => {
    expect(resolvePhoneEditorGroup(splitState, "scene-a")).toBe(0);
    expect(resolvePhoneEditorGroup(splitState, "scene-b")).toBe(1);
  });

  it("falls back to the desktop active group for a new or duplicated document", () => {
    expect(resolvePhoneEditorGroup(splitState, "scene-c")).toBe(0);
    expect(
      resolvePhoneEditorGroup(
        {
          ...splitState,
          activeTabId: "scene-a",
          secondaryActiveTabId: "scene-a",
          activeGroupIndex: 1,
        },
        "scene-a",
      ),
    ).toBe(1);
  });

  it("never returns the closed secondary group", () => {
    expect(
      resolvePhoneEditorGroup(
        {
          ...splitState,
          secondaryGroupOpen: false,
          activeGroupIndex: 1,
        },
        "scene-b",
      ),
    ).toBe(0);
  });

  it("keeps an inline-AI owner visible when both groups hold the document", () => {
    const duplicated = {
      ...splitState,
      activeTabId: "scene-a",
      secondaryActiveTabId: "scene-a",
      activeGroupIndex: 1 as const,
    };

    expect(resolvePhoneEditorGroup(duplicated, "scene-a", 0)).toBe(0);
    expect(resolvePhoneEditorGroup(duplicated, "scene-a", 1)).toBe(1);
  });
});
