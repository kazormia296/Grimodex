// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  initializeTimelapse:
    vi.fn<
      (activation: {
        projectId: string;
        expectedWorkspacePath?: string;
        canStart: () => boolean;
        isMutationCurrent: () => boolean;
      }) => Promise<void>
    >(),
  startExternalWriteFeed:
    vi.fn<
      (activation: {
        projectId: string;
        canStart: () => boolean;
        isMutationCurrent: () => boolean;
      }) => Promise<void>
    >(),
}));

vi.mock("@/application/project/projectRuntime", () => ({
  initializeProjectTimelapse: runtime.initializeTimelapse,
  startProjectExternalWriteFeed: runtime.startExternalWriteFeed,
}));

import { flushQuiescenceProviderStage } from "@/lib/quiescenceProviders";
import { publishCurrentProjectId } from "@/application/project/currentProjectAuthority";
import { settleCurrentTimelapseGenesisBeforeQuiescence } from "@/features/timelapse/genesisBarrier";
import { setCurrentWorkspaceIdentity } from "@/runtime/workspaceIdentity";
import {
  createProjectTimelapseLifecycle,
  type ProjectTimelapsePresentation,
} from "./projectTimelapseLifecycle";

let generation = 1;
let currentProjectId = "project-1";
let presentation: ProjectTimelapsePresentation;
const retryProjectLoad = vi.fn();

const lifecycle = createProjectTimelapseLifecycle({
  getCurrentProjectId: () => currentProjectId,
  getLoadGeneration: () => generation,
  isCurrentProjectLoad: (candidate) => candidate === generation,
  retryProjectLoad,
  setProjectPresentation: (updater) => {
    presentation = { ...presentation, ...updater(presentation) };
  },
});

beforeEach(() => {
  generation = 1;
  currentProjectId = "project-1";
  presentation = {
    projectLoadStatus: "ready",
    degradedParticipants: [],
  };
  lifecycle.resetForTests();
  setCurrentWorkspaceIdentity({
    path: "/workspace/project-lifecycle",
    openRevision: 1,
  });
  publishCurrentProjectId(currentProjectId);
  runtime.initializeTimelapse.mockReset().mockResolvedValue(undefined);
  runtime.startExternalWriteFeed.mockReset().mockResolvedValue(undefined);
  retryProjectLoad.mockReset();
});

describe("Project Timelapse lifecycle", () => {
  it("reports an external feed failure through the scoped provider drain", async () => {
    const failure = new Error("feed persistence failed");
    runtime.startExternalWriteFeed.mockRejectedValueOnce(failure);

    lifecycle.scheduleExternalWriteFeedStart("project-1", generation);
    await vi.waitFor(() =>
      expect(runtime.startExternalWriteFeed).toHaveBeenCalledOnce(),
    );

    const rejection = await flushQuiescenceProviderStage(
      "scoped-mutations",
    ).catch((error: unknown) => error);
    expect(rejection).toMatchObject({
      name: "QuiescenceProviderStageError",
    });
    const providerError = (rejection as AggregateError)
      .errors[0] as AggregateError;
    expect(providerError.errors[0]).toBe(failure);
  });

  it("retries a failed genesis through the registered Project callback", async () => {
    const firstFailure = new Error("genesis first failure");
    runtime.initializeTimelapse
      .mockRejectedValueOnce(firstFailure)
      .mockResolvedValueOnce(undefined);
    const firstBarrier = lifecycle.beginGenesisBarrier("project-1");

    await expect(
      lifecycle.scheduleTimelapseInitialization(
        "project-1",
        generation,
        firstBarrier,
      ),
    ).rejects.toBe(firstFailure);

    await expect(
      settleCurrentTimelapseGenesisBeforeQuiescence(),
    ).resolves.toBeUndefined();
    expect(runtime.initializeTimelapse).toHaveBeenCalledTimes(2);
  });

  it("keeps genesis failed when the retry also fails", async () => {
    const firstFailure = new Error("genesis first failure");
    const retryFailure = new Error("genesis retry failure");
    runtime.initializeTimelapse
      .mockRejectedValueOnce(firstFailure)
      .mockRejectedValueOnce(retryFailure);
    const firstBarrier = lifecycle.beginGenesisBarrier("project-1");

    await expect(
      lifecycle.scheduleTimelapseInitialization(
        "project-1",
        generation,
        firstBarrier,
      ),
    ).rejects.toBe(firstFailure);

    await expect(settleCurrentTimelapseGenesisBeforeQuiescence()).rejects.toBe(
      retryFailure,
    );
    expect(runtime.initializeTimelapse).toHaveBeenCalledTimes(2);
  });

  it("defers the feed until the expected workspace identity is published", async () => {
    setCurrentWorkspaceIdentity(null);
    const barrier = lifecycle.beginGenesisBarrier("project-1");
    const timelapseReady = lifecycle.scheduleTimelapseInitialization(
      "project-1",
      generation,
      barrier,
      "/workspace/slow",
    );
    lifecycle.scheduleOrDeferExternalWriteFeedStart(
      "project-1",
      generation,
      timelapseReady,
      "/workspace/slow",
      41,
    );

    await vi.waitFor(() =>
      expect(runtime.initializeTimelapse).toHaveBeenCalledOnce(),
    );
    expect(runtime.startExternalWriteFeed).not.toHaveBeenCalled();

    lifecycle.handleWorkspaceIdentityPublished({
      path: "/workspace/wrong",
      openRevision: 41,
    });
    expect(runtime.startExternalWriteFeed).not.toHaveBeenCalled();

    setCurrentWorkspaceIdentity({ path: "/workspace/slow", openRevision: 41 });
    lifecycle.handleWorkspaceIdentityPublished({
      path: "/workspace/slow",
      openRevision: 41,
    });
    await flushQuiescenceProviderStage("scoped-mutations");
    expect(runtime.startExternalWriteFeed).toHaveBeenCalledOnce();
  });

  it("drops deferred activation when workspace invalidation supersedes rollback", async () => {
    setCurrentWorkspaceIdentity(null);
    lifecycle.activateProjectBackgroundIntegrations("project-1", generation);
    lifecycle.invalidateForWorkspaceSwitch();
    setCurrentWorkspaceIdentity({
      path: "/workspace/replacement",
      openRevision: 2,
    });
    lifecycle.handleWorkspaceIdentityPublished({
      path: "/workspace/replacement",
      openRevision: 2,
    });

    await flushQuiescenceProviderStage("scoped-mutations");
    expect(runtime.initializeTimelapse).not.toHaveBeenCalled();
    expect(runtime.startExternalWriteFeed).not.toHaveBeenCalled();
  });
});
