// @vitest-environment happy-dom

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  project: { current: { id: "p1" } as { id: string } | undefined },
  hostProjectId: null as string | null,
  lastSelector: null as ((state: unknown) => unknown) | null,
  syncProject: vi.fn(),
  requestScan: vi.fn().mockResolvedValue(undefined),
  livePortImports: 0,
  liveReaderImports: 0,
}));

vi.mock("@/features/project/projectStore", () => ({
  useProjectStore: (selector: (state: unknown) => unknown) => {
    mocks.lastSelector = selector;
    return selector({
      currentProjectId: mocks.project.current?.id ?? "placeholder",
      projects: mocks.project.current ? [mocks.project.current] : [],
    });
  },
  getCurrentProjectLanguage: () => "ja",
}));
vi.mock("@/features/codex/codexCandidateHostStore", () => ({
  useCodexCandidateHostStore: {
    getState: () => ({
      projectId: mocks.hostProjectId,
      scan: { status: "idle", candidates: [] },
      dismissed: new Set(),
      dismissedLoaded: false,
      syncProject: mocks.syncProject,
      requestScan: mocks.requestScan,
    }),
    subscribe: () => () => {},
  },
  selectCodexCandidateCount: () => ({ status: "not-counted" }),
}));
vi.mock("@/features/codex/codexStore", () => ({
  useCodexStore: {
    getState: () => ({ entries: [] }),
    subscribe: () => () => {},
  },
}));
vi.mock(
  "@/features/narrative-extraction/runtime/narrativeRuntimePolicyApi",
  () => ({
    getNarrativeRuntimePolicy: vi.fn(),
  }),
);
vi.mock("@/features/narrative-extraction/maintenance/maintenanceFlags", () => ({
  isNarrativeMaintenanceUiEnabled: vi.fn(() => false),
}));
vi.mock("@/application/narrative-extraction/nativeApi", () => ({
  narrativeMaintenanceInboxList: vi.fn(),
}));
vi.mock(
  "@/features/narrative-extraction/maintenance-ui/structureHealthModel",
  () => ({
    summarizeInbox: vi.fn(),
  }),
);
vi.mock("@/features/codex/codexStructureExtractionFlag", () => ({
  isCodexStructureExtractionReviewEnabled: vi.fn(() => false),
}));
vi.mock("@/features/ime/language", () => ({
  isJapaneseProjectLanguage: vi.fn(() => true),
}));
vi.mock("@/features/work-layer/workLayerLivePort", async (importOriginal) => {
  mocks.livePortImports += 1;
  return importOriginal();
});
vi.mock("./workLayerLiveReaders", async (importOriginal) => {
  mocks.liveReaderImports += 1;
  return importOriginal();
});

import {
  useLiveWorkLayerPort,
  useWorkLayerLivePort,
} from "./useWorkLayerLivePort";

// 旗は build で定数になるので、`useWorkLayerLivePort`（build が選ぶ側）は、この試験の環境
// （旗を指定しない）では「何もしない」側になる。live の振る舞いは `useLiveWorkLayerPort` を直接試験する。
describe("useWorkLayerLivePort (flag closed: the default build)", () => {
  beforeEach(() => {
    mocks.project.current = { id: "p1" };
    mocks.lastSelector = null;
    mocks.syncProject.mockClear();
    mocks.livePortImports = 0;
    mocks.liveReaderImports = 0;
  });

  it("returns nothing, subscribes to nothing, and loads nothing", () => {
    const { result } = renderHook(() => useWorkLayerLivePort(true));
    expect(result.current).toBeNull();
    // 旗が閉じている間は、project の store も購読しない（作品の変更で再描画しない）。
    expect(mocks.lastSelector).toBeNull();
    expect(mocks.syncProject).not.toHaveBeenCalled();
    expect(mocks.livePortImports).toBe(0);
    expect(mocks.liveReaderImports).toBe(0);
  });
});

describe("useLiveWorkLayerPort", () => {
  beforeEach(() => {
    mocks.project.current = { id: "p1" };
    mocks.hostProjectId = null;
    mocks.lastSelector = null;
    mocks.syncProject.mockClear();
    mocks.syncProject.mockImplementation((projectId: string | null) => {
      mocks.hostProjectId = projectId;
    });
    mocks.requestScan.mockClear();
    mocks.livePortImports = 0;
    mocks.liveReaderImports = 0;
    vi.stubEnv("DEV", true);
    vi.stubEnv("VITE_WORK_LAYER_FIXTURE", "false");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("selects only the id of the current project, and only when it has a project row", () => {
    const state = (id: string) => ({
      currentProjectId: id,
      projects: [{ id }],
    });
    renderHook(() => useLiveWorkLayerPort(true));
    expect(mocks.lastSelector?.(state("p1"))).toBe("p1");
    // Only the id (a primitive) is selected: renaming a project changes nothing.
    expect(
      mocks.lastSelector?.({
        currentProjectId: "p1",
        projects: [{ id: "p1", name: "renamed" }],
      }),
    ).toBe("p1");
    // The placeholder id used when no project is open has no project row.
    expect(
      mocks.lastSelector?.({ currentProjectId: "placeholder", projects: [] }),
    ).toBeNull();
  });

  it("keeps fixture mode ahead of live even when both are set", () => {
    vi.stubEnv("VITE_WORK_LAYER_FIXTURE", "true");
    const { result } = renderHook(() => useLiveWorkLayerPort(true));
    expect(result.current).toBeNull();
    expect(mocks.syncProject).not.toHaveBeenCalled();
    expect(mocks.livePortImports).toBe(0);
    expect(mocks.liveReaderImports).toBe(0);
  });

  it("does not create a port when no real project row exists", () => {
    mocks.project.current = undefined;
    const { result } = renderHook(() => useLiveWorkLayerPort(true));
    expect(result.current).toBeNull();
    expect(mocks.syncProject).not.toHaveBeenCalled();
    expect(mocks.livePortImports).toBe(0);
    expect(mocks.liveReaderImports).toBe(0);
  });

  it("does not import or synchronize while the Work Layer is inactive", () => {
    const { result } = renderHook(() => useLiveWorkLayerPort(false));
    expect(result.current).toBeNull();
    expect(mocks.syncProject).not.toHaveBeenCalled();
    expect(mocks.livePortImports).toBe(0);
    expect(mocks.liveReaderImports).toBe(0);
  });

  it("creates and synchronizes a live port for an active real project", async () => {
    const { result } = renderHook(() => useLiveWorkLayerPort(true));

    await waitFor(() => expect(result.current?.scopeKey).toBe("p1"));
    expect(result.current?.kind).toBe("live");
    expect(mocks.syncProject).toHaveBeenCalledWith("p1");
  });

  it("disposes the previous port and creates a new one when project changes", async () => {
    const { result, rerender } = renderHook(() => useLiveWorkLayerPort(true));
    await waitFor(() => expect(result.current?.scopeKey).toBe("p1"));
    const oldPort = result.current!;
    const dispose = vi.spyOn(oldPort, "dispose");

    act(() => {
      mocks.project.current = { id: "p2" };
      rerender();
    });
    expect(result.current).toBeNull();
    await waitFor(() => expect(result.current?.scopeKey).toBe("p2"));
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(mocks.syncProject).toHaveBeenLastCalledWith("p2");
  });
});
