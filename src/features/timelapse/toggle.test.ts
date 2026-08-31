// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";

interface GenesisBaselineMockInput {
  expectedWorkspacePath: string;
  projectId: string;
  kind: "scene" | "codex" | "snippet";
  entityIds: readonly string[];
  anchorTimestamp: number;
}

interface GenesisBaselineMockResult {
  insertedCount: number;
  skippedExistingBaselineCount: number;
  skippedExistingBodyStepCount: number;
  completed: boolean;
}

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
  appendGenesisBaselines: vi.fn<
    (
      input: GenesisBaselineMockInput,
      isAuthoritative?: () => boolean,
    ) => Promise<GenesisBaselineMockResult>
  >(async () => ({
    insertedCount: 0,
    skippedExistingBaselineCount: 0,
    skippedExistingBodyStepCount: 0,
    completed: true,
  })),
}));
const settingsMock = vi.hoisted(() => ({
  getProjectSetting: vi.fn(() => Promise.resolve<string | null>(null)),
  setProjectSetting: vi.fn(() => Promise.resolve()),
}));
const treeMock = vi.hoisted(() => {
  const loadSceneContent = vi.fn(() => Promise.resolve("{}"));
  return {
    listAllNodes: vi.fn(() => Promise.resolve([] as unknown[])),
    loadSceneContent,
    // toggle.ts now batches scene bodies via loadScenesFull; delegate to the
    // loadSceneContent mock so per-test content overrides still apply.
    loadScenesFull: vi.fn(async (ids: string[]) => {
      const out = new Map<
        string,
        { content: string; unplacedBeatsDoc: string }
      >();
      for (const id of ids) {
        out.set(id, {
          content: (await loadSceneContent()) as string,
          unplacedBeatsDoc: "[]",
        });
      }
      return out;
    }),
  };
});
const codexMock = vi.hoisted(() => ({
  listCodexContentsForBaseline: vi.fn(() => Promise.resolve([] as unknown[])),
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
  codexMock.listCodexContentsForBaseline.mockResolvedValue([]);
  codexMock.getCodexEntry.mockResolvedValue({ content: '{"type":"doc"}' });
  snippetMock.listSnippets.mockResolvedValue([]);
  snippetMock.getSnippet.mockResolvedValue({ content: '{"type":"doc"}' });
  dbSelectWhere.mockResolvedValue([]);
  snapshotsMock.appendGenesisBaselines.mockResolvedValue({
    insertedCount: 0,
    skippedExistingBaselineCount: 0,
    skippedExistingBodyStepCount: 0,
    completed: true,
  });
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
    codexMock.listCodexContentsForBaseline.mockResolvedValue([
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
  it("delegates current scene ids to the atomic typed writer", async () => {
    treeMock.listAllNodes.mockResolvedValue([
      { id: "s1", nodeType: "scene" },
      { id: "n1", nodeType: "note" },
      { id: "s2", nodeType: "scene" },
    ]);

    await ensureGenesisBaselines("p1", "/workspace/novel.gdx");

    expect(
      snapshotsMock.appendGenesisBaselines,
    ).toHaveBeenCalledExactlyOnceWith(
      {
        expectedWorkspacePath: "/workspace/novel.gdx",
        projectId: "p1",
        kind: "scene",
        entityIds: ["s1", "s2"],
        anchorTimestamp: expect.any(Number),
      },
      expect.any(Function),
    );
    expect(snapshotsMock.recordStateSnapshot).not.toHaveBeenCalled();
  });

  it("delegates scene/codex/snippet independently under one captured path", async () => {
    treeMock.listAllNodes.mockResolvedValue([{ id: "s1", nodeType: "scene" }]);
    codexMock.listCodexContentsForBaseline.mockResolvedValue([
      { id: "c1", content: '{"type":"doc"}' },
    ]);
    snippetMock.listSnippets.mockResolvedValue([
      { id: "sn1", content: '{"type":"doc"}' },
    ]);

    await ensureGenesisBaselines("p1", "/workspace/captured.gdx");

    expect(snapshotsMock.appendGenesisBaselines).toHaveBeenCalledTimes(3);
    for (const [input] of snapshotsMock.appendGenesisBaselines.mock.calls) {
      expect(input).toEqual(
        expect.objectContaining({
          expectedWorkspacePath: "/workspace/captured.gdx",
          projectId: "p1",
        }),
      );
    }
    expect(snapshotsMock.appendGenesisBaselines).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ kind: "codex", entityIds: ["c1"] }),
      expect.any(Function),
    );
    expect(snapshotsMock.appendGenesisBaselines).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ kind: "snippet", entityIds: ["sn1"] }),
      expect.any(Function),
    );
  });

  it("delegates partial/resume decisions per entity to Native", async () => {
    treeMock.listAllNodes.mockResolvedValue([
      { id: "s1", nodeType: "scene" },
      { id: "s2", nodeType: "scene" },
    ]);
    codexMock.listCodexContentsForBaseline.mockResolvedValue([
      { id: "c1", content: '{"ignored":"renderer-content"}' },
    ]);
    snapshotsMock.appendGenesisBaselines
      .mockResolvedValueOnce({
        insertedCount: 1,
        skippedExistingBaselineCount: 1,
        skippedExistingBodyStepCount: 0,
        completed: true,
      })
      .mockResolvedValueOnce({
        insertedCount: 0,
        skippedExistingBaselineCount: 0,
        skippedExistingBodyStepCount: 1,
        completed: true,
      });

    await ensureGenesisBaselines("p1", "/workspace/novel.gdx");

    expect(snapshotsMock.appendGenesisBaselines).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ kind: "scene", entityIds: ["s1", "s2"] }),
      expect.any(Function),
    );
    expect(snapshotsMock.appendGenesisBaselines).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ kind: "codex", entityIds: ["c1"] }),
      expect.any(Function),
    );
  });

  it("stops before another kind when mutation authority is lost", async () => {
    let authoritative = true;
    treeMock.listAllNodes.mockResolvedValue([{ id: "s1", nodeType: "scene" }]);
    codexMock.listCodexContentsForBaseline.mockResolvedValue([
      { id: "c1", content: "{}" },
    ]);
    snapshotsMock.appendGenesisBaselines.mockImplementation(async () => {
      authoritative = false;
      return {
        insertedCount: 1,
        skippedExistingBaselineCount: 0,
        skippedExistingBodyStepCount: 0,
        completed: false,
      };
    });

    await ensureGenesisBaselines(
      "p1",
      "/workspace/novel.gdx",
      () => authoritative,
    );

    expect(snapshotsMock.appendGenesisBaselines).toHaveBeenCalledTimes(1);
  });

  it("aborts the pass after a live batch failure so the next load resumes", async () => {
    treeMock.listAllNodes.mockResolvedValue([{ id: "s1", nodeType: "scene" }]);
    codexMock.listCodexContentsForBaseline.mockResolvedValue([
      { id: "c1", content: "{}" },
    ]);
    snapshotsMock.appendGenesisBaselines.mockResolvedValue({
      insertedCount: 0,
      skippedExistingBaselineCount: 0,
      skippedExistingBodyStepCount: 0,
      completed: false,
    });

    await ensureGenesisBaselines("p1", "/workspace/novel.gdx");

    expect(snapshotsMock.appendGenesisBaselines).toHaveBeenCalledTimes(1);
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

  it("uses the committed Native sequence instead of the stale renderer head", async () => {
    recorderMock.getRecorderChainHead.mockReturnValue(9);
    treeMock.loadSceneContent.mockResolvedValue('{"type":"doc"}');

    await rebaselineEntitiesAtTail("p1", [{ kind: "scene", id: "s1" }], 12);

    expect(recorderMock.flushNow).toHaveBeenCalled();
    expect(snapshotsMock.recordStateSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ entityId: "s1", anchorSequence: 12 }),
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
