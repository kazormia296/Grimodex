// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";

const { dbDelete, dbSelectWhere } = vi.hoisted(() => {
  const dbWhere = vi.fn(() => Promise.resolve());
  const dbDelete = vi.fn((_table: unknown) => ({ where: dbWhere }));
  // countTimelapseEvents resolves db.select().from().where() to a rows array;
  // override per-test to simulate genesis (empty) vs recorded history.
  const dbSelectWhere = vi.fn(() => Promise.resolve([] as unknown[]));
  return { dbDelete, dbSelectWhere };
});
const recorderMock = vi.hoisted(() => ({
  flushNow: vi.fn(() => Promise.resolve()),
  initRecorderForProject: vi.fn(() => Promise.resolve()),
  resetRecorderChain: vi.fn(),
  setRecorderEnabled: vi.fn(),
}));
const snapshotsMock = vi.hoisted(() => ({
  recordStateSnapshot: vi.fn(() => Promise.resolve()),
  loadLatestSnapshot: vi.fn(() => Promise.resolve<unknown>(null)),
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
    select: () => ({ from: () => ({ where: dbSelectWhere }) }),
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
  ensureGenesisBaselines,
} from "./toggle";

beforeEach(() => {
  vi.clearAllMocks();
  settingsMock.getProjectSetting.mockResolvedValue(null);
  treeMock.listAllNodes.mockResolvedValue([]);
  treeMock.loadSceneContent.mockResolvedValue('{"type":"doc"}');
  dbSelectWhere.mockResolvedValue([]);
  snapshotsMock.loadLatestSnapshot.mockResolvedValue(null);
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

describe("ensureGenesisBaselines", () => {
  it("genesis (no events, no baseline): bakes anchor=0 baselines for scenes only", async () => {
    dbSelectWhere.mockResolvedValue([]); // 0 recorded events
    snapshotsMock.loadLatestSnapshot.mockResolvedValue(null); // no baseline yet
    treeMock.listAllNodes.mockResolvedValue([
      { id: "s1", nodeType: "scene" },
      { id: "n1", nodeType: "note" },
      { id: "s2", nodeType: "scene" },
    ]);

    await ensureGenesisBaselines("p1");

    // Scenes only (note skipped), anchored at genesis.
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
  });

  it("past genesis (events exist): does NOT bake — avoids double-applying recorded steps", async () => {
    dbSelectWhere.mockResolvedValue([{ id: 1 }]); // >=1 recorded event
    treeMock.listAllNodes.mockResolvedValue([{ id: "s1", nodeType: "scene" }]);

    await ensureGenesisBaselines("p1");

    expect(snapshotsMock.recordStateSnapshot).not.toHaveBeenCalled();
  });

  it("idempotent: genesis but an editor baseline already exists -> no re-bake", async () => {
    dbSelectWhere.mockResolvedValue([]); // genesis
    snapshotsMock.loadLatestSnapshot.mockResolvedValue({
      domain: "editor",
      entityId: "s1",
      anchorSequence: 0,
      payload: {},
    });
    treeMock.listAllNodes.mockResolvedValue([{ id: "s1", nodeType: "scene" }]);

    await ensureGenesisBaselines("p1");

    expect(snapshotsMock.recordStateSnapshot).not.toHaveBeenCalled();
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
