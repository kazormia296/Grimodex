import { beforeEach, describe, expect, it, vi } from "vitest";

const { identityMock, toggleMock, recorderMock, seedMock } = vi.hoisted(() => ({
  identityMock: vi.fn<() => { path: string; openRevision: number } | null>(
    () => ({
      path: "/workspace/captured.gdx",
      openRevision: 7,
    }),
  ),
  toggleMock: {
    isTimelapseEnabled: vi.fn(async () => true),
    ensureGenesisBaselines: vi.fn(async () => undefined),
  },
  recorderMock: {
    flushNow: vi.fn(async () => undefined),
    setRecorderEnabled: vi.fn(),
    initRecorderForProject: vi.fn(async () => true),
  },
  seedMock: vi.fn(async () => undefined),
}));

vi.mock("@/runtime/workspaceIdentity", () => ({
  getCurrentWorkspaceIdentity: identityMock,
}));
vi.mock("@/features/codex/phaseStore", () => ({
  usePhaseStore: { getState: () => ({ setResolutionMode: vi.fn() }) },
}));
vi.mock("@/features/settings/settingsStore", () => ({
  useSettingsStore: {
    getState: () => ({
      projectLanguage: "ja",
      applyProjectLanguage: vi.fn(),
    }),
  },
}));
vi.mock("@/features/timelapse/timelapseAdmin", () => toggleMock);
vi.mock("@/features/timelapse/recorder", () => recorderMock);
vi.mock("@/features/timelapse/seedSession", () => ({
  seedWorkspaceSnapshot: seedMock,
}));

import { projectRuntimeComposition } from "./projectRuntimeComposition";

describe("projectRuntimeComposition.initializeTimelapse", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    identityMock.mockReturnValue({
      path: "/workspace/captured.gdx",
      openRevision: 7,
    });
    toggleMock.isTimelapseEnabled.mockResolvedValue(true);
    recorderMock.initRecorderForProject.mockResolvedValue(true);
  });

  it("captures the published Workspace identity once for the genesis activation", async () => {
    await projectRuntimeComposition.initializeTimelapse({
      projectId: "p1",
      canStart: () => true,
      isMutationCurrent: () => true,
    });

    expect(identityMock).toHaveBeenCalledTimes(1);
    expect(toggleMock.ensureGenesisBaselines).toHaveBeenCalledWith(
      "p1",
      "/workspace/captured.gdx",
      expect.any(Function),
    );
  });

  it("does not start when no published Workspace identity exists", async () => {
    identityMock.mockReturnValue(null);

    await projectRuntimeComposition.initializeTimelapse({
      projectId: "p1",
      canStart: () => true,
      isMutationCurrent: () => true,
    });

    expect(recorderMock.flushNow).not.toHaveBeenCalled();
    expect(toggleMock.ensureGenesisBaselines).not.toHaveBeenCalled();
  });
});
