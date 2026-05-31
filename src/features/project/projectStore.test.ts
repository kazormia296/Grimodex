// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { db } from "@/db/client";
import { projects } from "@/db/schema";
import { useProjectStore } from "./projectStore";
import { PROJECT_ID } from "./constants";

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
}));

import { reloadProjectData } from "./reloadProjectData";
import { seedCodexTypesFromProject } from "./seedCodexTypes";
import { ensureBuiltinTypes } from "@/features/codex/typeApi";

const mockedReload = vi.mocked(reloadProjectData);
const mockedSeed = vi.mocked(seedCodexTypesFromProject);
const mockedEnsureBuiltin = vi.mocked(ensureBuiltinTypes);

beforeEach(async () => {
  mockedReload.mockClear();
  mockedSeed.mockClear();
  mockedEnsureBuiltin.mockClear();
  useProjectStore.setState({
    currentProjectId: null,
    projects: [],
  });
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
  describe("initCurrentProject", () => {
    it("sets currentProjectId from the first project row", async () => {
      await useProjectStore.getState().initCurrentProject();
      expect(useProjectStore.getState().currentProjectId).toBe(PROJECT_ID);
      expect(useProjectStore.getState().projects).toHaveLength(1);
    });
  });

  describe("loadProject", () => {
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
      expect(mockedReload).toHaveBeenCalledWith("proj-b");
    });
  });

  describe("createNewProject", () => {
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
      expect(mockedReload).toHaveBeenCalledWith(created.id);
      expect(mockedEnsureBuiltin).toHaveBeenCalledWith(created.id);
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
      expect(mockedReload).toHaveBeenCalledWith(PROJECT_ID);
    });
  });
});
