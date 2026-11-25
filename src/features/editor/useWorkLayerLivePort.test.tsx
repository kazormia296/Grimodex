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
  narrativeMaintenanceStaleProposalCount: vi.fn(),
}));
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

import { useLiveWorkLayerPort } from "./useWorkLayerLivePort";

// 旗は build で定数になる（既定は開く。`false`／`0` で閉じる）。build が選ぶ側 `useWorkLayerLivePort` は、
// 旗を指定しない環境では live の側になる。旗の値ごとの選択は、環境を指定して module を読み直して試験する。
// module を読み直す試験は、負荷が高いと既定の 5 秒を超えうる（hosted CI の既定は 30 秒）。
const RELOAD_TIMEOUT_MS = 30_000;

describe("useWorkLayerLivePort (selected at build time)", () => {
  beforeEach(() => {
    mocks.project.current = { id: "p1" };
    mocks.lastSelector = null;
    mocks.syncProject.mockClear();
    mocks.livePortImports = 0;
    mocks.liveReaderImports = 0;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it(
    "is the live hook when the flag is unset (open by default)",
    async () => {
      // 実行環境の VITE_WORK_LAYER_LIVE に左右されないよう、未指定に戻して module を読み直す。
      vi.stubEnv("VITE_WORK_LAYER_LIVE", undefined);
      vi.resetModules();
      const module = await import("./useWorkLayerLivePort");
      expect(module.useWorkLayerLivePort).toBe(module.useLiveWorkLayerPort);
    },
    RELOAD_TIMEOUT_MS,
  );

  it.each(["true", "1"])(
    "stays the live hook when the flag is %s",
    async (value) => {
      vi.stubEnv("VITE_WORK_LAYER_LIVE", value);
      vi.resetModules();
      const module = await import("./useWorkLayerLivePort");
      expect(module.useWorkLayerLivePort).toBe(module.useLiveWorkLayerPort);
    },
    RELOAD_TIMEOUT_MS,
  );

  it.each(["false", "0"])(
    "returns nothing, subscribes to nothing, and loads nothing when the flag is %s",
    async (value) => {
      vi.stubEnv("VITE_WORK_LAYER_LIVE", value);
      vi.resetModules();
      const module = await import("./useWorkLayerLivePort");
      expect(module.useWorkLayerLivePort).not.toBe(module.useLiveWorkLayerPort);

      const { result } = renderHook(() => module.useWorkLayerLivePort(true));
      expect(result.current).toBeNull();
      // 閉じた build は、project の store も購読しない（作品の変更で再描画しない）。
      expect(mocks.lastSelector).toBeNull();
      expect(mocks.syncProject).not.toHaveBeenCalled();
      expect(mocks.livePortImports).toBe(0);
      expect(mocks.liveReaderImports).toBe(0);
    },
    RELOAD_TIMEOUT_MS,
  );
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
