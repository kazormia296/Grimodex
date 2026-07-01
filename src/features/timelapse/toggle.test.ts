// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";

const { dbDelete, dbSelectWhere } = vi.hoisted(() => {
  const dbWhere = vi.fn(() => Promise.resolve());
  const dbDelete = vi.fn((_table: unknown) => ({ where: dbWhere }));
  // Rows for the change_events probe (hasEditorSteps / countTimelapseEvents);
  // override per-test to simulate genesis (empty) vs recorded history.
  const dbSelectWhere = vi.fn(() => Promise.resolve([] as unknown[]));
  return { dbDelete, dbSelectWhere };
});
const recorderMock = vi.hoisted(() => ({
  flushNow: vi.fn(() => Promise.resolve()),
  initRecorderForProject: vi.fn(() => Promise.resolve()),
  resetRecorderChain: vi.fn(),
  setRecorderEnabled: vi.fn(),
  isRecorderEnabled: vi.fn(() => true),
  getRecorderChainHead: vi.fn(() => 0),
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
const codexMock = vi.hoisted(() => ({
  listCodexEntries: vi.fn(() => Promise.resolve([] as unknown[])),
  getCodexEntry: vi.fn(() =>
    Promise.resolve<unknown>({ content: '{"type":"doc"}' }),
  ),
}));
const snippetMock = vi.hoisted(() => ({
  listSnippets: vi.fn(() => Promise.resolve([] as unknown[])),
  getSnippet: vi.fn(() =>
    Promise.resolve<unknown>({ content: '{"type":"doc"}' }),
  ),
}));

vi.mock("@/db/client", () => ({
  db: {
    delete: dbDelete,
    // `where()` is both awaitable (countTimelapseEvents) and chainable via
    // `.limit()` (hasEditorSteps); both resolve to the same rows array.
    select: () => ({
      from: () => ({
        where: () => {
          const rows = dbSelectWhere();
          return Object.assign(rows, { limit: () => rows });
        },
      }),
    }),
  },
}));
vi.mock("./recorder", () => recorderMock);
vi.mock("./seedSession", () => ({
  seedWorkspaceSnapshot: vi.fn(() => Promise.resolve()),
}));
vi.mock("./snapshots", () => snapshotsMock);
vi.mock("@/features/settings/api", () => settingsMock);
vi.mock("@/features/tree/api", () => treeMock);
vi.mock("@/features/codex/api", () => codexMock);
vi.mock("@/features/snippets/api", () => snippetMock);

import { changeEvents, stateSnapshots } from "@/db/schema";
import {
  setTimelapseEnabled,
  purgeTimelapseHistory,
  isTimelapseEnabled,
  ensureGenesisBaselines,
  rebaselineScenesAtTail,
  rebaselineEntitiesAtTail,
} from "./toggle";

beforeEach(() => {
  vi.clearAllMocks();
  settingsMock.getProjectSetting.mockResolvedValue(null);
  treeMock.listAllNodes.mockResolvedValue([]);
  treeMock.loadSceneContent.mockResolvedValue('{"type":"doc"}');
  codexMock.listCodexEntries.mockResolvedValue([]);
  codexMock.getCodexEntry.mockResolvedValue({ content: '{"type":"doc"}' });
  snippetMock.listSnippets.mockResolvedValue([]);
  snippetMock.getSnippet.mockResolvedValue({ content: '{"type":"doc"}' });
  dbSelectWhere.mockResolvedValue([]);
  snapshotsMock.loadLatestSnapshot.mockResolvedValue(null);
  recorderMock.isRecorderEnabled.mockReturnValue(true);
  recorderMock.getRecorderChainHead.mockReturnValue(0);
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

  it("enable: also baselines codex entries and snippets at genesis", async () => {
    treeMock.listAllNodes.mockResolvedValue([{ id: "s1", nodeType: "scene" }]);
    codexMock.listCodexEntries.mockResolvedValue([
      { id: "c1", content: '{"type":"doc"}' },
    ]);
    snippetMock.listSnippets.mockResolvedValue([
      { id: "sn1", content: '{"type":"doc"}' },
    ]);

    await setTimelapseEnabled("p1", true);

    // scene + codex + snippet
    expect(snapshotsMock.recordStateSnapshot).toHaveBeenCalledTimes(3);
    expect(snapshotsMock.recordStateSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        domain: "codex",
        entityType: "codex_entry",
        entityId: "c1",
        anchorSequence: 0,
      }),
    );
    expect(snapshotsMock.recordStateSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        domain: "snippet",
        entityType: "snippet",
        entityId: "sn1",
        anchorSequence: 0,
      }),
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

  it("genesis: also bakes codex/snippet baselines (not just scenes)", async () => {
    dbSelectWhere.mockResolvedValue([]);
    snapshotsMock.loadLatestSnapshot.mockResolvedValue(null);
    treeMock.listAllNodes.mockResolvedValue([{ id: "s1", nodeType: "scene" }]);
    codexMock.listCodexEntries.mockResolvedValue([
      { id: "c1", content: '{"type":"doc"}' },
    ]);
    snippetMock.listSnippets.mockResolvedValue([
      { id: "sn1", content: '{"type":"doc"}' },
    ]);

    await ensureGenesisBaselines("p1");

    expect(snapshotsMock.recordStateSnapshot).toHaveBeenCalledTimes(3);
    expect(snapshotsMock.recordStateSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ domain: "codex", entityId: "c1" }),
    );
    expect(snapshotsMock.recordStateSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ domain: "snippet", entityId: "sn1" }),
    );
  });

  it("baselines a codex added after the first genesis pass (scene already baked)", async () => {
    dbSelectWhere.mockResolvedValue([]); // still genesis (no doc.step)
    // Scene baseline already exists (editor domain); codex/snippet have none.
    snapshotsMock.loadLatestSnapshot.mockImplementation((opts?: unknown) =>
      Promise.resolve(
        (opts as { domain: string }).domain === "editor"
          ? { domain: "editor" }
          : null,
      ),
    );
    treeMock.listAllNodes.mockResolvedValue([{ id: "s1", nodeType: "scene" }]);
    codexMock.listCodexEntries.mockResolvedValue([{ id: "c1", content: "{}" }]);

    await ensureGenesisBaselines("p1");

    // Scene skipped (already baked); the fresh codex is stamped.
    expect(snapshotsMock.recordStateSnapshot).toHaveBeenCalledTimes(1);
    expect(snapshotsMock.recordStateSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ domain: "codex", entityId: "c1" }),
    );
  });

  it("past genesis (events exist): does NOT bake — avoids double-applying recorded steps", async () => {
    dbSelectWhere.mockResolvedValue([{ id: 1 }]); // >=1 recorded event
    treeMock.listAllNodes.mockResolvedValue([{ id: "s1", nodeType: "scene" }]);
    codexMock.listCodexEntries.mockResolvedValue([{ id: "c1" }]);

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

describe("rebaselineScenesAtTail", () => {
  it("flushes then stamps an editor baseline at the CURRENT tail (not genesis) for each scene", async () => {
    recorderMock.getRecorderChainHead.mockReturnValue(87);
    treeMock.loadSceneContent.mockResolvedValue('{"type":"doc","content":[]}');

    await rebaselineScenesAtTail("p1", ["sceneA", "sceneB"]);

    // Must flush first so the caller's meta event is committed and the
    // in-memory head equals the DB tail.
    expect(recorderMock.flushNow).toHaveBeenCalled();
    expect(snapshotsMock.recordStateSnapshot).toHaveBeenCalledTimes(2);
    expect(snapshotsMock.recordStateSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "p1",
        domain: "editor",
        entityType: "scene",
        entityId: "sceneA",
        anchorSequence: 87, // tail, NOT 0 — the whole point of the fix
      }),
    );
    expect(snapshotsMock.recordStateSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ entityId: "sceneB", anchorSequence: 87 }),
    );
  });

  it("no-op when recording is disabled (nothing to keep coherent)", async () => {
    recorderMock.isRecorderEnabled.mockReturnValue(false);

    await rebaselineScenesAtTail("p1", ["sceneA"]);

    expect(recorderMock.flushNow).not.toHaveBeenCalled();
    expect(snapshotsMock.recordStateSnapshot).not.toHaveBeenCalled();
  });

  it("no-op for an empty scene list", async () => {
    await rebaselineScenesAtTail("p1", []);
    expect(recorderMock.flushNow).not.toHaveBeenCalled();
    expect(snapshotsMock.recordStateSnapshot).not.toHaveBeenCalled();
  });

  it("best-effort: one scene's load failure does not abort the rest", async () => {
    recorderMock.getRecorderChainHead.mockReturnValue(5);
    treeMock.loadSceneContent
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce('{"type":"doc"}');

    await rebaselineScenesAtTail("p1", ["bad", "good"]);

    // "bad" threw during loadSceneContent -> skipped; "good" still stamped.
    expect(snapshotsMock.recordStateSnapshot).toHaveBeenCalledTimes(1);
    expect(snapshotsMock.recordStateSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ entityId: "good", anchorSequence: 5 }),
    );
  });
});

