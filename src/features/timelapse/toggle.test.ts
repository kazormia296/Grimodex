// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";

const { dbDelete } = vi.hoisted(() => {
  const dbWhere = vi.fn(() => Promise.resolve());
  const dbDelete = vi.fn((_table: unknown) => ({ where: dbWhere }));
  return { dbDelete };
});
const recorderMock = vi.hoisted(() => ({
  flushNow: vi.fn(() => Promise.resolve()),
  initRecorderForProject: vi.fn(() => Promise.resolve()),
  resetRecorderChain: vi.fn(),
  setRecorderEnabled: vi.fn(),
}));
const snapshotsMock = vi.hoisted(() => ({
  recordStateSnapshot: vi.fn(() => Promise.resolve()),
}));
const settingsMock = vi.hoisted(() => ({
  getProjectSetting: vi.fn(() => Promise.resolve<string | null>(null)),
  setProjectSetting: vi.fn(() => Promise.resolve()),
}));
const treeMock = vi.hoisted(() => ({
  listAllNodes: vi.fn(() => Promise.resolve([] as unknown[])),
  loadSceneContent: vi.fn(() => Promise.resolve("{}")),
}));

vi.mock("@/db/client", () => ({
  db: {
    delete: dbDelete,
    select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
  },
}));
vi.mock("./recorder", () => recorderMock);
vi.mock("./seedSession", () => ({
  seedWorkspaceSnapshot: vi.fn(() => Promise.resolve()),
}));
vi.mock("./snapshots", () => snapshotsMock);
vi.mock("@/features/settings/api", () => settingsMock);
vi.mock("@/features/tree/api", () => treeMock);

import { changeEvents, stateSnapshots } from "@/db/schema";
import {
  setTimelapseEnabled,
  purgeTimelapseHistory,
  isTimelapseEnabled,
} from "./toggle";

beforeEach(() => {
  vi.clearAllMocks();
  settingsMock.getProjectSetting.mockResolvedValue(null);
  treeMock.listAllNodes.mockResolvedValue([]);
  treeMock.loadSceneContent.mockResolvedValue('{"type":"doc"}');
});

describe("setTimelapseEnabled", () => {
  it("enable: flushes, wipes both tables, resets, re-genesis, baselines scenes, persists true", async () => {
    treeMock.listAllNodes.mockResolvedValue([
      { id: "s1", nodeType: "scene" },
      { id: "n1", nodeType: "note" },
      { id: "s2", nodeType: "scene" },
    ]);

    await setTimelapseEnabled("p1", true);

    expect(recorderMock.flushNow).toHaveBeenCalled();
    const deleted = dbDelete.mock.calls.map((c) => c[0]);
    expect(deleted).toContain(changeEvents);
    expect(deleted).toContain(stateSnapshots);
    expect(recorderMock.resetRecorderChain).toHaveBeenCalled();
    expect(recorderMock.setRecorderEnabled).toHaveBeenCalledWith(true);
    expect(recorderMock.initRecorderForProject).toHaveBeenCalledWith("p1");
    // baseline only for the two scene nodes (note skipped)
    expect(snapshotsMock.recordStateSnapshot).toHaveBeenCalledTimes(2);
    expect(snapshotsMock.recordStateSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "p1",
        domain: "editor",
        entityType: "scene",
        entityId: "s1",
        anchorSequence: 0,
      }),
    );
    expect(settingsMock.setProjectSetting).toHaveBeenCalledWith(
      "p1",
      "timelapse.enabled",
      "true",
    );
  });

  it("disable: flushes, stops, persists false, no wipe / no baseline", async () => {
    await setTimelapseEnabled("p1", false);

    expect(recorderMock.flushNow).toHaveBeenCalled();
    expect(recorderMock.setRecorderEnabled).toHaveBeenCalledWith(false);
    expect(dbDelete).not.toHaveBeenCalled();
    expect(snapshotsMock.recordStateSnapshot).not.toHaveBeenCalled();
    expect(settingsMock.setProjectSetting).toHaveBeenCalledWith(
      "p1",
      "timelapse.enabled",
      "false",
    );
  });
});

describe("isTimelapseEnabled", () => {
  it("defaults ON when no row exists (legacy projects)", async () => {
    settingsMock.getProjectSetting.mockResolvedValue(null);
    expect(await isTimelapseEnabled("p1")).toBe(true);
  });

  it("is OFF only for an explicit 'false'", async () => {
    settingsMock.getProjectSetting.mockResolvedValue("false");
    expect(await isTimelapseEnabled("p1")).toBe(false);
  });

  it("is ON for 'true'", async () => {
    settingsMock.getProjectSetting.mockResolvedValue("true");
    expect(await isTimelapseEnabled("p1")).toBe(true);
  });
});

describe("purgeTimelapseHistory", () => {
  it("recording on: wipes and re-baselines", async () => {
    settingsMock.getProjectSetting.mockResolvedValue("true");
    treeMock.listAllNodes.mockResolvedValue([{ id: "s1", nodeType: "scene" }]);

    await purgeTimelapseHistory("p1");

    expect(dbDelete).toHaveBeenCalled();
    expect(recorderMock.resetRecorderChain).toHaveBeenCalled();
    expect(recorderMock.setRecorderEnabled).toHaveBeenCalledWith(true);
    expect(snapshotsMock.recordStateSnapshot).toHaveBeenCalledTimes(1);
  });

  it("recording off: wipes only, no re-arm / no baseline", async () => {
    settingsMock.getProjectSetting.mockResolvedValue("false");

    await purgeTimelapseHistory("p1");

    expect(dbDelete).toHaveBeenCalled();
    expect(recorderMock.resetRecorderChain).toHaveBeenCalled();
    expect(recorderMock.setRecorderEnabled).not.toHaveBeenCalled();
    expect(snapshotsMock.recordStateSnapshot).not.toHaveBeenCalled();
  });
});
