import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { useTabStore } from "./tabStore";
import { getSetting, setSetting } from "@/features/settings/api";

vi.mock("@/features/settings/api", () => ({
  getSetting: vi.fn(),
  setSetting: vi.fn(),
}));

const mockGetSetting = vi.mocked(getSetting);
const mockSetSetting = vi.mocked(setSetting);

function resetStore() {
  useTabStore.setState({
    tabs: [],
    activeTabId: null,
    secondaryTabs: [],
    secondaryActiveTabId: null,
    activeGroupIndex: 0,
  });
}

describe("tabPersistence", () => {
  beforeEach(() => {
    resetStore();
    vi.clearAllMocks();
  });

  afterEach(() => {
    // Clean up subscription if any
    useTabStore.getState().disposeAutoSave?.();
  });

  // --- loadTabState ---
  describe("loadTabState", () => {
    it("restores persisted tabs and active state", async () => {
      const saved = {
        tabs: [
          { nodeId: "scene-1", isPreview: false },
          { nodeId: "scene-2", isPreview: true },
        ],
        activeTabId: "scene-1",
        secondaryTabs: [{ nodeId: "scene-3", isPreview: false }],
        secondaryActiveTabId: "scene-3",
        activeGroupIndex: 1,
      };
      mockGetSetting.mockResolvedValueOnce(JSON.stringify(saved));

      await useTabStore.getState().loadTabState();

      const state = useTabStore.getState();
      // loadTabState migrates old data by adding contentType: "scene"
      expect(state.tabs).toEqual([
        { nodeId: "scene-1", isPreview: false, contentType: "scene" },
        { nodeId: "scene-2", isPreview: true, contentType: "scene" },
      ]);
      expect(state.activeTabId).toBe("scene-1");
      expect(state.secondaryTabs).toEqual([
        { nodeId: "scene-3", isPreview: false, contentType: "scene" },
      ]);
      expect(state.secondaryActiveTabId).toBe("scene-3");
      expect(state.activeGroupIndex).toBe(1);
      expect(mockGetSetting).toHaveBeenCalledWith("editor.tabState");
    });

    it("does nothing when no saved state exists", async () => {
      mockGetSetting.mockResolvedValueOnce(null);

      await useTabStore.getState().loadTabState();

      const state = useTabStore.getState();
      expect(state.tabs).toEqual([]);
      expect(state.activeTabId).toBeNull();
    });

    it("does nothing when saved state is corrupted JSON", async () => {
      mockGetSetting.mockResolvedValueOnce("not valid json{{{");

      await useTabStore.getState().loadTabState();

      const state = useTabStore.getState();
      expect(state.tabs).toEqual([]);
      expect(state.activeTabId).toBeNull();
    });

    it("filters out tabs whose nodeId is not in validNodeIds", async () => {
      const saved = {
        tabs: [
          { nodeId: "scene-1", isPreview: false },
          { nodeId: "deleted-scene", isPreview: false },
          { nodeId: "scene-2", isPreview: true },
        ],
        activeTabId: "deleted-scene",
        secondaryTabs: [
          { nodeId: "scene-3", isPreview: false },
          { nodeId: "also-deleted", isPreview: false },
        ],
        secondaryActiveTabId: "also-deleted",
        activeGroupIndex: 1,
      };
      mockGetSetting.mockResolvedValueOnce(JSON.stringify(saved));

      const validIds = new Set(["scene-1", "scene-2", "scene-3"]);
      await useTabStore.getState().loadTabState(validIds);

      const state = useTabStore.getState();
      expect(state.tabs).toEqual([
        { nodeId: "scene-1", isPreview: false, contentType: "scene" },
        { nodeId: "scene-2", isPreview: true, contentType: "scene" },
      ]);
      // activeTabId was deleted-scene → falls back to first remaining tab
      expect(state.activeTabId).toBe("scene-1");
      expect(state.secondaryTabs).toEqual([
        { nodeId: "scene-3", isPreview: false, contentType: "scene" },
      ]);
      // secondaryActiveTabId was also-deleted → falls back to first remaining
      expect(state.secondaryActiveTabId).toBe("scene-3");
    });

    it("clears secondary group when all secondary tabs are invalid", async () => {
      const saved = {
        tabs: [{ nodeId: "scene-1", isPreview: false }],
        activeTabId: "scene-1",
        secondaryTabs: [{ nodeId: "deleted", isPreview: false }],
        secondaryActiveTabId: "deleted",
        activeGroupIndex: 1,
      };
      mockGetSetting.mockResolvedValueOnce(JSON.stringify(saved));

      const validIds = new Set(["scene-1"]);
      await useTabStore.getState().loadTabState(validIds);

      const state = useTabStore.getState();
      expect(state.secondaryTabs).toEqual([]);
      expect(state.secondaryActiveTabId).toBeNull();
      expect(state.activeGroupIndex).toBe(0);
    });

    it("does not filter when validNodeIds is not provided", async () => {
      const saved = {
        tabs: [{ nodeId: "any-id", isPreview: false }],
        activeTabId: "any-id",
        secondaryTabs: [],
        secondaryActiveTabId: null,
        activeGroupIndex: 0,
      };
      mockGetSetting.mockResolvedValueOnce(JSON.stringify(saved));

      await useTabStore.getState().loadTabState();

      expect(useTabStore.getState().tabs).toEqual([
        { nodeId: "any-id", isPreview: false, contentType: "scene" },
      ]);
    });
  });

  // --- saveTabState ---
  describe("saveTabState", () => {
    it("persists current tab state to settings", async () => {
      useTabStore.setState({
        tabs: [{ nodeId: "scene-1", isPreview: false, contentType: "scene" }],
        activeTabId: "scene-1",
        secondaryTabs: [],
        secondaryActiveTabId: null,
        activeGroupIndex: 0,
      });
      mockSetSetting.mockResolvedValueOnce(undefined);

      await useTabStore.getState().saveTabState();

      expect(mockSetSetting).toHaveBeenCalledWith(
        "editor.tabState",
        expect.any(String),
      );
      const savedJson = mockSetSetting.mock.calls[0][1];
      const parsed = JSON.parse(savedJson);
      expect(parsed.tabs).toEqual([
        { nodeId: "scene-1", isPreview: false, contentType: "scene" },
      ]);
      expect(parsed.activeTabId).toBe("scene-1");
    });

    it("does not throw on save failure", async () => {
      mockSetSetting.mockRejectedValueOnce(new Error("DB error"));

      await expect(
        useTabStore.getState().saveTabState(),
      ).resolves.toBeUndefined();
    });
  });

  // --- initAutoSave ---
  describe("initAutoSave", () => {
    it("saves after tab state changes (debounced)", async () => {
      vi.useFakeTimers();
      mockSetSetting.mockResolvedValue(undefined);

      useTabStore.getState().initAutoSave();
      useTabStore.getState().openPinned("scene-1");

      // Not saved yet (debounce)
      expect(mockSetSetting).not.toHaveBeenCalled();

      // Advance past debounce
      await vi.advanceTimersByTimeAsync(600);

      expect(mockSetSetting).toHaveBeenCalledTimes(1);

      vi.useRealTimers();
    });

    it("coalesces rapid changes into a single save", async () => {
      vi.useFakeTimers();
      mockSetSetting.mockResolvedValue(undefined);

      useTabStore.getState().initAutoSave();
      useTabStore.getState().openPinned("scene-1");
      useTabStore.getState().openPinned("scene-2");
      useTabStore.getState().openPinned("scene-3");

      await vi.advanceTimersByTimeAsync(600);

      expect(mockSetSetting).toHaveBeenCalledTimes(1);
      const parsed = JSON.parse(mockSetSetting.mock.calls[0][1]);
      expect(parsed.tabs).toHaveLength(3);

      vi.useRealTimers();
    });

    it("disposeAutoSave stops future saves", async () => {
      vi.useFakeTimers();
      mockSetSetting.mockResolvedValue(undefined);

      useTabStore.getState().initAutoSave();
      useTabStore.getState().openPinned("scene-1");

      useTabStore.getState().disposeAutoSave?.();

      await vi.advanceTimersByTimeAsync(600);

      expect(mockSetSetting).not.toHaveBeenCalled();

      vi.useRealTimers();
    });
  });
});
