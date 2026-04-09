import { describe, it, expect, beforeEach } from "vitest";
import { useTabStore } from "./tabStore";

function resetStore() {
  useTabStore.setState({
    tabs: [],
    activeTabId: null,
    secondaryTabs: [],
    secondaryActiveTabId: null,
    activeGroupIndex: 0,
  });
}

describe("tabStore — secondary group", () => {
  beforeEach(() => {
    resetStore();
  });

  describe("openInSecondaryGroup", () => {
    it("adds a pinned tab to the secondary group", () => {
      useTabStore.getState().openInSecondaryGroup("scene-1");
      const { secondaryTabs, secondaryActiveTabId, activeGroupIndex } =
        useTabStore.getState();
      expect(secondaryTabs).toHaveLength(1);
      expect(secondaryTabs[0]).toEqual({
        nodeId: "scene-1",
        isPreview: false,
        contentType: "scene",
      });
      expect(secondaryActiveTabId).toBe("scene-1");
      expect(activeGroupIndex).toBe(1);
    });

    it("activates an already-open secondary tab", () => {
      useTabStore.getState().openInSecondaryGroup("scene-1");
      useTabStore.getState().openInSecondaryGroup("scene-2");
      useTabStore.getState().openInSecondaryGroup("scene-1");
      const { secondaryTabs, secondaryActiveTabId } = useTabStore.getState();
      expect(secondaryTabs).toHaveLength(2);
      expect(secondaryActiveTabId).toBe("scene-1");
    });
  });

  describe("closeSecondaryTab", () => {
    it("removes a tab from the secondary group", () => {
      useTabStore.getState().openInSecondaryGroup("scene-1");
      useTabStore.getState().closeSecondaryTab("scene-1");
      expect(useTabStore.getState().secondaryTabs).toHaveLength(0);
      expect(useTabStore.getState().secondaryActiveTabId).toBeNull();
    });

    it("activates adjacent tab when active secondary tab is closed", () => {
      useTabStore.getState().openInSecondaryGroup("scene-1");
      useTabStore.getState().openInSecondaryGroup("scene-2");
      useTabStore.getState().openInSecondaryGroup("scene-3");
      useTabStore.getState().setSecondaryActiveTab("scene-2");
      useTabStore.getState().closeSecondaryTab("scene-2");
      expect(useTabStore.getState().secondaryActiveTabId).toBe("scene-3");
    });

    it("keeps activeGroupIndex on secondary when last tab is closed", () => {
      useTabStore.getState().openInSecondaryGroup("scene-1");
      useTabStore.getState().closeSecondaryTab("scene-1");
      expect(useTabStore.getState().activeGroupIndex).toBe(1);
    });
  });

  describe("closeSecondaryGroup", () => {
    it("clears all secondary tabs and resets to primary group", () => {
      useTabStore.getState().openInSecondaryGroup("scene-1");
      useTabStore.getState().openInSecondaryGroup("scene-2");
      useTabStore.getState().closeSecondaryGroup();
      const { secondaryTabs, secondaryActiveTabId, activeGroupIndex } =
        useTabStore.getState();
      expect(secondaryTabs).toHaveLength(0);
      expect(secondaryActiveTabId).toBeNull();
      expect(activeGroupIndex).toBe(0);
    });
  });

  describe("setSecondaryActiveTab", () => {
    it("sets the active tab in the secondary group", () => {
      useTabStore.getState().openInSecondaryGroup("scene-1");
      useTabStore.getState().openInSecondaryGroup("scene-2");
      useTabStore.getState().setSecondaryActiveTab("scene-1");
      expect(useTabStore.getState().secondaryActiveTabId).toBe("scene-1");
    });

    it("is a no-op if the node is not in secondary tabs", () => {
      useTabStore.getState().openInSecondaryGroup("scene-1");
      useTabStore.getState().setSecondaryActiveTab("non-existent");
      expect(useTabStore.getState().secondaryActiveTabId).toBe("scene-1");
    });
  });

  describe("setActiveGroup", () => {
    it("switches the active group", () => {
      useTabStore.getState().openInSecondaryGroup("scene-1");
      useTabStore.getState().setActiveGroup(0);
      expect(useTabStore.getState().activeGroupIndex).toBe(0);
      useTabStore.getState().setActiveGroup(1);
      expect(useTabStore.getState().activeGroupIndex).toBe(1);
    });
  });

  describe("pinSecondaryTab", () => {
    it("promotes a preview tab in the secondary group to pinned", () => {
      // Manually add a preview tab to secondary
      useTabStore.setState({
        secondaryTabs: [
          { nodeId: "scene-1", isPreview: true, contentType: "scene" as const },
        ],
        secondaryActiveTabId: "scene-1",
        activeGroupIndex: 1,
      });
      useTabStore.getState().pinSecondaryTab("scene-1");
      expect(useTabStore.getState().secondaryTabs[0].isPreview).toBe(false);
    });
  });

  describe("isSyncedScene", () => {
    it("returns true when same scene is in both groups", () => {
      useTabStore.getState().openPinned("scene-1");
      useTabStore.getState().openInSecondaryGroup("scene-1");
      expect(useTabStore.getState().isSyncedScene("scene-1")).toBe(true);
    });

    it("returns false when scene is only in primary group", () => {
      useTabStore.getState().openPinned("scene-1");
      expect(useTabStore.getState().isSyncedScene("scene-1")).toBe(false);
    });

    it("returns false when scene is only in secondary group", () => {
      useTabStore.getState().openInSecondaryGroup("scene-1");
      expect(useTabStore.getState().isSyncedScene("scene-1")).toBe(false);
    });
  });
});
