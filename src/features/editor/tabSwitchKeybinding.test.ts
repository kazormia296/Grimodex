// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { useSettingsStore } from "@/features/settings/settingsStore";
import { useTreeStore } from "@/features/tree/treeStore";
import { useInlineAiStore } from "./inlineAi/inlineAiStore";
import { useTabStore } from "./tabStore";
import { handleEditorTabSwitchKeydown } from "./tabSwitchKeybinding";

beforeEach(() => {
  useInlineAiStore.getState().reset();
  useSettingsStore.setState((state) => ({
    cache: { ...state.cache, "keys.bindings": "{}" },
  }));
  useTabStore.setState({
    tabs: [
      { nodeId: "scene-1", contentType: "scene", isPreview: false },
      { nodeId: "scene-2", contentType: "scene", isPreview: false },
    ],
    activeTabId: "scene-1",
    secondaryTabs: [],
    secondaryActiveTabId: null,
    secondaryGroupOpen: false,
    activeGroupIndex: 0,
  });
  useTreeStore.setState({ activeSceneId: "scene-1" });
});

describe("handleEditorTabSwitchKeydown", () => {
  it("leaves the hidden desktop tab model untouched in a phone workspace", () => {
    const event = new KeyboardEvent("keydown", {
      key: "Tab",
      code: "Tab",
      ctrlKey: true,
      cancelable: true,
    });

    expect(handleEditorTabSwitchKeydown(event, true)).toBe(false);
    expect(event.defaultPrevented).toBe(false);
    expect(useTabStore.getState().activeTabId).toBe("scene-1");
    expect(useTreeStore.getState().activeSceneId).toBe("scene-1");
  });

  it("continues to cycle desktop tabs outside a phone workspace", () => {
    const event = new KeyboardEvent("keydown", {
      key: "Tab",
      code: "Tab",
      ctrlKey: true,
      cancelable: true,
    });

    expect(handleEditorTabSwitchKeydown(event, false)).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expect(useTabStore.getState().activeTabId).toBe("scene-2");
    expect(useTreeStore.getState().activeSceneId).toBe("scene-2");
  });
});
