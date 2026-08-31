// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { db } from "@/db/client";
import { projects } from "@/db/schema";
import { eq } from "drizzle-orm";
import {
  _activateProjectBackgroundIntegrationsForTests,
  _resetProjectBackgroundMutationsForTests,
  _scheduleExternalWriteFeedStartForTests,
  _scheduleTimelapseInitializationForTests,
  LAST_ACTIVE_PROJECT_KEY,
  useProjectStore,
} from "./projectStore";
import { PROJECT_ID } from "./constants";
import { useGlobalHistoryStore } from "@/store/globalHistoryStore";
import { useSettingsStore } from "@/features/settings/settingsStore";
import { usePhaseStore } from "@/features/codex/phaseStore";
import * as projectApi from "./api";
import type { Project } from "./api";
import {
  _resetQuiescenceLeasesForTests,
  acquireQuiescenceLease,
  canScheduleQuiescenceMutation,
  isQuiescenceLeaseActive,
} from "@/application/lifecycle/quiescenceLease";
import { createCloseQuiescenceController } from "@/application/lifecycle/closeQuiescenceController";
import {
  getCurrentWorkspaceIdentity,
  setCurrentWorkspaceIdentity,
} from "@/runtime/workspaceIdentity";
import {
  flushQuiescenceProviderStage,
  registerQuiescenceProvider,
} from "@/lib/quiescenceProviders";
import {
  acquireWorkspaceProjectLoadLease,
  resetProjectLoadGateForTests,
} from "./projectLoadGate";
import { useWorkspaceStore } from "@/features/workspace/store";
import { enqueueIpc, resetIpcQueueForTests } from "@/lib/ipcQueue";
import i18next from "@/lib/i18n";
import { registerProjectRuntime } from "@/application/project/projectRuntime";
import { projectRuntimeComposition } from "@/application/composition/projectRuntimeComposition";
import {
  LIFECYCLE_TRACE_OPT_IN_KEY,
  subscribeLifecycleTrace,
  type LifecycleTraceEvent,
} from "@/application/lifecycle/lifecycleTrace";

const backgroundH = vi.hoisted(() => ({
  startExternalWriteFeed: vi.fn(async () => {}),
  stopExternalWriteFeed: vi.fn(),
  setupAutoAcceptProseConsumer: vi.fn(),
  drainProposedProse: vi.fn(async () => {}),
  flushTimelapse: vi.fn(async () => {}),
  setRecorderEnabled: vi.fn(),
  initRecorderForProject: vi.fn(async () => true),
  isTimelapseEnabled: vi.fn(async () => true),
  ensureGenesisBaselines: vi.fn(async () => {}),
  seedWorkspaceSnapshot: vi.fn(async () => {}),
}));

const projectToastH = vi.hoisted(() => ({
  error: vi.fn(),
  warning: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: projectToastH,
}));

vi.mock("./reloadProjectData", () => ({
  reloadProjectData: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./seedCodexTypes", () => ({
  seedCodexTypesFromProject: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/features/codex/typeApi", () => ({
  ensureBuiltinTypes: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/features/settings/migration", () => ({
  seedProjectSettingsFromDefaults: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/features/settings/api", () => ({
  setProjectSetting: vi.fn().mockResolvedValue(undefined),
  getSetting: vi.fn().mockResolvedValue(null),
  setSetting: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/features/concurrency/externalWriteFeed", () => ({
  startExternalWriteFeed: backgroundH.startExternalWriteFeed,
  stopExternalWriteFeed: backgroundH.stopExternalWriteFeed,
}));

vi.mock("@/features/agent-writes/autoAcceptFeed", () => ({
  setupAutoAcceptProseConsumer: backgroundH.setupAutoAcceptProseConsumer,
  drainProposedProse: backgroundH.drainProposedProse,
}));

vi.mock("@/features/timelapse/recorder", () => ({
  flushNow: backgroundH.flushTimelapse,
  getRecorderSessionId: vi.fn(() => "project-store-test-session"),
  setRecorderEnabled: backgroundH.setRecorderEnabled,
  initRecorderForProject: backgroundH.initRecorderForProject,
}));

vi.mock("@/features/timelapse/toggle", () => ({
  isTimelapseEnabled: backgroundH.isTimelapseEnabled,
  ensureGenesisBaselines: backgroundH.ensureGenesisBaselines,
}));

vi.mock("@/features/timelapse/seedSession", () => ({
  seedWorkspaceSnapshot: backgroundH.seedWorkspaceSnapshot,
}));

import { reloadProjectData } from "./reloadProjectData";
import { seedCodexTypesFromProject } from "./seedCodexTypes";
import { ensureBuiltinTypes } from "@/features/codex/typeApi";
import { getSetting, setSetting } from "@/features/settings/api";

const mockedReload = vi.mocked(reloadProjectData);
const mockedSeed = vi.mocked(seedCodexTypesFromProject);
const mockedEnsureBuiltin = vi.mocked(ensureBuiltinTypes);
const mockedGetSetting = vi.mocked(getSetting);
const mockedSetSetting = vi.mocked(setSetting);

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(async () => {
  registerProjectRuntime(projectRuntimeComposition);
  _resetQuiescenceLeasesForTests();
  resetIpcQueueForTests();
  resetProjectLoadGateForTests();
  _resetProjectBackgroundMutationsForTests();
  setCurrentWorkspaceIdentity(null);
  mockedReload.mockReset();
  mockedReload.mockImplementation(
    async (_projectId, beforeCommit, _workspaceRevision, afterCommit) => {
      if (beforeCommit?.() === false) {
        return { cancelled: true, degraded: [] };
      }
      afterCommit?.();
      return { cancelled: false, degraded: [] };
    },
  );
  mockedSeed.mockClear();
  mockedEnsureBuiltin.mockClear();
  mockedGetSetting.mockReset();
  mockedGetSetting.mockResolvedValue(null);
  mockedSetSetting.mockReset();
  mockedSetSetting.mockResolvedValue(undefined);
  backgroundH.startExternalWriteFeed.mockReset();
  backgroundH.startExternalWriteFeed.mockResolvedValue(undefined);
  backgroundH.stopExternalWriteFeed.mockReset();
  backgroundH.setupAutoAcceptProseConsumer.mockReset();
  backgroundH.drainProposedProse.mockReset();
  backgroundH.drainProposedProse.mockResolvedValue(undefined);
  backgroundH.flushTimelapse.mockReset();
  backgroundH.flushTimelapse.mockResolvedValue(undefined);
  backgroundH.setRecorderEnabled.mockReset();
  backgroundH.initRecorderForProject.mockReset();
  backgroundH.initRecorderForProject.mockResolvedValue(true);
  backgroundH.isTimelapseEnabled.mockReset();
  backgroundH.isTimelapseEnabled.mockResolvedValue(true);
  backgroundH.ensureGenesisBaselines.mockReset();
  backgroundH.ensureGenesisBaselines.mockResolvedValue(undefined);
  backgroundH.seedWorkspaceSnapshot.mockReset();
  backgroundH.seedWorkspaceSnapshot.mockResolvedValue(undefined);
  projectToastH.error.mockReset();
  projectToastH.warning.mockReset();
  useProjectStore.setState({
    currentProjectId: null,
    projects: [],
    projectLoadStatus: "idle",
    degradedParticipants: [],
  });
  useGlobalHistoryStore.getState().clear();
  await db.delete(projects);
  const now = new Date().toISOString();
  await db.insert(projects).values({
    id: PROJECT_ID,
    title: "Default Novel",
    createdAt: now,
    updatedAt: now,
  });
});

