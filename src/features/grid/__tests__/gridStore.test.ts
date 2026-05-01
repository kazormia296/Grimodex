import { describe, it, expect, vi, beforeEach } from "vitest";
import { useGridStore } from "../gridStore";
import type { GlobalSettings } from "@/features/workspace/store";

// Mock persistence helpers so tests are isolated from DB
vi.mock("../gridContainerPersistence", () => ({
  loadContainerId: vi.fn().mockResolvedValue(null),
  saveContainerId: vi.fn().mockResolvedValue(undefined),
  clearContainerId: vi.fn().mockResolvedValue(undefined),
}));

// Mock treeStore to control node list
vi.mock("@/features/tree/treeStore", () => ({
  useTreeStore: {
    getState: vi.fn(() => ({ nodes: [] })),
  },
}));

// Mock invoke so the auto-persist subscriber doesn't fail
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue({}),
}));

import {
  loadContainerId,
  saveContainerId,
  clearContainerId,
} from "../gridContainerPersistence";
import { useTreeStore } from "@/features/tree/treeStore";

const mockLoadContainerId = vi.mocked(loadContainerId);
const mockSaveContainerId = vi.mocked(saveContainerId);
const mockClearContainerId = vi.mocked(clearContainerId);
const mockGetState = vi.mocked(useTreeStore.getState);

const DEFAULT_DISPLAY = {
  showSynopsis: true,
  showBeats: true,
  showCodex: true,
  showLabel: true,
  compactCards: false,
};

function resetStore() {
  useGridStore.setState({ containerId: null, display: { ...DEFAULT_DISPLAY } });
}

beforeEach(() => {
  resetStore();
  vi.clearAllMocks();
  mockGetState.mockReturnValue({ nodes: [] } as unknown as ReturnType<
    typeof useTreeStore.getState
  >);
});

describe("initial state", () => {
  it("has null containerId and default display settings", () => {
    const s = useGridStore.getState();
    expect(s.containerId).toBeNull();
    expect(s.display).toEqual(DEFAULT_DISPLAY);
  });
});

describe("setDisplay", () => {
  it("merges partial updates", () => {
    useGridStore
      .getState()
      .setDisplay({ showSynopsis: false, compactCards: true });
    const { display } = useGridStore.getState();
    expect(display.showSynopsis).toBe(false);
    expect(display.compactCards).toBe(true);
    // unaffected flags stay at default
    expect(display.showBeats).toBe(true);
    expect(display.showCodex).toBe(true);
    expect(display.showLabel).toBe(true);
  });
});

describe("loadFromSettings", () => {
  it("restores display settings from GlobalSettings", () => {
    const settings = {
      grid: { display: { showSynopsis: false, compactCards: true } },
    } as unknown as GlobalSettings;

    useGridStore.getState().loadFromSettings(settings);

    const { display } = useGridStore.getState();
    expect(display.showSynopsis).toBe(false);
    expect(display.compactCards).toBe(true);
    // missing keys fall back to default
    expect(display.showBeats).toBe(true);
  });

  it("is a no-op when grid key is absent", () => {
    const settings = {} as GlobalSettings;
    useGridStore.getState().loadFromSettings(settings);
    expect(useGridStore.getState().display).toEqual(DEFAULT_DISPLAY);
  });
});

describe("loadForProject", () => {
  it("sets containerId to null when nothing persisted", async () => {
    mockLoadContainerId.mockResolvedValueOnce(null);
    await useGridStore.getState().loadForProject("proj-1");
    expect(useGridStore.getState().containerId).toBeNull();
  });

  it("sets containerId when stored ID is a valid folder node", async () => {
    mockLoadContainerId.mockResolvedValueOnce("folder-1");
    mockGetState.mockReturnValue({
      nodes: [{ id: "folder-1", nodeType: "folder" }],
    } as unknown as ReturnType<typeof useTreeStore.getState>);

    await useGridStore.getState().loadForProject("proj-1");

    expect(useGridStore.getState().containerId).toBe("folder-1");
    expect(mockClearContainerId).not.toHaveBeenCalled();
  });

  it("clears stale ID when node no longer exists", async () => {
    mockLoadContainerId.mockResolvedValueOnce("stale-folder");
    mockGetState.mockReturnValue({ nodes: [] } as unknown as ReturnType<
      typeof useTreeStore.getState
    >);

    await useGridStore.getState().loadForProject("proj-1");

    expect(useGridStore.getState().containerId).toBeNull();
    expect(mockClearContainerId).toHaveBeenCalledWith("proj-1");
  });

  it("clears stale ID when node exists but is not a folder", async () => {
    mockLoadContainerId.mockResolvedValueOnce("scene-1");
    mockGetState.mockReturnValue({
      nodes: [{ id: "scene-1", nodeType: "scene" }],
    } as unknown as ReturnType<typeof useTreeStore.getState>);

    await useGridStore.getState().loadForProject("proj-1");

    expect(useGridStore.getState().containerId).toBeNull();
    expect(mockClearContainerId).toHaveBeenCalledWith("proj-1");
  });
});

describe("setContainerId", () => {
  it("persists a non-null id", async () => {
    await useGridStore.getState().setContainerId("proj-1", "folder-2");
    expect(useGridStore.getState().containerId).toBe("folder-2");
    expect(mockSaveContainerId).toHaveBeenCalledWith("proj-1", "folder-2");
  });

  it("clears when set to null", async () => {
    useGridStore.setState({ containerId: "folder-2" });
    await useGridStore.getState().setContainerId("proj-1", null);
    expect(useGridStore.getState().containerId).toBeNull();
    expect(mockClearContainerId).toHaveBeenCalledWith("proj-1");
  });
});
