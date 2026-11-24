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

import { useWorkLayerLivePort } from "./useWorkLayerLivePort";

describe("useWorkLayerLivePort", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.project.current = { id: "p1" };
    mocks.hostProjectId = null;
    mocks.syncProject.mockClear();
    mocks.syncProject.mockImplementation((projectId: string | null) => {
      mocks.hostProjectId = projectId;
    });
    mocks.requestScan.mockClear();
    mocks.livePortImports = 0;
    mocks.liveReaderImports = 0;
    vi.stubEnv("DEV", true);
    vi.stubEnv("VITE_WORK_LAYER_LIVE", "false");
    vi.stubEnv("VITE_WORK_LAYER_FIXTURE", "false");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("does not import readers or sync a project while the live flag is closed", () => {
    const { result } = renderHook(() => useWorkLayerLivePort(true));
    expect(result.current).toBeNull();
    expect(mocks.syncProject).not.toHaveBeenCalled();
    expect(mocks.livePortImports).toBe(0);
    expect(mocks.liveReaderImports).toBe(0);
  });

  it("selects a constant while the flag is closed, so project changes never re-render the provider", () => {
    const state = (id: string) => ({
      currentProjectId: id,
      projects: [{ id }],
    });
    renderHook(() => useWorkLayerLivePort(true));
    expect(mocks.lastSelector?.(state("p1"))).toBeNull();
    expect(mocks.lastSelector?.(state("p2"))).toBeNull();

    vi.stubEnv("VITE_WORK_LAYER_LIVE", "true");
    renderHook(() => useWorkLayerLivePort(true));
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

  it("keeps fixture mode ahead of live even when both flags are set", () => {
    vi.stubEnv("VITE_WORK_LAYER_LIVE", "true");
    vi.stubEnv("VITE_WORK_LAYER_FIXTURE", "true");
    const { result } = renderHook(() => useWorkLayerLivePort(true));
    expect(result.current).toBeNull();
    expect(mocks.syncProject).not.toHaveBeenCalled();
    expect(mocks.livePortImports).toBe(0);
    expect(mocks.liveReaderImports).toBe(0);
  });

  it("does not create a port when no real project row exists", () => {
    vi.stubEnv("VITE_WORK_LAYER_LIVE", "1");
    mocks.project.current = undefined;
    const { result } = renderHook(() => useWorkLayerLivePort(true));
    expect(result.current).toBeNull();
    expect(mocks.syncProject).not.toHaveBeenCalled();
    expect(mocks.livePortImports).toBe(0);
    expect(mocks.liveReaderImports).toBe(0);
  });

  it("does not import or synchronize while the Work Layer is inactive", () => {
    vi.stubEnv("VITE_WORK_LAYER_LIVE", "true");
    const { result } = renderHook(() => useWorkLayerLivePort(false));
    expect(result.current).toBeNull();
    expect(mocks.syncProject).not.toHaveBeenCalled();
    expect(mocks.livePortImports).toBe(0);
    expect(mocks.liveReaderImports).toBe(0);
  });

  it("creates and synchronizes a live port for an active real project", async () => {
    vi.stubEnv("VITE_WORK_LAYER_LIVE", "true");
    const { result } = renderHook(() => useWorkLayerLivePort(true));

    await waitFor(() => expect(result.current?.scopeKey).toBe("p1"));
    expect(result.current?.kind).toBe("live");
    expect(mocks.syncProject).toHaveBeenCalledWith("p1");
  });

  it("disposes the previous port and creates a new one when project changes", async () => {
    vi.stubEnv("VITE_WORK_LAYER_LIVE", "1");
    const { result, rerender } = renderHook(() => useWorkLayerLivePort(true));
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