describe("useProjectStore", () => {
  describe("Project background mutations", () => {
    it("defers same-path integration binding until the new Workspace identity is published", async () => {
      useProjectStore.setState({ currentProjectId: PROJECT_ID });
      setCurrentWorkspaceIdentity(null);

      _activateProjectBackgroundIntegrationsForTests(PROJECT_ID);
      await Promise.resolve();
      expect(backgroundH.initRecorderForProject).not.toHaveBeenCalled();
      expect(backgroundH.startExternalWriteFeed).not.toHaveBeenCalled();

      setCurrentWorkspaceIdentity({
        path: "/same-workspace",
        openRevision: 12,
      });
      await flushQuiescenceProviderStage("scoped-mutations");

      expect(backgroundH.initRecorderForProject).toHaveBeenCalledWith(
        PROJECT_ID,
      );
      expect(backgroundH.startExternalWriteFeed).toHaveBeenCalledWith(
        PROJECT_ID,
      );
      expect(backgroundH.drainProposedProse).toHaveBeenCalledWith(
        PROJECT_ID,
        expect.any(Function),
      );
    });

    it("starts integration binding immediately when a new-path identity is already published", async () => {
      useProjectStore.setState({ currentProjectId: PROJECT_ID });
      setCurrentWorkspaceIdentity({
        path: "/new-workspace",
        openRevision: 1,
      });

      _activateProjectBackgroundIntegrationsForTests(PROJECT_ID);
      await flushQuiescenceProviderStage("scoped-mutations");

      expect(backgroundH.initRecorderForProject).toHaveBeenCalledWith(
        PROJECT_ID,
      );
      expect(backgroundH.startExternalWriteFeed).toHaveBeenCalledWith(
        PROJECT_ID,
      );
    });

    it("strict quiescence waits for the external prose backlog drain", async () => {
      const drain = deferred<void>();
      backgroundH.drainProposedProse.mockReturnValueOnce(drain.promise);
      useProjectStore.setState({ currentProjectId: PROJECT_ID });

      _scheduleExternalWriteFeedStartForTests(PROJECT_ID);
      await vi.waitFor(() =>
        expect(backgroundH.drainProposedProse).toHaveBeenCalledOnce(),
      );

      let settled = false;
      const flush = flushQuiescenceProviderStage("scoped-mutations").then(
        () => {
          settled = true;
        },
      );
      await Promise.resolve();
      expect(settled).toBe(false);

      drain.resolve();
      await flush;
      expect(settled).toBe(true);
    });

    it("stops a late feed start before draining after authority changes", async () => {
      const start = deferred<void>();
      backgroundH.startExternalWriteFeed.mockReturnValueOnce(start.promise);
      useProjectStore.setState({ currentProjectId: PROJECT_ID });

      _scheduleExternalWriteFeedStartForTests(PROJECT_ID);
      await vi.waitFor(() =>
        expect(backgroundH.startExternalWriteFeed).toHaveBeenCalledOnce(),
      );
      useProjectStore.setState({ currentProjectId: "new-project" });
      start.resolve();
      await flushQuiescenceProviderStage("scoped-mutations");

      expect(backgroundH.stopExternalWriteFeed).toHaveBeenCalledOnce();
      expect(backgroundH.drainProposedProse).not.toHaveBeenCalled();
    });

    it("propagates a previous-Project timelapse drain failure and does not rebind", async () => {
      backgroundH.flushTimelapse.mockRejectedValueOnce(
        new Error("timelapse drain failed"),
      );
      setCurrentWorkspaceIdentity({
        path: "/workspace/project-store-test",
        openRevision: 1,
      });
      useProjectStore.setState({ currentProjectId: PROJECT_ID });

      _scheduleTimelapseInitializationForTests(PROJECT_ID);

      await expect(
        flushQuiescenceProviderStage("scoped-mutations"),
      ).rejects.toThrow("timelapse drain failed");
      expect(backgroundH.setRecorderEnabled).not.toHaveBeenCalled();
      expect(backgroundH.initRecorderForProject).not.toHaveBeenCalled();
      await expect(
        flushQuiescenceProviderStage("scoped-mutations"),
      ).resolves.toBeUndefined();
    });
  });

  describe("initCurrentProject", () => {
    it("sets currentProjectId from the first project row", async () => {
      await useProjectStore.getState().initCurrentProject();
      expect(useProjectStore.getState().currentProjectId).toBe(PROJECT_ID);
      expect(useProjectStore.getState().projects).toHaveLength(1);
    });

    it("restores last active project from app_settings when valid", async () => {
      const now = new Date().toISOString();
      await db.insert(projects).values({
        id: "proj-b",
        title: "Second Novel",
        createdAt: now,
        updatedAt: now,
      });
      mockedGetSetting.mockResolvedValue("proj-b");

      await useProjectStore.getState().initCurrentProject();

      expect(useProjectStore.getState().currentProjectId).toBe("proj-b");
    });

    it("falls back to first project when saved id is missing", async () => {
      const now = new Date().toISOString();
      await db.insert(projects).values({
        id: "proj-b",
        title: "Second Novel",
        createdAt: now,
        updatedAt: now,
      });
      mockedGetSetting.mockResolvedValue("deleted-project");

      await useProjectStore.getState().initCurrentProject();

      expect(useProjectStore.getState().currentProjectId).toBe(PROJECT_ID);
    });

    it("propagates a Project list failure instead of publishing a fallback", async () => {
      const previous = await projectApi.getProject(PROJECT_ID);
      expect(previous).toBeDefined();
      useProjectStore.setState({
        currentProjectId: PROJECT_ID,
        projects: [previous!],
      });
      const listProjectsSpy = vi
        .spyOn(projectApi, "listProjects")
        .mockRejectedValueOnce(new Error("project list unavailable"));

      try {
        await expect(
          useProjectStore.getState().initCurrentProject(),
        ).rejects.toThrow("project list unavailable");
        expect(useProjectStore.getState().currentProjectId).toBe(PROJECT_ID);
        expect(useProjectStore.getState().projects).toEqual([previous]);
      } finally {
        listProjectsSpy.mockRestore();
      }
    });

    it("propagates a last-active lookup failure as mandatory hydration", async () => {
      mockedGetSetting.mockRejectedValueOnce(
        new Error("last active Project unavailable"),
      );

      await expect(
        useProjectStore.getState().initCurrentProject(),
      ).rejects.toThrow("last active Project unavailable");
      expect(useProjectStore.getState().currentProjectId).toBeNull();
      expect(useProjectStore.getState().projects).toEqual([]);
    });
  });

  describe("refreshProjects", () => {
    it("does not publish a deferred response from a previous Workspace", async () => {
      const defaultProject = await projectApi.getProject(PROJECT_ID);
      expect(defaultProject).toBeDefined();
      const staleProject = { ...defaultProject!, id: "workspace-a-project" };
      const currentProject = { ...defaultProject!, id: "workspace-b-project" };
      const lookup = deferred<Project[]>();
      const listProjectsSpy = vi
        .spyOn(projectApi, "listProjects")
        .mockReturnValueOnce(lookup.promise);

      try {
        setCurrentWorkspaceIdentity({ path: "/workspace-a", openRevision: 1 });
        const refresh = useProjectStore.getState().refreshProjects();
        await vi.waitFor(() => expect(listProjectsSpy).toHaveBeenCalledOnce());

        setCurrentWorkspaceIdentity({ path: "/workspace-b", openRevision: 2 });
        useProjectStore.setState({ projects: [currentProject] });
        lookup.resolve([staleProject]);
        await refresh;

        expect(useProjectStore.getState().projects).toEqual([currentProject]);
      } finally {
        listProjectsSpy.mockRestore();
      }
    });

    it("does not publish across a same-path Workspace reopen revision", async () => {
      const defaultProject = await projectApi.getProject(PROJECT_ID);
      expect(defaultProject).toBeDefined();
      const staleProject = { ...defaultProject!, id: "before-reopen" };
      const currentProject = { ...defaultProject!, id: "after-reopen" };
      const lookup = deferred<Project[]>();
      const listProjectsSpy = vi
        .spyOn(projectApi, "listProjects")
        .mockReturnValueOnce(lookup.promise);

      try {
        setCurrentWorkspaceIdentity({
          path: "/same-workspace",
          openRevision: 7,
        });
        const refresh = useProjectStore.getState().refreshProjects();
        await vi.waitFor(() => expect(listProjectsSpy).toHaveBeenCalledOnce());

        setCurrentWorkspaceIdentity({
          path: "/same-workspace",
          openRevision: 8,
        });
        useProjectStore.setState({ projects: [currentProject] });
        lookup.resolve([staleProject]);
        await refresh;

        expect(useProjectStore.getState().projects).toEqual([currentProject]);
      } finally {
        listProjectsSpy.mockRestore();
      }
    });
  });

  describe("loadProject", () => {
    it("does not start a Project load while data deletion is active", async () => {
      const getProjectSpy = vi.spyOn(projectApi, "getProject");
      const dataDeleteLease = acquireQuiescenceLease("data-delete");

      try {
        await expect(
          useProjectStore.getState().loadProject(PROJECT_ID),
        ).rejects.toThrow(
          "Cannot start project-load while data deletion is active",
        );
        expect(getProjectSpy).not.toHaveBeenCalled();
        expect(mockedReload).not.toHaveBeenCalled();
      } finally {
        dataDeleteLease.release();
        getProjectSpy.mockRestore();
      }
    });

    it("uses the Workspace-owned no-preflush path and stamps the target revision", async () => {
      const now = new Date().toISOString();
      await db.insert(projects).values({
        id: "proj-b",
        title: "Project B",
        createdAt: now,
        updatedAt: now,
      });
      await useProjectStore.getState().initCurrentProject();
      const unregister = registerQuiescenceProvider({
        id: "workspace-owned-project-hydrate-test",
        stage: "autosave",
        flush: async () => {
          throw new Error("old editor must not be flushed after swap");
        },
      });
      const workspaceLease = await acquireWorkspaceProjectLoadLease(() => {});

      try {
        await expect(
          useProjectStore
            .getState()
            .loadProjectWithinLifecycle(
              "proj-b",
              workspaceLease.projectLoadContext,
              {
                skipStrictQuiescence: true,
                workspaceOpenRevision: 42,
              },
            ),
        ).resolves.toBeUndefined();
        expect(mockedReload).toHaveBeenCalledWith(
          "proj-b",
          expect.any(Function),
          42,
          expect.any(Function),
        );
        expect(useProjectStore.getState().currentProjectId).toBe("proj-b");
      } finally {
        workspaceLease.release();
        unregister();
      }
    });

    it("holds the destructive lease through commit so window-close waits", async () => {
      const now = new Date().toISOString();
      await db.insert(projects).values({
        id: "proj-b",
        title: "Project B",
        createdAt: now,
        updatedAt: now,
      });
      const project = await projectApi.getProject("proj-b");
      expect(project).toBeDefined();
      const lookup = deferred<Project | undefined>();
      const getProjectSpy = vi
        .spyOn(projectApi, "getProject")
        .mockImplementation((id) =>
          id === "proj-b" ? lookup.promise : Promise.resolve(undefined),
        );

      try {
        const loading = useProjectStore.getState().loadProject("proj-b");
        await vi.waitFor(() =>
          expect(getProjectSpy).toHaveBeenCalledWith("proj-b"),
        );
        expect(isQuiescenceLeaseActive()).toBe(true);
        const closeFlush = vi.fn(async () => {});
        const close = vi.fn(async () => {});
        const closeController = createCloseQuiescenceController({
          hasImmediateVeto: () => false,
          flush: closeFlush,
          close,
          onFailure: vi.fn(),
        });
        closeController.handleCloseRequest({ preventDefault: vi.fn() });
        await Promise.resolve();
        expect(closeFlush).not.toHaveBeenCalled();

        lookup.resolve(project);
        await loading;
        await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
        expect(closeFlush).toHaveBeenCalledOnce();
        expect(isQuiescenceLeaseActive()).toBe(false);
      } finally {
        getProjectSpy.mockRestore();
      }
    });

    it("sets currentProjectId, applies metadata, and reloads stores", async () => {
      const now = new Date().toISOString();
      await db.insert(projects).values({
        id: "proj-b",
        title: "Second Novel",
        language: "en",
        phaseResolutionMode: "reading",
        createdAt: now,
        updatedAt: now,
      });
      await useProjectStore.getState().refreshProjects();

      await useProjectStore.getState().loadProject("proj-b");

      expect(useProjectStore.getState().currentProjectId).toBe("proj-b");
      expect(document.documentElement.lang).toBe("en");
      expect(mockedReload).toHaveBeenCalledWith(
        "proj-b",
        expect.any(Function),
        undefined,
        expect.any(Function),
      );
      expect(mockedSetSetting).toHaveBeenCalledWith(
        "workspace.lastActiveProjectId",
        "proj-b",
      );
    });

    it("traces the successful Project transition through hydration with one id", async () => {
      const now = new Date().toISOString();
      await db.insert(projects).values({
        id: "proj-b",
        title: "Second Novel",
        createdAt: now,
        updatedAt: now,
      });
      setCurrentWorkspaceIdentity({
        path: "/novel",
        openRevision: 4,
      });
      useProjectStore.setState({ currentProjectId: PROJECT_ID });
      const events: LifecycleTraceEvent[] = [];
      Object.assign(globalThis, {
        [LIFECYCLE_TRACE_OPT_IN_KEY]: true,
      });
      const unsubscribe = subscribeLifecycleTrace((event) => {
        if (event.kind === "project") events.push(event);
      });

      try {
        await useProjectStore.getState().loadProject("proj-b");

        expect(events.map((event) => event.phase)).toEqual([
          "switch-requested",
          "quiescence-started",
          "authority-commit",
          "new-scope-hydrated",
        ]);
        expect(new Set(events.map((event) => event.transitionId)).size).toBe(1);
        expect(events[0]).toMatchObject({
          from: {
            workspacePath: "/novel",
            workspaceOpenRevision: 4,
            projectId: PROJECT_ID,
          },
          to: {
            workspacePath: "/novel",
            workspaceOpenRevision: 4,
            projectId: "proj-b",
          },
        });
        expect(events.at(-1)?.to.projectId).toBe("proj-b");
        expect(useProjectStore.getState().projectLoadStatus).toBe("ready");
      } finally {
        unsubscribe();
        Reflect.deleteProperty(globalThis, LIFECYCLE_TRACE_OPT_IN_KEY);
      }
    });

    it("switching project clears undo history even when reloadProjectData is mocked", async () => {
      const now = new Date().toISOString();
      await db.insert(projects).values({
        id: "proj-b",
        title: "Second Novel",
        createdAt: now,
        updatedAt: now,
      });
      useGlobalHistoryStore.getState().push({
        kind: "scenes",
        label: "old project edit",
        entityId: "scene-a",
        undo: async () => {},
        redo: async () => {},
      });
      expect(useGlobalHistoryStore.getState().past).toHaveLength(1);

      await useProjectStore.getState().loadProject("proj-b");

      expect(useGlobalHistoryStore.getState().past).toHaveLength(0);
      expect(useGlobalHistoryStore.getState().future).toHaveLength(0);
    });

    it("preserves the complete old Project state when critical preparation fails", async () => {
      const now = new Date().toISOString();
      await db.insert(projects).values({
        id: "proj-b",
        title: "Project B",
        language: "en",
        phaseResolutionMode: "story",
        createdAt: now,
        updatedAt: now,
      });
      document.documentElement.lang = "ja";
      useSettingsStore.getState().applyProjectLanguage("ja");
      usePhaseStore.getState().setResolutionMode("reading");
      useProjectStore.setState({
        currentProjectId: PROJECT_ID,
        projectLoadStatus: "degraded",
        degradedParticipants: ["old-optional-surface"],
      });
      useGlobalHistoryStore.getState().push({
        kind: "scenes",
        label: "old project edit",
        entityId: "scene-old",
        undo: async () => {},
        redo: async () => {},
      });
      mockedReload.mockRejectedValueOnce(
        new Error("critical tree preparation failed"),
      );

      await expect(
        useProjectStore.getState().loadProject("proj-b"),
      ).rejects.toThrow("critical tree preparation failed");

      expect(useProjectStore.getState()).toMatchObject({
        currentProjectId: PROJECT_ID,
        projectLoadStatus: "degraded",
        degradedParticipants: ["old-optional-surface"],
      });
      expect(document.documentElement.lang).toBe("ja");
      expect(useSettingsStore.getState().projectLanguage).toBe("ja");
      expect(usePhaseStore.getState().resolutionMode).toBe("reading");
      expect(useGlobalHistoryStore.getState().past).toHaveLength(1);
      expect(mockedSetSetting).not.toHaveBeenCalled();
      expect(isQuiescenceLeaseActive()).toBe(false);
    });

    it("keeps the committed Project and reports degradation when last-active persistence fails", async () => {
      const now = new Date().toISOString();
      await db.insert(projects).values({
        id: "proj-b",
        title: "Project B",
        language: "en",
        phaseResolutionMode: "story",
        createdAt: now,
        updatedAt: now,
      });
      useProjectStore.setState({
        currentProjectId: PROJECT_ID,
        projectLoadStatus: "ready",
      });
      mockedSetSetting.mockRejectedValueOnce(
        new Error("settings persistence unavailable"),
      );

      await expect(
        useProjectStore.getState().loadProject("proj-b"),
      ).resolves.toBeUndefined();

      expect(useProjectStore.getState()).toMatchObject({
        currentProjectId: "proj-b",
        projectLoadStatus: "degraded",
        degradedParticipants: ["last-active-project"],
      });
      expect(document.documentElement.lang).toBe("en");
      expect(useSettingsStore.getState().projectLanguage).toBe("en");
      expect(usePhaseStore.getState().resolutionMode).toBe("story");
      expect(mockedReload).toHaveBeenCalledTimes(1);
      expect(mockedReload).toHaveBeenCalledWith(
        "proj-b",
        expect.any(Function),
        undefined,
        expect.any(Function),
      );
    });

    it("terminates a rejected degraded toast retry and reports one switch failure", async () => {
      const now = new Date().toISOString();
      await db.insert(projects).values({
        id: "proj-b",
        title: "Project B",
        createdAt: now,
        updatedAt: now,
      });
      mockedSetSetting.mockRejectedValueOnce(
        new Error("settings persistence unavailable"),
      );

      await useProjectStore.getState().loadProject("proj-b");

      const warningOptions = projectToastH.warning.mock.calls.at(-1)?.[1] as
        | { action?: { onClick?: () => void } }
        | undefined;
      expect(warningOptions?.action?.onClick).toEqual(expect.any(Function));

      mockedReload.mockRejectedValueOnce(new Error("retry load unavailable"));
      warningOptions?.action?.onClick?.();

      await vi.waitFor(() => {
        expect(mockedReload).toHaveBeenCalledTimes(2);
        expect(projectToastH.error).toHaveBeenCalledTimes(1);
      });
      expect(projectToastH.error).toHaveBeenCalledWith(
        i18next.t("project.switchFailed"),
      );
    });

    it("fully reloads the old Project after an unexpected post-commit failure", async () => {
      const now = new Date().toISOString();
      await db
        .update(projects)
        .set({ language: "ja", phaseResolutionMode: "reading" })
        .where(eq(projects.id, PROJECT_ID));
      await db.insert(projects).values({
        id: "proj-b",
        title: "Project B",
        language: "en",
        phaseResolutionMode: "story",
        createdAt: now,
        updatedAt: now,
      });
      document.documentElement.lang = "ja";
      useSettingsStore.getState().applyProjectLanguage("ja");
      usePhaseStore.getState().setResolutionMode("reading");
      useProjectStore.setState({
        currentProjectId: PROJECT_ID,
        projectLoadStatus: "ready",
      });
      mockedReload.mockImplementation(
        async (projectId, beforeCommit, _workspaceRevision, afterCommit) => {
          if (beforeCommit?.() === false) {
            return { cancelled: true, degraded: [] };
          }
          if (projectId === "proj-b") {
            throw new Error("critical hydration failed after commit");
          }
          afterCommit?.();
          return { cancelled: false, degraded: [] };
        },
      );

      await expect(
        useProjectStore.getState().loadProject("proj-b"),
      ).rejects.toThrow("critical hydration failed after commit");

      expect(mockedReload.mock.calls.map(([projectId]) => projectId)).toEqual([
        "proj-b",
        PROJECT_ID,
      ]);
      expect(mockedReload.mock.calls[1]?.[1]).toEqual(expect.any(Function));
      expect(useProjectStore.getState()).toMatchObject({
        currentProjectId: PROJECT_ID,
        projectLoadStatus: "ready",
        degradedParticipants: [],
      });
      expect(document.documentElement.lang).toBe("ja");
      expect(useSettingsStore.getState().projectLanguage).toBe("ja");
      expect(usePhaseStore.getState().resolutionMode).toBe("reading");
      expect(mockedSetSetting).not.toHaveBeenCalled();
    });

    it("reports rollback optional failures as degraded and keeps retry available", async () => {
      const now = new Date().toISOString();
      await db.insert(projects).values({
        id: "proj-b",
        title: "Project B",
        language: "en",
        phaseResolutionMode: "story",
        createdAt: now,
        updatedAt: now,
      });
      useProjectStore.setState({
        currentProjectId: PROJECT_ID,
        projectLoadStatus: "ready",
        degradedParticipants: [],
      });
      mockedReload.mockImplementation(
        async (projectId, beforeCommit, _workspaceRevision, afterCommit) => {
          if (beforeCommit?.() === false) {
            return { cancelled: true, degraded: [] };
          }
          if (projectId === "proj-b") {
            throw new Error("critical hydration failed after commit");
          }
          afterCommit?.();
          return {
            cancelled: false,
            degraded: [
              {
                participantId: "old-optional-surface",
                error: new Error("optional panel unavailable"),
              },
            ],
          };
        },
      );

      await expect(
        useProjectStore.getState().loadProject("proj-b"),
      ).rejects.toThrow("critical hydration failed after commit");

      expect(useProjectStore.getState()).toMatchObject({
        currentProjectId: PROJECT_ID,
        projectLoadStatus: "degraded",
        degradedParticipants: ["old-optional-surface"],
      });
      expect(mockedReload.mock.calls.map(([projectId]) => projectId)).toEqual([
        "proj-b",
        PROJECT_ID,
      ]);
    });

    it("keeps the latest project authoritative when lookups finish in reverse order", async () => {
      const now = new Date().toISOString();
      await db.insert(projects).values([
        {
          id: "proj-a",
          title: "Project A",
          language: "ja",
          phaseResolutionMode: "reading",
          createdAt: now,
          updatedAt: now,
        },
        {
          id: "proj-b",
          title: "Project B",
          language: "en",
          phaseResolutionMode: "story",
          createdAt: now,
          updatedAt: now,
        },
      ]);
      const projectA = await projectApi.getProject("proj-a");
      const projectB = await projectApi.getProject("proj-b");
      expect(projectA).toBeDefined();
      expect(projectB).toBeDefined();

      const lookupA = deferred<Project | undefined>();
      const lookupB = deferred<Project | undefined>();
      const getProjectSpy = vi
        .spyOn(projectApi, "getProject")
        .mockImplementation((id) => {
          if (id === "proj-a") return lookupA.promise;
          if (id === "proj-b") return lookupB.promise;
          return Promise.resolve(undefined);
        });

      document.documentElement.lang = "ja";
      useSettingsStore.getState().applyProjectLanguage("ja");
      usePhaseStore.getState().setResolutionMode("reading");

      try {
        const loadA = useProjectStore.getState().loadProject("proj-a");
        await vi.waitFor(() => {
          expect(getProjectSpy).toHaveBeenCalledWith("proj-a");
        });
        const loadB = useProjectStore.getState().loadProject("proj-b");

        lookupB.resolve(projectB);
        await loadB;
        lookupA.resolve(projectA);
        await loadA;

        expect(useProjectStore.getState().currentProjectId).toBe("proj-b");
        expect(document.documentElement.lang).toBe("en");
        expect(useSettingsStore.getState().projectLanguage).toBe("en");
        expect(usePhaseStore.getState().resolutionMode).toBe("story");
        expect(mockedReload).toHaveBeenCalledTimes(1);
        expect(mockedReload).toHaveBeenCalledWith(
          "proj-b",
          expect.any(Function),
          undefined,
          expect.any(Function),
        );
        expect(mockedSetSetting).toHaveBeenCalledTimes(1);
        expect(mockedSetSetting).toHaveBeenCalledWith(
          LAST_ACTIVE_PROJECT_KEY,
          "proj-b",
        );
      } finally {
        getProjectSpy.mockRestore();
      }
    });

    it("waits for every earlier Project preflush before opening the latest target read phase", async () => {
      const now = new Date().toISOString();
      await db.insert(projects).values({
        id: "proj-b",
        title: "Project B",
        language: "en",
        createdAt: now,
        updatedAt: now,
      });
      const projectB = await projectApi.getProject("proj-b");
      expect(projectB).toBeDefined();

      const firstPreflush = deferred<void>();
      const targetRead = deferred<Project | undefined>();
      let preflushCount = 0;
      const unregister = registerQuiescenceProvider({
        id: "overlapping-project-preflush-order",
        stage: "autosave",
        flush: async () => {
          preflushCount += 1;
          if (preflushCount === 1) await firstPreflush.promise;
        },
      });
      const getProjectSpy = vi
        .spyOn(projectApi, "getProject")
        .mockImplementation((id) => {
          if (id === "proj-b") {
            return enqueueIpc(
              "latest-project-target-read",
              () => targetRead.promise,
              10_000,
              "read",
            );
          }
          return Promise.resolve(undefined);
        });
      let staleLoad: Promise<void> | null = null;
      let latestLoad: Promise<void> | null = null;

      try {
        staleLoad = useProjectStore.getState().loadProject("proj-a");
        await vi.waitFor(() => expect(preflushCount).toBe(1));

        latestLoad = useProjectStore.getState().loadProject("proj-b");
        await new Promise((resolve) => setTimeout(resolve, 0));

        // If the second preflush overtakes the first, the first one's final
        // ipc-actual-tasks stage can later cancel this load's target read.
        expect(preflushCount).toBe(1);
        expect(canScheduleQuiescenceMutation()).toBe(false);

        firstPreflush.resolve();
        await vi.waitFor(() => {
          expect(preflushCount).toBe(2);
          expect(getProjectSpy).toHaveBeenCalledWith("proj-b");
        });
        targetRead.resolve(projectB);
        await Promise.all([staleLoad, latestLoad]);

        expect(useProjectStore.getState().currentProjectId).toBe("proj-b");
        expect(mockedReload).toHaveBeenCalledTimes(1);
        expect(canScheduleQuiescenceMutation()).toBe(true);
      } finally {
        firstPreflush.resolve();
        targetRead.resolve(projectB);
        await Promise.allSettled(
          [staleLoad, latestLoad].filter(
            (load): load is Promise<void> => load !== null,
          ),
        );
        getProjectSpy.mockRestore();
        unregister();
      }
    });

    it("does not let a stale lookup failure roll back the latest project", async () => {
      const now = new Date().toISOString();
      await db.insert(projects).values({
        id: "proj-b",
        title: "Project B",
        language: "en",
        createdAt: now,
        updatedAt: now,
      });
      const projectB = await projectApi.getProject("proj-b");
      expect(projectB).toBeDefined();

      const lookupA = deferred<Project | undefined>();
      const getProjectSpy = vi
        .spyOn(projectApi, "getProject")
        .mockImplementation((id) => {
          if (id === "proj-a") return lookupA.promise;
          if (id === "proj-b") return Promise.resolve(projectB);
          return Promise.resolve(undefined);
        });

      try {
        const loadA = useProjectStore.getState().loadProject("proj-a");
        await vi.waitFor(() => {
          expect(getProjectSpy).toHaveBeenCalledWith("proj-a");
        });
        const loadB = useProjectStore.getState().loadProject("proj-b");
        await loadB;

        lookupA.reject(new Error("late Project A lookup failure"));
        await expect(loadA).resolves.toBeUndefined();

        expect(useProjectStore.getState().currentProjectId).toBe("proj-b");
        expect(mockedReload).toHaveBeenCalledTimes(1);
        expect(mockedReload).toHaveBeenCalledWith(
          "proj-b",
          expect.any(Function),
          undefined,
          expect.any(Function),
        );
        expect(mockedSetSetting).toHaveBeenCalledTimes(1);
        expect(mockedSetSetting).toHaveBeenCalledWith(
          LAST_ACTIVE_PROJECT_KEY,
          "proj-b",
        );
      } finally {
        getProjectSpy.mockRestore();
      }
    });

    it("restores the last stable status when a superseding Project lookup fails", async () => {
      const now = new Date().toISOString();
      await db.insert(projects).values({
        id: "proj-a",
        title: "Project A",
        language: "ja",
        createdAt: now,
        updatedAt: now,
      });
      const projectA = await projectApi.getProject("proj-a");
      expect(projectA).toBeDefined();

      const lookupA = deferred<Project | undefined>();
      const getProjectSpy = vi
        .spyOn(projectApi, "getProject")
        .mockImplementation((id) => {
          if (id === "proj-a") return lookupA.promise;
          if (id === "missing-project") return Promise.resolve(undefined);
          return projectApi.getProject(id);
        });
      useProjectStore.setState({
        currentProjectId: PROJECT_ID,
        projectLoadStatus: "degraded",
        degradedParticipants: ["old-optional-surface"],
      });

      try {
        const staleLoad = useProjectStore.getState().loadProject("proj-a");
        await vi.waitFor(() => {
          expect(getProjectSpy).toHaveBeenCalledWith("proj-a");
          expect(useProjectStore.getState().projectLoadStatus).toBe("loading");
        });

        await expect(
          useProjectStore.getState().loadProject("missing-project"),
        ).rejects.toThrow("Project not found: missing-project");

        expect(useProjectStore.getState()).toMatchObject({
          currentProjectId: PROJECT_ID,
          projectLoadStatus: "degraded",
          degradedParticipants: ["old-optional-surface"],
        });

        lookupA.resolve(projectA);
        await staleLoad;
        expect(useProjectStore.getState()).toMatchObject({
          currentProjectId: PROJECT_ID,
          projectLoadStatus: "degraded",
          degradedParticipants: ["old-optional-surface"],
        });
      } finally {
        lookupA.resolve(projectA);
        getProjectSpy.mockRestore();
      }
    });

    it("serializes an already-started reload so the latest project commits last", async () => {
      const now = new Date().toISOString();
      await db.insert(projects).values([
        {
          id: "proj-a",
          title: "Project A",
          language: "ja",
          phaseResolutionMode: "reading",
          createdAt: now,
          updatedAt: now,
        },
        {
          id: "proj-b",
          title: "Project B",
          language: "en",
          phaseResolutionMode: "story",
          createdAt: now,
          updatedAt: now,
        },
      ]);

      const reloadA = deferred<void>();
      mockedReload.mockImplementation(
        async (projectId, beforeCommit, _workspaceRevision, afterCommit) => {
          if (beforeCommit?.() === false) {
            return { cancelled: true, degraded: [] };
          }
          if (projectId === "proj-a") await reloadA.promise;
          afterCommit?.();
          return { cancelled: false, degraded: [] };
        },
      );
      document.documentElement.lang = "ja";
      useSettingsStore.getState().applyProjectLanguage("ja");
      usePhaseStore.getState().setResolutionMode("reading");

      const loadA = useProjectStore.getState().loadProject("proj-a");
      await vi.waitFor(() => {
        expect(mockedReload).toHaveBeenCalledWith(
          "proj-a",
          expect.any(Function),
          undefined,
          expect.any(Function),
        );
      });

      const loadB = useProjectStore.getState().loadProject("proj-b");
      reloadA.resolve();
      await Promise.all([loadA, loadB]);

      expect(mockedReload.mock.calls.map(([id]) => id)).toEqual([
        "proj-a",
        "proj-b",
      ]);
      expect(useProjectStore.getState().currentProjectId).toBe("proj-b");
      expect(document.documentElement.lang).toBe("en");
      expect(useSettingsStore.getState().projectLanguage).toBe("en");
      expect(usePhaseStore.getState().resolutionMode).toBe("story");
      // A became stale while its reload was in flight, so only B is persisted.
      expect(mockedSetSetting).toHaveBeenCalledTimes(1);
      expect(mockedSetSetting).toHaveBeenCalledWith(
        LAST_ACTIVE_PROJECT_KEY,
        "proj-b",
      );
    });
  });

  describe("createNewProject", () => {
    it("does not mutate the Project table when strict quiescence fails", async () => {
      await useProjectStore.getState().initCurrentProject();
      const unregister = registerQuiescenceProvider({
        id: "project-create-veto-test",
        stage: "scoped-mutations",
        flush: async () => {
          throw new Error("pending metadata failed");
        },
      });

      try {
        await expect(
          useProjectStore.getState().createNewProject({
            title: "Must not be created",
          }),
        ).rejects.toThrow("pending metadata failed");
        expect(await projectApi.listProjects()).toHaveLength(1);
        expect(mockedEnsureBuiltin).not.toHaveBeenCalled();
        expect(isQuiescenceLeaseActive()).toBe(false);
      } finally {
        unregister();
      }
    });

    it("holds the Project lifecycle barrier through initialization and switch", async () => {
      await useProjectStore.getState().initCurrentProject();
      const initialize = deferred<void>();
      mockedEnsureBuiltin.mockReturnValueOnce(initialize.promise);

      const creating = useProjectStore.getState().createNewProject({
        title: "Barrier protected",
      });
      await vi.waitFor(() =>
        expect(mockedEnsureBuiltin).toHaveBeenCalledOnce(),
      );

      const closeFlush = vi.fn(async () => {});
      const close = vi.fn(async () => {});
      const closeController = createCloseQuiescenceController({
        hasImmediateVeto: () => false,
        flush: closeFlush,
        close,
        onFailure: vi.fn(),
      });
      closeController.handleCloseRequest({ preventDefault: vi.fn() });
      await Promise.resolve();
      expect(closeFlush).not.toHaveBeenCalled();

      initialize.resolve();
      await creating;
      await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
      expect(closeFlush).toHaveBeenCalledOnce();
      expect(isQuiescenceLeaseActive()).toBe(false);
    });

    it("keeps the old Workspace authority until a post-insert create rollback completes", async () => {
      await useProjectStore.getState().initCurrentProject();
      const oldWorkspaceIdentity = {
        path: "/workspace-before-create",
        openRevision: 4,
      };
      setCurrentWorkspaceIdentity(oldWorkspaceIdentity);
      useWorkspaceStore.setState({
        view: "editor",
        activeWorkspacePath: oldWorkspaceIdentity.path,
        activeWorkspaceName: "Before create",
        workspaceOpenRevision: oldWorkspaceIdentity.openRevision,
        workspaceSwitchInProgress: false,
        workspaceHydrated: true,
        error: null,
      });
      const initialize = deferred<void>();
      mockedEnsureBuiltin.mockReturnValueOnce(initialize.promise);

      const creating = useProjectStore.getState().createNewProject({
        title: "Interrupted create",
      });
      await vi.waitFor(() =>
        expect(mockedEnsureBuiltin).toHaveBeenCalledOnce(),
      );
      const inserted = (await projectApi.listProjects()).find(
        (project) => project.id !== PROJECT_ID,
      );
      expect(inserted?.title).toBe("Interrupted create");

      const opening = useWorkspaceStore
        .getState()
        .openWorkspace("/workspace-after-create");
      await vi.waitFor(() =>
        expect(useWorkspaceStore.getState().workspaceSwitchInProgress).toBe(
          true,
        ),
      );
      expect(getCurrentWorkspaceIdentity()).toEqual(oldWorkspaceIdentity);

      const createFailure = new Error("create initialization interrupted");
      const rejectedCreate = expect(creating).rejects.toThrow(
        "create initialization interrupted",
      );
      initialize.reject(createFailure);
      await rejectedCreate;
      await opening;

      expect(await projectApi.getProject(inserted!.id)).toBeUndefined();
      expect(useWorkspaceStore.getState()).toMatchObject({
        workspaceSwitchInProgress: false,
      });
      expect(isQuiescenceLeaseActive()).toBe(false);
    });

    it("creates a project row and switches to it", async () => {
      await useProjectStore.getState().initCurrentProject();

      const created = await useProjectStore.getState().createNewProject({
        title: "New Series Vol.2",
        language: "ja",
      });

      expect(created.title).toBe("New Series Vol.2");
      expect(useProjectStore.getState().currentProjectId).toBe(created.id);
      expect(
        useProjectStore.getState().projects.some((p) => p.id === created.id),
      ).toBe(true);
      expect(mockedReload).toHaveBeenCalledWith(
        created.id,
        expect.any(Function),
        undefined,
        expect.any(Function),
      );
      expect(mockedEnsureBuiltin).toHaveBeenCalledWith(
        created.id,
        created.language,
      );
    });

    it("seeds selected codex types from the source project", async () => {
      await useProjectStore.getState().initCurrentProject();

      await useProjectStore.getState().createNewProject({
        title: "Seeded Vol",
        seedFromProjectId: PROJECT_ID,
        seedTypeSlugs: ["character", "location"],
      });

      expect(mockedSeed).toHaveBeenCalledWith(PROJECT_ID, expect.any(String), [
        "character",
        "location",
      ]);
    });
  });

  describe("deleteProjectById", () => {
    it("does not delete when strict quiescence fails", async () => {
      const now = new Date().toISOString();
      await db.insert(projects).values({
        id: "proj-preserved",
        title: "Preserved",
        createdAt: now,
        updatedAt: now,
      });
      await useProjectStore.getState().initCurrentProject();
      const unregister = registerQuiescenceProvider({
        id: "project-delete-veto-test",
        stage: "scoped-mutations",
        flush: async () => {
          throw new Error("pending write failed");
        },
      });

      try {
        await expect(
          useProjectStore.getState().deleteProjectById("proj-preserved"),
        ).rejects.toThrow("pending write failed");
        expect(await projectApi.getProject("proj-preserved")).toBeDefined();
        expect(isQuiescenceLeaseActive()).toBe(false);
      } finally {
        unregister();
      }
    });

    it("keeps the current Project row when replacement hydrate fails after commit", async () => {
      const now = new Date().toISOString();
      await db.insert(projects).values({
        id: "proj-current",
        title: "Current",
        createdAt: now,
        updatedAt: now,
      });
      await useProjectStore.getState().initCurrentProject();
      await useProjectStore.getState().loadProject("proj-current");
      mockedReload.mockClear();
      const deleteSpy = vi.spyOn(projectApi, "deleteProject");
      mockedReload.mockImplementation(
        async (
          loadedProjectId,
          beforeCommit,
          _workspaceRevision,
          afterCommit,
        ) => {
          if (beforeCommit?.() === false) {
            return { cancelled: true, degraded: [] };
          }
          if (loadedProjectId === PROJECT_ID) {
            throw new Error("replacement critical hydrate failed");
          }
          afterCommit?.();
          return { cancelled: false, degraded: [] };
        },
      );

      try {
        await expect(
          useProjectStore.getState().deleteProjectById("proj-current"),
        ).rejects.toThrow("replacement critical hydrate failed");

        expect(await projectApi.getProject("proj-current")).toBeDefined();
        expect(deleteSpy).not.toHaveBeenCalled();
        expect(mockedReload.mock.calls.map(([id]) => id)).toEqual([
          PROJECT_ID,
          "proj-current",
        ]);
        expect(useProjectStore.getState()).toMatchObject({
          currentProjectId: "proj-current",
          projectLoadStatus: "ready",
        });
      } finally {
        deleteSpy.mockRestore();
      }
    });

    it("waits for replacement background drains before deleting the old Project", async () => {
      const now = new Date().toISOString();
      await db.insert(projects).values({
        id: "proj-current",
        title: "Current",
        createdAt: now,
        updatedAt: now,
      });
      await useProjectStore.getState().initCurrentProject();
      await useProjectStore.getState().loadProject("proj-current");
      setCurrentWorkspaceIdentity({
        path: "/workspace/project-store-test",
        openRevision: 1,
      });
      mockedReload.mockClear();
      const drain = deferred<void>();
      backgroundH.flushTimelapse.mockReturnValueOnce(drain.promise);
      mockedReload.mockImplementation(
        async (
          loadedProjectId,
          beforeCommit,
          _workspaceRevision,
          afterCommit,
        ) => {
          if (beforeCommit?.() === false) {
            return { cancelled: true, degraded: [] };
          }
          if (loadedProjectId === PROJECT_ID) {
            _scheduleTimelapseInitializationForTests(PROJECT_ID);
          }
          afterCommit?.();
          return { cancelled: false, degraded: [] };
        },
      );
      const deleteSpy = vi.spyOn(projectApi, "deleteProject");

      try {
        const deleting = useProjectStore
          .getState()
          .deleteProjectById("proj-current");
        await vi.waitFor(() =>
          expect(backgroundH.flushTimelapse).toHaveBeenCalledOnce(),
        );
        expect(deleteSpy).not.toHaveBeenCalled();

        drain.resolve();
        await deleting;

        expect(deleteSpy).toHaveBeenCalledWith("proj-current");
        expect(await projectApi.getProject("proj-current")).toBeUndefined();
        expect(useProjectStore.getState().currentProjectId).toBe(PROJECT_ID);
      } finally {
        deleteSpy.mockRestore();
      }
    });

    it("refuses to delete the last remaining project", async () => {
      await useProjectStore.getState().initCurrentProject();

      await expect(
        useProjectStore.getState().deleteProjectById(PROJECT_ID),
      ).rejects.toThrow(/last project/i);
    });

    it("deletes a non-current project without switching", async () => {
      const now = new Date().toISOString();
      await db.insert(projects).values({
        id: "proj-extra",
        title: "Extra",
        createdAt: now,
        updatedAt: now,
      });
      await useProjectStore.getState().initCurrentProject();

      await useProjectStore.getState().deleteProjectById("proj-extra");

      expect(
        useProjectStore.getState().projects.some((p) => p.id === "proj-extra"),
      ).toBe(false);
      expect(useProjectStore.getState().currentProjectId).toBe(PROJECT_ID);
    });

    it("switches to another project when deleting the current one", async () => {
      const now = new Date().toISOString();
      await db.insert(projects).values({
        id: "proj-other",
        title: "Other",
        createdAt: now,
        updatedAt: now,
      });
      await useProjectStore.getState().initCurrentProject();
      await useProjectStore.getState().loadProject("proj-other");
      mockedReload.mockClear();

      await useProjectStore.getState().deleteProjectById("proj-other");

      expect(useProjectStore.getState().currentProjectId).toBe(PROJECT_ID);
      expect(mockedReload).toHaveBeenCalledWith(
        PROJECT_ID,
        expect.any(Function),
        undefined,
        expect.any(Function),
      );
    });
  });
});