describe("rebaselineEntitiesAtTail", () => {
  it("stamps codex/snippet baselines at the tail with the matching domain", async () => {
    recorderMock.getRecorderChainHead.mockReturnValue(42);
    codexMock.getCodexEntry.mockResolvedValue({ content: '{"type":"doc"}' });
    snippetMock.getSnippet.mockResolvedValue({ content: '{"type":"doc"}' });

    await rebaselineEntitiesAtTail("p1", [
      { kind: "codex", id: "c1" },
      { kind: "snippet", id: "sn1" },
    ]);

    expect(recorderMock.flushNow).toHaveBeenCalled();
    expect(snapshotsMock.recordStateSnapshot).toHaveBeenCalledTimes(2);
    expect(snapshotsMock.recordStateSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        domain: "codex",
        entityType: "codex_entry",
        entityId: "c1",
        anchorSequence: 42,
      }),
    );
    expect(snapshotsMock.recordStateSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        domain: "snippet",
        entityType: "snippet",
        entityId: "sn1",
        anchorSequence: 42,
      }),
    );
  });

  it("no-op when recording is disabled or refs empty", async () => {
    recorderMock.isRecorderEnabled.mockReturnValue(false);
    await rebaselineEntitiesAtTail("p1", [{ kind: "codex", id: "c1" }]);
    expect(recorderMock.flushNow).not.toHaveBeenCalled();

    recorderMock.isRecorderEnabled.mockReturnValue(true);
    await rebaselineEntitiesAtTail("p1", []);
    expect(recorderMock.flushNow).not.toHaveBeenCalled();
    expect(snapshotsMock.recordStateSnapshot).not.toHaveBeenCalled();
  });

  it("skips a codex entry that no longer exists (undefined) but stamps the rest", async () => {
    recorderMock.getRecorderChainHead.mockReturnValue(7);
    codexMock.getCodexEntry
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ content: '{"type":"doc"}' });

    await rebaselineEntitiesAtTail("p1", [
      { kind: "codex", id: "gone" },
      { kind: "codex", id: "here" },
    ]);

    expect(snapshotsMock.recordStateSnapshot).toHaveBeenCalledTimes(1);
    expect(snapshotsMock.recordStateSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ entityId: "here", anchorSequence: 7 }),
    );
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
