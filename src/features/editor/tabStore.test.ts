import { describe, it, expect, beforeEach } from "vitest";
import { useTabStore } from "./tabStore";

// Reset store between tests
function resetStore() {
  useTabStore.setState({ tabs: [], activeTabId: null });
}

describe("tabStore", () => {
  beforeEach(() => {
    resetStore();
  });

  // --- openPreview ---
  describe("openPreview", () => {
    it("adds a new preview tab when no tabs exist", () => {
      useTabStore.getState().openPreview("scene-1");
      const { tabs, activeTabId } = useTabStore.getState();
      expect(tabs).toHaveLength(1);
      expect(tabs[0]).toEqual({
        nodeId: "scene-1",
        isPreview: true,
        contentType: "scene",
      });
      expect(activeTabId).toBe("scene-1");
    });

    it("replaces an existing preview tab with a new one", () => {
      useTabStore.getState().openPreview("scene-1");
      useTabStore.getState().openPreview("scene-2");
      const { tabs, activeTabId } = useTabStore.getState();
      expect(tabs).toHaveLength(1);
      expect(tabs[0]).toEqual({
        nodeId: "scene-2",
        isPreview: true,
        contentType: "scene",
      });
      expect(activeTabId).toBe("scene-2");
    });

    it("does not replace a pinned tab — just activates it", () => {
      useTabStore.getState().openPinned("scene-1");
      useTabStore.getState().openPreview("scene-1");
      const { tabs, activeTabId } = useTabStore.getState();
      expect(tabs).toHaveLength(1);
      expect(tabs[0].isPreview).toBe(false); // still pinned
      expect(activeTabId).toBe("scene-1");
    });

    it("keeps existing pinned tabs when adding a preview", () => {
      useTabStore.getState().openPinned("scene-1");
      useTabStore.getState().openPreview("scene-2");
      const { tabs } = useTabStore.getState();
      expect(tabs).toHaveLength(2);
      expect(tabs.find((t) => t.nodeId === "scene-1")?.isPreview).toBe(false);
      expect(tabs.find((t) => t.nodeId === "scene-2")?.isPreview).toBe(true);
    });

    it("replaces old preview with new one keeping pinned tabs intact", () => {
      useTabStore.getState().openPinned("scene-1");
      useTabStore.getState().openPreview("scene-2");
      useTabStore.getState().openPreview("scene-3");
      const { tabs, activeTabId } = useTabStore.getState();
      expect(tabs).toHaveLength(2); // 1 pinned + 1 preview
      expect(tabs.find((t) => t.nodeId === "scene-2")).toBeUndefined();
      expect(tabs.find((t) => t.nodeId === "scene-3")?.isPreview).toBe(true);
      expect(activeTabId).toBe("scene-3");
    });

    it("activates an already-open preview tab without duplication", () => {
      useTabStore.getState().openPreview("scene-1");
      useTabStore.getState().openPreview("scene-1");
      const { tabs } = useTabStore.getState();
      expect(tabs).toHaveLength(1);
    });
  });

  // --- openPinned ---
  describe("openPinned", () => {
    it("adds a new pinned tab when no tabs exist", () => {
      useTabStore.getState().openPinned("scene-1");
      const { tabs, activeTabId } = useTabStore.getState();
      expect(tabs).toHaveLength(1);
      expect(tabs[0]).toEqual({
        nodeId: "scene-1",
        isPreview: false,
        contentType: "scene",
      });
      expect(activeTabId).toBe("scene-1");
    });

    it("promotes an existing preview tab to pinned", () => {
      useTabStore.getState().openPreview("scene-1");
      useTabStore.getState().openPinned("scene-1");
      const { tabs } = useTabStore.getState();
      expect(tabs).toHaveLength(1);
      expect(tabs[0]).toEqual({
        nodeId: "scene-1",
        isPreview: false,
        contentType: "scene",
      });
    });

    it("activates an already-pinned tab without adding a duplicate", () => {
      useTabStore.getState().openPinned("scene-1");
      useTabStore.getState().openPinned("scene-2");
      useTabStore.getState().openPinned("scene-1");
      const { tabs, activeTabId } = useTabStore.getState();
      expect(tabs).toHaveLength(2);
      expect(activeTabId).toBe("scene-1");
    });

    it("adds a pinned tab without removing the preview tab", () => {
      useTabStore.getState().openPreview("scene-preview");
      useTabStore.getState().openPinned("scene-1");
      const { tabs } = useTabStore.getState();
      expect(tabs).toHaveLength(2);
    });
  });

  // --- pinTab ---
  describe("pinTab", () => {
    it("converts a preview tab to pinned", () => {
      useTabStore.getState().openPreview("scene-1");
      useTabStore.getState().pinTab("scene-1");
      const { tabs } = useTabStore.getState();
      expect(tabs[0].isPreview).toBe(false);
    });

    it("does nothing if the tab is already pinned", () => {
      useTabStore.getState().openPinned("scene-1");
      useTabStore.getState().pinTab("scene-1");
      const { tabs } = useTabStore.getState();
      expect(tabs[0].isPreview).toBe(false);
    });

    it("does nothing if the tab does not exist", () => {
      useTabStore.getState().pinTab("non-existent");
      expect(useTabStore.getState().tabs).toHaveLength(0);
    });
  });

  // --- closeTab ---
  describe("closeTab", () => {
    it("removes the tab", () => {
      useTabStore.getState().openPinned("scene-1");
      useTabStore.getState().closeTab("scene-1");
      expect(useTabStore.getState().tabs).toHaveLength(0);
      expect(useTabStore.getState().activeTabId).toBeNull();
    });

    it("activates the next tab when the active tab is closed", () => {
      useTabStore.getState().openPinned("scene-1");
      useTabStore.getState().openPinned("scene-2");
      useTabStore.getState().openPinned("scene-3");
      useTabStore.getState().setActiveTab("scene-2");
      useTabStore.getState().closeTab("scene-2");
      const { tabs, activeTabId } = useTabStore.getState();
      expect(tabs).toHaveLength(2);
      expect(activeTabId).toBe("scene-3"); // activates the tab that was after
    });

    it("activates the previous tab when the last tab is closed", () => {
      useTabStore.getState().openPinned("scene-1");
      useTabStore.getState().openPinned("scene-2");
      useTabStore.getState().setActiveTab("scene-2");
      useTabStore.getState().closeTab("scene-2");
      const { activeTabId } = useTabStore.getState();
      expect(activeTabId).toBe("scene-1");
    });

    it("sets activeTabId to null when the last tab is closed", () => {
      useTabStore.getState().openPinned("scene-1");
      useTabStore.getState().closeTab("scene-1");
      expect(useTabStore.getState().activeTabId).toBeNull();
    });

    it("does not change activeTabId when a non-active tab is closed", () => {
      useTabStore.getState().openPinned("scene-1");
      useTabStore.getState().openPinned("scene-2");
      useTabStore.getState().setActiveTab("scene-1");
      useTabStore.getState().closeTab("scene-2");
      expect(useTabStore.getState().activeTabId).toBe("scene-1");
    });
  });

  // --- setActiveTab ---
  describe("setActiveTab", () => {
    it("sets the active tab", () => {
      useTabStore.getState().openPinned("scene-1");
      useTabStore.getState().openPinned("scene-2");
      useTabStore.getState().setActiveTab("scene-1");
      expect(useTabStore.getState().activeTabId).toBe("scene-1");
    });

    it("does nothing when nodeId does not exist in tabs", () => {
      useTabStore.getState().openPinned("scene-1");
      useTabStore.getState().setActiveTab("non-existent");
      // activeTabId should remain unchanged
      expect(useTabStore.getState().activeTabId).toBe("scene-1");
    });
  });

  // --- ensureTab ---
  describe("ensureTab", () => {
    it("adds a pinned tab if the nodeId is not already open", () => {
      useTabStore.getState().ensureTab("scene-1");
      const { tabs, activeTabId } = useTabStore.getState();
      expect(tabs).toHaveLength(1);
      expect(tabs[0]).toEqual({
        nodeId: "scene-1",
        isPreview: false,
        contentType: "scene",
      });
      expect(activeTabId).toBe("scene-1");
    });

    it("does not add a duplicate tab if already open", () => {
      useTabStore.getState().openPinned("scene-1");
      useTabStore.getState().ensureTab("scene-1");
      expect(useTabStore.getState().tabs).toHaveLength(1);
    });
  });
});
