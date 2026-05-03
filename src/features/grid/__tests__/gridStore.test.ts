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
  showStatusLabel: true,
  showLabelBar: true,
  showForeshadow: true,
  compactCards: false,
};

const DEFAULT_FILTER = {
  emptyOnly: false,
  hideCompleted: false,
  codexFilter: null as string | null,
  labelFilter: [] as string[],
};

function resetStore() {
  useGridStore.setState({
    containerId: null,
    display: { ...DEFAULT_DISPLAY },
    filter: { ...DEFAULT_FILTER },
    toolbarOpen: false,
    searchQuery: "",
  });
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
    expect(s.toolbarOpen).toBe(false);
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
    expect(display.showStatusLabel).toBe(true);
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

describe("filter", () => {
  it("初期 filter はすべて false / null", () => {
    expect(useGridStore.getState().filter).toEqual(DEFAULT_FILTER);
  });

  it("setFilter は部分更新する", () => {
    useGridStore.getState().setFilter({ emptyOnly: true });
    const { filter } = useGridStore.getState();
    expect(filter.emptyOnly).toBe(true);
    expect(filter.hideCompleted).toBe(false);
    expect(filter.codexFilter).toBeNull();
  });

  it("clearFilter はデフォルトに戻す", () => {
    useGridStore.getState().setFilter({ emptyOnly: true, codexFilter: "e1" });
    useGridStore.getState().clearFilter();
    expect(useGridStore.getState().filter).toEqual(DEFAULT_FILTER);
  });

  it("setSearchQuery / 初期値は空文字 / 永続化しない", () => {
    useGridStore.getState().setSearchQuery("旅");
    expect(useGridStore.getState().searchQuery).toBe("旅");
    // searchQuery is NOT in the persistent snapshot
    // (tested indirectly: loadFromSettings doesn't restore it)
    resetStore();
    expect(useGridStore.getState().searchQuery).toBe("");
  });
});

describe("loadFromSettings — filter 永続化", () => {
  it("filter を GlobalSettings から復元する", () => {
    const settings = {
      grid: {
        display: DEFAULT_DISPLAY,
        filter: { emptyOnly: true, hideCompleted: false, codexFilter: "e1" },
      },
    } as unknown as import("@/features/workspace/store").GlobalSettings;

    useGridStore.getState().loadFromSettings(settings);
    const { filter } = useGridStore.getState();
    expect(filter.emptyOnly).toBe(true);
    expect(filter.codexFilter).toBe("e1");
  });

  it("filter キーが欠落している場合はデフォルトにフォールバックする", () => {
    const settings = {
      grid: { display: DEFAULT_DISPLAY },
    } as unknown as import("@/features/workspace/store").GlobalSettings;

    useGridStore.getState().loadFromSettings(settings);
    expect(useGridStore.getState().filter).toEqual(DEFAULT_FILTER);
  });
});

describe("labelFilter", () => {
  it("初期値は空配列", () => {
    expect(useGridStore.getState().filter.labelFilter).toEqual([]);
  });

  it("setFilter で labelFilter を更新できる", () => {
    useGridStore.getState().setFilter({ labelFilter: ["label-a", "label-b"] });
    expect(useGridStore.getState().filter.labelFilter).toEqual([
      "label-a",
      "label-b",
    ]);
  });

  it("clearFilter で labelFilter が空配列に戻る", () => {
    useGridStore.getState().setFilter({ labelFilter: ["label-a"] });
    useGridStore.getState().clearFilter();
    expect(useGridStore.getState().filter.labelFilter).toEqual([]);
  });

  it("loadFromSettings: 旧形式（labelFilter 欠落）でも空配列でフォールバックする", () => {
    const settings = {
      grid: {
        display: DEFAULT_DISPLAY,
        filter: { emptyOnly: false, hideCompleted: false, codexFilter: null },
      },
    } as unknown as import("@/features/workspace/store").GlobalSettings;

    useGridStore.getState().loadFromSettings(settings);
    expect(useGridStore.getState().filter.labelFilter).toEqual([]);
  });

  it("loadFromSettings: labelFilter が保存されていれば復元する", () => {
    const settings = {
      grid: {
        display: DEFAULT_DISPLAY,
        filter: {
          emptyOnly: false,
          hideCompleted: false,
          codexFilter: null,
          labelFilter: ["label-x"],
        },
      },
    } as unknown as import("@/features/workspace/store").GlobalSettings;

    useGridStore.getState().loadFromSettings(settings);
    expect(useGridStore.getState().filter.labelFilter).toEqual(["label-x"]);
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
