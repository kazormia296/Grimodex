import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { useTabStore } from "./tabStore";
import {
  getProjectSetting,
  getSetting,
  setProjectSetting,
} from "@/features/settings/api";
import {
  getPersistedActiveSceneId,
  type TabPersistenceSnapshot,
} from "./tabPersistence";

vi.mock("@/features/settings/api", () => ({
  getProjectSetting: vi.fn(),
  getSetting: vi.fn(),
  setProjectSetting: vi.fn(),
}));

const PROJECT_ID = "project-1";
const mockGetProjectSetting = vi.mocked(getProjectSetting);
const mockGetSetting = vi.mocked(getSetting);
const mockSetProjectSetting = vi.mocked(setProjectSetting);

function resetStore() {
  useTabStore.getState().disposeAutoSave?.();
  useTabStore.setState({
    tabs: [],
    activeTabId: null,
    secondaryTabs: [],
    secondaryActiveTabId: null,
    activeGroupIndex: 0,
    tabStateHydrated: true,
    tabStateProjectId: PROJECT_ID,
  });
}

describe("tabPersistence", () => {
  beforeEach(() => {
    resetStore();
    vi.clearAllMocks();
    mockGetProjectSetting.mockResolvedValue(null);
    mockGetSetting.mockResolvedValue(null);
    mockSetProjectSetting.mockResolvedValue(undefined);
  });

  afterEach(() => {
    // Clean up subscription if any
    useTabStore.getState().disposeAutoSave?.();
    vi.useRealTimers();
  });

  // --- loadTabState ---
  describe("loadTabState", () => {
    it("marks a project reset unhydrated until its current load applies", async () => {
      useTabStore.getState().resetForProject();
      expect(useTabStore.getState().tabStateHydrated).toBe(false);
      mockGetProjectSetting.mockResolvedValueOnce(null);

      await expect(
        useTabStore.getState().loadTabState(PROJECT_ID),
      ).resolves.toBe(true);

      expect(useTabStore.getState().tabStateHydrated).toBe(true);
    });

    it("runs beforeApply before publishing the restored snapshot", async () => {
      useTabStore.getState().resetForProject();
      mockGetProjectSetting.mockResolvedValueOnce(
        JSON.stringify({
          tabs: [{ nodeId: "scene-1", isPreview: false }],
          activeTabId: "scene-1",
        }),
      );
      const observations: string[] = [];

      const applied = await useTabStore
        .getState()
        .loadTabState(PROJECT_ID, undefined, (snapshot) => {
          expect(snapshot.activeTabId).toBe("scene-1");
          expect(useTabStore.getState().tabs).toEqual([]);
          expect(useTabStore.getState().tabStateHydrated).toBe(false);
          observations.push("beforeApply");
        });

      expect(applied).toBe(true);
      expect(observations).toEqual(["beforeApply"]);
      expect(useTabStore.getState().activeTabId).toBe("scene-1");
      expect(useTabStore.getState().tabStateHydrated).toBe(true);
    });

    it("does not publish an async load superseded by a project reset", async () => {
      let resolveOld!: (value: string | null) => void;
      let resolveCurrent!: (value: string | null) => void;
      const oldRead = new Promise<string | null>((resolve) => {
        resolveOld = resolve;
      });
      const currentRead = new Promise<string | null>((resolve) => {
        resolveCurrent = resolve;
      });
      mockGetProjectSetting
        .mockImplementationOnce(() => oldRead)
        .mockImplementationOnce(() => currentRead);

      const oldLoad = useTabStore.getState().loadTabState(PROJECT_ID);
      useTabStore.getState().resetForProject();
      const currentLoad = useTabStore.getState().loadTabState(PROJECT_ID);
      resolveCurrent(
        JSON.stringify({
          tabs: [{ nodeId: "current-scene", isPreview: false }],
          activeTabId: "current-scene",
        }),
      );
      await expect(currentLoad).resolves.toBe(true);
      resolveOld(
        JSON.stringify({
          tabs: [{ nodeId: "old-scene", isPreview: false }],
          activeTabId: "old-scene",
        }),
      );

      await expect(oldLoad).resolves.toBe(false);
      expect(useTabStore.getState().activeTabId).toBe("current-scene");
      expect(useTabStore.getState().tabStateHydrated).toBe(true);
    });

    it("does not publish when the scoped beforeApply authority rejects the snapshot", async () => {
      useTabStore.getState().resetForProject();
      mockGetProjectSetting.mockResolvedValueOnce(
        JSON.stringify({
          tabs: [{ nodeId: "stale-scene", isPreview: false }],
          activeTabId: "stale-scene",
        }),
      );

      await expect(
        useTabStore.getState().loadTabState(PROJECT_ID, undefined, () => false),
      ).resolves.toBe(false);

      expect(useTabStore.getState().tabs).toEqual([]);
      expect(useTabStore.getState().activeTabId).toBeNull();
      expect(useTabStore.getState().tabStateHydrated).toBe(false);
    });

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
      mockGetProjectSetting.mockResolvedValueOnce(JSON.stringify(saved));

      await useTabStore.getState().loadTabState(PROJECT_ID);

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
      expect(mockGetProjectSetting).toHaveBeenCalledWith(
        PROJECT_ID,
        "editor.tabState",
      );
      expect(mockGetSetting).not.toHaveBeenCalled();
    });

    it("migrates the legacy global value only when project state is missing", async () => {
      const legacy = JSON.stringify({
        tabs: [{ nodeId: "scene-1", isPreview: false }],
        activeTabId: "scene-1",
      });
      mockGetProjectSetting.mockResolvedValueOnce(null);
      mockGetSetting.mockResolvedValueOnce(legacy);

      await expect(
        useTabStore.getState().loadTabState(PROJECT_ID),
      ).resolves.toBe(true);

      expect(useTabStore.getState().activeTabId).toBe("scene-1");
      expect(mockGetSetting).toHaveBeenCalledWith("editor.tabState");
      expect(mockSetProjectSetting).toHaveBeenCalledWith(
        PROJECT_ID,
        "editor.tabState",
        expect.any(String),
      );
    });

    it("resets to empty state when no saved state exists (new workspace)", async () => {
      // Simulate having tabs from a previous workspace
      useTabStore.setState({
        tabs: [{ nodeId: "old-scene", isPreview: false, contentType: "scene" }],
        activeTabId: "old-scene",
        secondaryTabs: [
          { nodeId: "old-scene-2", isPreview: false, contentType: "scene" },
        ],
        secondaryActiveTabId: "old-scene-2",
        secondaryGroupOpen: true,
        activeGroupIndex: 1,
        splitDirection: "below",
      });

      mockGetProjectSetting.mockResolvedValueOnce(null);

      await useTabStore.getState().loadTabState(PROJECT_ID);

      const state = useTabStore.getState();
      expect(state.tabs).toEqual([]);
      expect(state.activeTabId).toBeNull();
      expect(state.secondaryTabs).toEqual([]);
      expect(state.secondaryActiveTabId).toBeNull();
      expect(state.secondaryGroupOpen).toBe(false);
      expect(state.activeGroupIndex).toBe(0);
      expect(state.splitDirection).toBe("right");
    });

    it("does nothing when saved state is corrupted JSON", async () => {
      useTabStore.getState().resetForProject();
      mockGetProjectSetting.mockResolvedValueOnce("not valid json{{{");

      await expect(
        useTabStore.getState().loadTabState(PROJECT_ID),
      ).resolves.toBe(true);

      const state = useTabStore.getState();
      expect(state.tabs).toEqual([]);
      expect(state.activeTabId).toBeNull();
      expect(state.tabStateHydrated).toBe(true);
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
      mockGetProjectSetting.mockResolvedValueOnce(JSON.stringify(saved));

      const validIds = new Set(["scene-1", "scene-2", "scene-3"]);
      await useTabStore.getState().loadTabState(PROJECT_ID, validIds);

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
      mockGetProjectSetting.mockResolvedValueOnce(JSON.stringify(saved));

      const validIds = new Set(["scene-1"]);
      await useTabStore.getState().loadTabState(PROJECT_ID, validIds);

      const state = useTabStore.getState();
      expect(state.secondaryTabs).toEqual([]);
      expect(state.secondaryActiveTabId).toBeNull();
      expect(state.activeGroupIndex).toBe(0);
    });

    it("keeps non-tree document tabs when validating scene and note IDs", async () => {
      mockGetProjectSetting.mockResolvedValueOnce(
        JSON.stringify({
          tabs: [
            {
              nodeId: "scene-1",
              isPreview: false,
              contentType: "scene",
            },
            {
              nodeId: "codex-1",
              isPreview: false,
              contentType: "codex",
            },
            {
              nodeId: "snippet-1",
              isPreview: false,
              contentType: "snippet",
            },
            {
              nodeId: "event-1",
              isPreview: false,
              contentType: "chronicle_event",
            },
          ],
          activeTabId: "codex-1",
        }),
      );

      await useTabStore
        .getState()
        .loadTabState(PROJECT_ID, new Set(["scene-1", "note-1"]));

      expect(useTabStore.getState().tabs.map((tab) => tab.nodeId)).toEqual([
        "scene-1",
        "codex-1",
        "snippet-1",
        "event-1",
      ]);
      expect(useTabStore.getState().activeTabId).toBe("codex-1");
    });

    it("does not filter when validNodeIds is not provided", async () => {
      const saved = {
        tabs: [{ nodeId: "any-id", isPreview: false }],
        activeTabId: "any-id",
        secondaryTabs: [],
        secondaryActiveTabId: null,
        activeGroupIndex: 0,
      };
      mockGetProjectSetting.mockResolvedValueOnce(JSON.stringify(saved));

      await useTabStore.getState().loadTabState(PROJECT_ID);

      expect(useTabStore.getState().tabs).toEqual([
        { nodeId: "any-id", isPreview: false, contentType: "scene" },
      ]);
    });
  });

  describe("getPersistedActiveSceneId", () => {
    function snapshot(
      overrides: Partial<TabPersistenceSnapshot>,
    ): TabPersistenceSnapshot {
      return {
        tabs: [],
        activeTabId: null,
        secondaryTabs: [],
        secondaryActiveTabId: null,
        activeGroupIndex: 0,
        secondaryGroupOpen: false,
        splitDirection: "right",
        isLinearMode: false,
        ...overrides,
      };
    }

    it("resolves the active scene from the focused editor group", () => {
      expect(
        getPersistedActiveSceneId(
          snapshot({
            tabs: [
              {
                nodeId: "primary-scene",
                isPreview: false,
                contentType: "scene",
              },
            ],
            activeTabId: "primary-scene",
          }),
        ),
      ).toBe("primary-scene");

      expect(
        getPersistedActiveSceneId(
          snapshot({
            tabs: [
              {
                nodeId: "primary-scene",
                isPreview: false,
                contentType: "scene",
              },
            ],
            activeTabId: "primary-scene",
            secondaryTabs: [
              {
                nodeId: "secondary-scene",
                isPreview: false,
                contentType: "scene",
              },
            ],
            secondaryActiveTabId: "secondary-scene",
            secondaryGroupOpen: true,
            activeGroupIndex: 1,
          }),
        ),
      ).toBe("secondary-scene");
    });

    it("does not mistake a non-scene active document for scene context", () => {
      expect(
        getPersistedActiveSceneId(
          snapshot({
            tabs: [
              {
                nodeId: "codex-1",
                isPreview: false,
                contentType: "codex",
              },
            ],
            activeTabId: "codex-1",
          }),
        ),
      ).toBeNull();
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
      mockSetProjectSetting.mockResolvedValueOnce(undefined);

      await useTabStore.getState().saveTabState(PROJECT_ID);

      expect(mockSetProjectSetting).toHaveBeenCalledWith(
        PROJECT_ID,
        "editor.tabState",
        expect.any(String),
      );
      const savedJson = mockSetProjectSetting.mock.calls[0][2];
      const parsed = JSON.parse(savedJson);
      expect(parsed.tabs).toEqual([
        { nodeId: "scene-1", isPreview: false, contentType: "scene" },
      ]);
      expect(parsed.activeTabId).toBe("scene-1");
    });

    it("does not throw on save failure", async () => {
      mockSetProjectSetting.mockRejectedValueOnce(new Error("DB error"));

      await expect(
        useTabStore.getState().saveTabState(PROJECT_ID),
      ).resolves.toBeUndefined();
    });

    it("does not save an unhydrated Project snapshot", async () => {
      useTabStore.getState().resetForProject();

      await useTabStore.getState().saveTabState(PROJECT_ID);

      expect(mockSetProjectSetting).not.toHaveBeenCalled();
    });
  });

  // --- initAutoSave ---
  describe("initAutoSave", () => {
    it("saves after tab state changes (debounced)", async () => {
      vi.useFakeTimers();
      mockSetProjectSetting.mockResolvedValue(undefined);

      useTabStore.getState().initAutoSave(PROJECT_ID);
      useTabStore.getState().openPinned("scene-1");

      // Not saved yet (debounce)
      expect(mockSetProjectSetting).not.toHaveBeenCalled();

      // Advance past debounce
      await vi.advanceTimersByTimeAsync(600);

      expect(mockSetProjectSetting).toHaveBeenCalledTimes(1);

      vi.useRealTimers();
    });

    it("coalesces rapid changes into a single save", async () => {
      vi.useFakeTimers();
      mockSetProjectSetting.mockResolvedValue(undefined);

      useTabStore.getState().initAutoSave(PROJECT_ID);
      useTabStore.getState().openPinned("scene-1");
      useTabStore.getState().openPinned("scene-2");
      useTabStore.getState().openPinned("scene-3");

      await vi.advanceTimersByTimeAsync(600);

      expect(mockSetProjectSetting).toHaveBeenCalledTimes(1);
      const parsed = JSON.parse(mockSetProjectSetting.mock.calls[0][2]);
      expect(parsed.tabs).toHaveLength(3);

      vi.useRealTimers();
    });

    it("disposeAutoSave stops future saves", async () => {
      vi.useFakeTimers();
      mockSetProjectSetting.mockResolvedValue(undefined);

      useTabStore.getState().initAutoSave(PROJECT_ID);
      useTabStore.getState().openPinned("scene-1");

      useTabStore.getState().disposeAutoSave?.();

      await vi.advanceTimersByTimeAsync(600);

      expect(mockSetProjectSetting).not.toHaveBeenCalled();

      vi.useRealTimers();
    });

    it("disposes before reset so the old empty snapshot cannot reach the new Workspace DB", async () => {
      vi.useFakeTimers();
      mockSetProjectSetting.mockResolvedValue(undefined);
      useTabStore.setState({
        tabs: [
          {
            nodeId: "old-project-scene",
            isPreview: false,
            contentType: "scene",
          },
        ],
        activeTabId: "old-project-scene",
        tabStateHydrated: true,
        tabStateProjectId: PROJECT_ID,
      });
      useTabStore.getState().initAutoSave(PROJECT_ID);

      useTabStore.getState().resetForProject();
      await vi.advanceTimersByTimeAsync(600);

      expect(useTabStore.getState().tabStateHydrated).toBe(false);
      expect(mockSetProjectSetting).not.toHaveBeenCalled();
    });

    it("a stale disposer cannot clear the current autosave owner", async () => {
      vi.useFakeTimers();
      mockSetProjectSetting.mockResolvedValue(undefined);

      useTabStore.getState().initAutoSave(PROJECT_ID);
      const staleDispose = useTabStore.getState().disposeAutoSave;
      useTabStore.getState().initAutoSave(PROJECT_ID);
      const currentDispose = useTabStore.getState().disposeAutoSave;
      expect(currentDispose).not.toBe(staleDispose);

      staleDispose?.();
      expect(useTabStore.getState().disposeAutoSave).toBe(currentDispose);
      useTabStore.getState().openPinned("current-scene");
      await vi.advanceTimersByTimeAsync(600);

      expect(mockSetProjectSetting).toHaveBeenCalledTimes(1);
      expect(
        JSON.parse(mockSetProjectSetting.mock.calls[0][2]).activeTabId,
      ).toBe("current-scene");
    });
  });
});
