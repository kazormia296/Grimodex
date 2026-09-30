// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  initializeTimelapse: vi.fn(),
  toastWarning: vi.fn(),
}));

vi.mock("./api", () => ({
  listProjects: vi.fn(async () => []),
  getProject: vi.fn(async () => undefined),
  createProject: vi.fn(),
  deleteProject: vi.fn(),
}));
vi.mock("@/features/codex/typeApi", () => ({
  ensureBuiltinTypes: vi.fn(),
}));
vi.mock("@/features/editor/inlineAi/pendingGuard", () => ({
  guardInlineAiPending: vi.fn(),
}));
vi.mock("@/features/license/gate", () => ({
  blockIfUnlicensed: () => false,
  LICENSE_WRITE_RESTRICTED_ERROR: "write restricted",
}));
vi.mock("@/store/globalHistoryStore", () => ({
  useGlobalHistoryStore: {
    getState: () => ({ clear: vi.fn() }),
  },
}));
vi.mock("@/application/lifecycle/quiescenceCoordinator", () => ({
  flushStrictQuiescence: vi.fn(async () => undefined),
}));
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), warning: mocks.toastWarning },
}));
vi.mock("@/lib/i18n", () => ({
  default: { t: (key: string) => key, changeLanguage: vi.fn() },
}));
vi.mock("./projectLoadGate", () => ({
  withProjectLoad: (run: (context: { owner: string }) => unknown) =>
    run({ owner: "project" }),
}));
vi.mock("@/features/editor/editorSaveRegistry", () => ({
  clearRetainedEditorRecoveryDraftsForScopeChange: vi.fn(),
}));
vi.mock("./projectLoadFailure", () => ({
  runProjectLoadWithFailureToast: (run: () => unknown) => run(),
}));

import {
  _resetProjectBackgroundMutationsForTests,
  _presentTimelapseGenesisFailureForTests,
  _scheduleTimelapseInitializationForTests,
  useProjectStore,
} from "./projectStore";
import { publishCurrentProjectId } from "@/application/project/currentProjectAuthority";
import { registerProjectRuntime } from "@/application/project/projectRuntime";
import { flushQuiescenceProviderStage } from "@/lib/quiescenceProviders";
import { setCurrentWorkspaceIdentity } from "@/runtime/workspaceIdentity";

beforeEach(() => {
  vi.clearAllMocks();
  _resetProjectBackgroundMutationsForTests();
  setCurrentWorkspaceIdentity({
    path: "/workspace/genesis-retry",
    openRevision: 1,
  });
  publishCurrentProjectId("project-1");
  useProjectStore.setState({ currentProjectId: "project-1" });
  registerProjectRuntime({
    applyMetadata: vi.fn(),
    getFallbackLanguage: () => null,
    prepareExternalWriteFeedStop: vi.fn(async () => vi.fn()),
    initializeTimelapse: mocks.initializeTimelapse,
    startExternalWriteFeed: vi.fn(async () => undefined),
  });
});

describe("Project timelapse genesis retry quiescence", () => {
  it("publishes one degraded participant and one retry action for a late ordinary failure", () => {
    useProjectStore.setState({
      currentProjectId: "project-1",
      projectLoadStatus: "ready",
      degradedParticipants: [],
    });

    _presentTimelapseGenesisFailureForTests("project-1");
    _presentTimelapseGenesisFailureForTests("project-1");

    expect(useProjectStore.getState()).toMatchObject({
      projectLoadStatus: "degraded",
      degradedParticipants: ["timelapse-genesis"],
    });
    expect(mocks.toastWarning).toHaveBeenCalledOnce();
    expect(mocks.toastWarning.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        action: expect.objectContaining({ onClick: expect.any(Function) }),
      }),
    );
  });

  it("does not replay E1 or E2 into strict quiescence after a successful retry", async () => {
    const error1 = new Error("genesis E1");
    const error2 = new Error("genesis E2");
    mocks.initializeTimelapse
      .mockRejectedValueOnce(error1)
      .mockRejectedValueOnce(error2)
      .mockResolvedValueOnce(undefined);

    _scheduleTimelapseInitializationForTests("project-1");
    await flushQuiescenceProviderStage("scoped-mutations");
    _scheduleTimelapseInitializationForTests("project-1");
    await flushQuiescenceProviderStage("scoped-mutations");
    _scheduleTimelapseInitializationForTests("project-1");

    await expect(
      flushQuiescenceProviderStage("scoped-mutations"),
    ).resolves.toBeUndefined();
    expect(mocks.initializeTimelapse).toHaveBeenCalledTimes(3);
  });
});
