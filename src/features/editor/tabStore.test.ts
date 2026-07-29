import { describe, it, expect, beforeEach } from "vitest";
import { useTabStore } from "./tabStore";
import { useExternalWriteStore } from "@/features/concurrency/externalWriteStore";

// Reset store between tests
function resetStore() {
  useTabStore.setState({
    tabs: [],
    activeTabId: null,
    secondaryTabs: [],
    secondaryActiveTabId: null,
    secondaryGroupOpen: false,
    isLinearMode: false,
  });
  useExternalWriteStore.getState().clear();
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
        animateIn: true,
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
        animateIn: false,
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

    it("does not detach the active tab while its external conflict is unresolved", () => {
      useTabStore.getState().openPinned("scene-1");
      useTabStore.getState().openPinned("scene-2");
      useTabStore.getState().setActiveTab("scene-1");
      useExternalWriteStore.getState().pushConflict({
        documentKey: { kind: "tree", id: "scene-1", storage: "database" },
        sceneId: "scene-1",
        domain: "scene",
        opType: "update",
        entityId: "scene-1",
      });

      useTabStore.getState().setActiveTab("scene-2");

      expect(useTabStore.getState().activeTabId).toBe("scene-1");
    });
  });

  it("does not close the active tab while its external conflict is unresolved", () => {
    useTabStore.getState().openPinned("scene-1");
    useExternalWriteStore.getState().pushConflict({
      documentKey: { kind: "tree", id: "scene-1", storage: "database" },
      sceneId: "scene-1",
      domain: "scene",
      opType: "update",
      entityId: "scene-1",
    });

    useTabStore.getState().closeTab("scene-1");

    expect(useTabStore.getState().activeTabId).toBe("scene-1");
    expect(useTabStore.getState().tabs).toHaveLength(1);
  });

  it("does not leave linear mode while a tree conflict owns a mounted draft", () => {
    useTabStore.setState({ isLinearMode: true });
    useExternalWriteStore.getState().pushConflict({
      documentKey: { kind: "tree", id: "scene-1", storage: "database" },
      sceneId: "scene-1",
      domain: "scene",
      opType: "update",
      entityId: "scene-1",
    });

    useTabStore.getState().toggleLinearMode();

    expect(useTabStore.getState().isLinearMode).toBe(true);
  });

  it("does not switch the displayed Codex phase while its draft is conflicted", () => {
    useTabStore.getState().openCodexTab("entry-1", "__base__");
    useExternalWriteStore.getState().pushConflict({
      documentKey: { kind: "codex", id: "entry-1", phaseId: null },
      sceneId: "entry-1",
      domain: "codex",
      opType: "update",
      entityId: "entry-1",
    });

    useTabStore.getState().openCodexTab("entry-1", "phase-1");

    expect(useTabStore.getState().tabs[0]?.overridePhaseId).toBe("__base__");
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

  // --- setTabDirty ---
  describe("setTabDirty", () => {
    beforeEach(() => {
      useTabStore.setState({ dirtyTabIds: new Set() });
    });

    it("is a no-op (no new Set, no notify) when the state is unchanged", () => {
      const before = useTabStore.getState().dirtyTabIds;
      let notifications = 0;
      const unsub = useTabStore.subscribe(() => {
        notifications++;
      });
      // Tab is already clean — marking it clean again must not touch the store.
      useTabStore.getState().setTabDirty("scene-1", false);
      unsub();
      expect(useTabStore.getState().dirtyTabIds).toBe(before);
      expect(notifications).toBe(0);
    });

    it("does not re-notify when an already-dirty tab is marked dirty again", () => {
      useTabStore.getState().setTabDirty("scene-1", true);
      const afterAdd = useTabStore.getState().dirtyTabIds;
      let notifications = 0;
      const unsub = useTabStore.subscribe(() => {
        notifications++;
      });
      useTabStore.getState().setTabDirty("scene-1", true);
      unsub();
      expect(useTabStore.getState().dirtyTabIds).toBe(afterAdd);
      expect(notifications).toBe(0);
    });

    it("updates and notifies when the dirty state actually changes", () => {
      let notifications = 0;
      const unsub = useTabStore.subscribe(() => {
        notifications++;
      });
      useTabStore.getState().setTabDirty("scene-1", true);
      expect(useTabStore.getState().dirtyTabIds.has("scene-1")).toBe(true);
      useTabStore.getState().setTabDirty("scene-1", false);
      expect(useTabStore.getState().dirtyTabIds.has("scene-1")).toBe(false);
      unsub();
      expect(notifications).toBe(2);
    });
  });

  // --- openChronicleEventTab ---
  describe("openChronicleEventTab", () => {
    it("adds a pinned chronicle_event tab carrying the display label", () => {
      useTabStore.getState().openChronicleEventTab("ev-1", "戴冠式");
      const { tabs, activeTabId } = useTabStore.getState();
      expect(tabs).toHaveLength(1);
      expect(tabs[0]).toEqual({
        nodeId: "ev-1",
        isPreview: false,
        contentType: "chronicle_event",
        label: "戴冠式",
      });
      expect(activeTabId).toBe("ev-1");
    });

    it("refreshes the label and activates when re-opened", () => {
      useTabStore.getState().openChronicleEventTab("ev-1", "旧題");
      useTabStore.getState().openPinned("scene-1");
      useTabStore.getState().openChronicleEventTab("ev-1", "新題");
      const { tabs, activeTabId } = useTabStore.getState();
      expect(tabs).toHaveLength(2);
      const evTab = tabs.find((t) => t.nodeId === "ev-1");
      expect(evTab?.label).toBe("新題");
      expect(evTab?.contentType).toBe("chronicle_event");
      expect(activeTabId).toBe("ev-1");
    });

    it("replaces a stale preview tab rather than stacking it", () => {
      useTabStore.getState().openPreview("scene-1");
      useTabStore.getState().openChronicleEventTab("ev-1", "題");
      const { tabs } = useTabStore.getState();
      // preview scene tab is dropped, only the pinned chronicle tab remains
      expect(tabs).toHaveLength(1);
      expect(tabs[0].nodeId).toBe("ev-1");
    });

    it("splitting a chronicle tab to the secondary group preserves its contentType/label (not 'scene')", () => {
      useTabStore.getState().openChronicleEventTab("ev-1", "戴冠式");
      useTabStore.getState().openInSecondaryGroupDirectional("ev-1", "right");
      const sec = useTabStore
        .getState()
        .secondaryTabs.find((t) => t.nodeId === "ev-1");
      expect(sec?.contentType).toBe("chronicle_event");
      expect(sec?.label).toBe("戴冠式");
    });

    it("openInSecondaryGroup preserves an existing tab's contentType", () => {
      useTabStore.getState().openChronicleEventTab("ev-1", "題");
      useTabStore.getState().openInSecondaryGroup("ev-1");
      const sec = useTabStore
        .getState()
        .secondaryTabs.find((t) => t.nodeId === "ev-1");
      expect(sec?.contentType).toBe("chronicle_event");
    });
  });
});
