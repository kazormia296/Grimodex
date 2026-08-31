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

const { dbSelectWhere } = vi.hoisted(() => {
  // Rows for the change_events probe (hasEditorSteps / countTimelapseEvents);
  // override per-test to simulate genesis (empty) vs recorded history.
  const dbSelectWhere = vi.fn(() => Promise.resolve([] as unknown[]));
  return { dbSelectWhere };
});
const recorderMock = vi.hoisted(() => ({
  flushNow: vi.fn(() => Promise.resolve()),
  initRecorderForProject: vi.fn(() => Promise.resolve()),
  resetRecorderChain: vi.fn(),
  setRecorderEnabled: vi.fn(),
  isRecorderEnabled: vi.fn(() => true),
  getRecorderChainHead: vi.fn(() => 0),
  readAuthoritativeChainTail: vi.fn(() => Promise.resolve(0)),
}));
const snapshotsMock = vi.hoisted(() => ({
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
  appendBodyBaselines: vi.fn(async () => ({
    insertedCount: 1,
    skippedExistingCount: 0,
    anchorSequence: 0,
    anchorTimestamp: 1,
    completed: true,
  })),
  purgeTimelapseHistoryNative: vi.fn(() => Promise.resolve()),
}));
const settingsMock = vi.hoisted(() => ({
  getProjectSetting: vi.fn(() => Promise.resolve<string | null>(null)),
  getTimelapseResetSequence: vi.fn(() => Promise.resolve(0)),
  setProjectSetting: vi.fn(() => Promise.resolve()),
  setTimelapseEnabledSetting: vi.fn(() => Promise.resolve()),
}));
const workspaceMock = vi.hoisted(() => {
  const state = { path: "/workspace/novel.gdx", openRevision: 1 };
  return {
    state,
    getCurrentWorkspaceIdentity: vi.fn(() => ({ ...state })),
    isCurrentWorkspaceIdentity: vi.fn(
      (identity: { path: string; openRevision: number }) =>
        identity.path === state.path &&
        identity.openRevision === state.openRevision,
    ),
  };
});
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
vi.mock("@/runtime/workspaceIdentity", () => workspaceMock);
vi.mock("@/features/tree/api", () => treeMock);
vi.mock("@/features/codex/api", () => codexMock);
vi.mock("@/features/snippets/api", () => snippetMock);

import {
  countTimelapseEvents,
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
  settingsMock.getTimelapseResetSequence.mockResolvedValue(0);
  treeMock.listAllNodes.mockResolvedValue([]);
  treeMock.loadSceneContent.mockResolvedValue('{"type":"doc"}');
  codexMock.listCodexContentsForBaseline.mockResolvedValue([]);
  codexMock.getCodexEntry.mockResolvedValue({ content: '{"type":"doc"}' });
  snippetMock.listSnippets.mockResolvedValue([]);
  snippetMock.getSnippet.mockResolvedValue({ content: '{"type":"doc"}' });
  dbSelectWhere.mockResolvedValue([]);
  workspaceMock.state.path = "/workspace/novel.gdx";
  workspaceMock.state.openRevision = 1;
  snapshotsMock.appendGenesisBaselines.mockResolvedValue({
    insertedCount: 0,
    skippedExistingBaselineCount: 0,
    skippedExistingBodyStepCount: 0,
    completed: true,
  });
  recorderMock.isRecorderEnabled.mockReturnValue(true);
  recorderMock.getRecorderChainHead.mockReturnValue(0);
  recorderMock.readAuthoritativeChainTail.mockResolvedValue(0);
  snapshotsMock.appendBodyBaselines.mockResolvedValue({
    insertedCount: 1,
    skippedExistingCount: 0,
    anchorSequence: 0,
    anchorTimestamp: 1,
    completed: true,
  });
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
    expect(snapshotsMock.purgeTimelapseHistoryNative).toHaveBeenCalledWith({
      expectedWorkspacePath: "/workspace/novel.gdx",
      projectId: "p1",
    });
    expect(recorderMock.resetRecorderChain).toHaveBeenCalled();
    expect(recorderMock.setRecorderEnabled).toHaveBeenCalledWith(true);
    expect(recorderMock.initRecorderForProject).toHaveBeenCalledWith("p1");
    // Re-arm baselines are anchored at the authoritative post-purge tail;
    // Native resolves the trusted body bytes from identity-only targets.
    expect(snapshotsMock.appendBodyBaselines).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedWorkspacePath: "/workspace/novel.gdx",
        projectId: "p1",
        targets: [
          { kind: "scene", id: "s1" },
          { kind: "scene", id: "s2" },
        ],
        expectedAnchorSequence: 0,
      }),
      expect.any(Function),
    );
    expect(settingsMock.setTimelapseEnabledSetting).toHaveBeenCalledWith(
      "p1",
      "/workspace/novel.gdx",
      true,
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

    // scene + codex + snippet each use an independent typed identity batch at
    // the authoritative post-purge tail.
    expect(snapshotsMock.appendBodyBaselines).toHaveBeenCalledTimes(3);
    expect(snapshotsMock.appendBodyBaselines).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        targets: [{ kind: "codex", id: "c1" }],
        expectedAnchorSequence: 0,
      }),
      expect.any(Function),
    );
    expect(snapshotsMock.appendBodyBaselines).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        targets: [{ kind: "snippet", id: "sn1" }],
        expectedAnchorSequence: 0,
      }),
      expect.any(Function),
    );
  });

  it("disable: flushes, stops, persists false, no wipe / no baseline", async () => {
    await setTimelapseEnabled("p1", false);

    expect(recorderMock.flushNow).toHaveBeenCalled();
    expect(recorderMock.setRecorderEnabled).toHaveBeenCalledWith(false);
    expect(snapshotsMock.purgeTimelapseHistoryNative).not.toHaveBeenCalled();
    expect(snapshotsMock.appendGenesisBaselines).not.toHaveBeenCalled();
    expect(settingsMock.setTimelapseEnabledSetting).toHaveBeenCalledWith(
      "p1",
      "/workspace/novel.gdx",
      false,
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

describe("countTimelapseEvents", () => {
  it("reads the post-reset count instead of resurrecting the old prefix", async () => {
    settingsMock.getTimelapseResetSequence.mockResolvedValue(12);
    dbSelectWhere.mockResolvedValue([{ n: 2 }]);

    await expect(countTimelapseEvents("p1")).resolves.toBe(2);
    expect(settingsMock.getTimelapseResetSequence).toHaveBeenCalledWith("p1");
    expect(dbSelectWhere).toHaveBeenCalledOnce();
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
    expect(snapshotsMock.appendBodyBaselines).not.toHaveBeenCalled();
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

    await expect(
      ensureGenesisBaselines("p1", "/workspace/novel.gdx"),
    ).rejects.toThrow("did not complete for scene");

    expect(snapshotsMock.appendGenesisBaselines).toHaveBeenCalledTimes(1);
  });
});

describe("rebaselineScenesAtTail", () => {
  it("flushes then sends editor identities to Native at the CURRENT tail", async () => {
    recorderMock.readAuthoritativeChainTail.mockResolvedValue(87);

    await rebaselineScenesAtTail("p1", ["sceneA", "sceneB"]);

    // Must flush first so the caller's meta event is committed and the
    // in-memory head equals the DB tail.
    expect(recorderMock.flushNow).toHaveBeenCalled();
    expect(snapshotsMock.appendBodyBaselines).toHaveBeenCalledExactlyOnceWith(
      {
        expectedWorkspacePath: "/workspace/novel.gdx",
        projectId: "p1",
        targets: [
          { kind: "scene", id: "sceneA" },
          { kind: "scene", id: "sceneB" },
        ],
        expectedAnchorSequence: 87,
      },
      expect.any(Function),
    );
  });

  it("no-op when recording is disabled (nothing to keep coherent)", async () => {
    recorderMock.isRecorderEnabled.mockReturnValue(false);

    await rebaselineScenesAtTail("p1", ["sceneA"]);

    expect(recorderMock.flushNow).not.toHaveBeenCalled();
    expect(snapshotsMock.appendBodyBaselines).not.toHaveBeenCalled();
  });

  it("no-op for an empty scene list", async () => {
    await rebaselineScenesAtTail("p1", []);
    expect(recorderMock.flushNow).not.toHaveBeenCalled();
    expect(snapshotsMock.appendBodyBaselines).not.toHaveBeenCalled();
  });

  it("best-effort: a stale first identity does not abort the valid later identity", async () => {
    recorderMock.readAuthoritativeChainTail.mockResolvedValue(5);
    snapshotsMock.appendBodyBaselines
      .mockRejectedValueOnce(new Error("stale entity"))
      .mockResolvedValueOnce({
        insertedCount: 1,
        skippedExistingCount: 0,
        anchorSequence: 5,
        anchorTimestamp: 1,
        completed: true,
      });

    await rebaselineScenesAtTail("p1", ["bad", "good"]);

    expect(snapshotsMock.appendBodyBaselines).toHaveBeenCalledTimes(3);
    expect(snapshotsMock.appendBodyBaselines).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ targets: [{ kind: "scene", id: "bad" }] }),
      expect.any(Function),
    );
    expect(snapshotsMock.appendBodyBaselines).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ targets: [{ kind: "scene", id: "good" }] }),
      expect.any(Function),
    );
  });
});

describe("rebaselineEntitiesAtTail", () => {
  it("sends codex/snippet identities at the tail with the matching kind", async () => {
    recorderMock.readAuthoritativeChainTail.mockResolvedValue(42);

    await rebaselineEntitiesAtTail("p1", [
      { kind: "codex", id: "c1" },
      { kind: "snippet", id: "sn1" },
    ]);

    expect(recorderMock.flushNow).toHaveBeenCalled();
    expect(snapshotsMock.appendBodyBaselines).toHaveBeenCalledExactlyOnceWith(
      {
        expectedWorkspacePath: "/workspace/novel.gdx",
        projectId: "p1",
        targets: [
          { kind: "codex", id: "c1" },
          { kind: "snippet", id: "sn1" },
        ],
        expectedAnchorSequence: 42,
      },
      expect.any(Function),
    );
  });

  it("uses the committed Native sequence instead of the stale renderer head", async () => {
    recorderMock.readAuthoritativeChainTail.mockResolvedValue(9);

    await rebaselineEntitiesAtTail("p1", [{ kind: "scene", id: "s1" }], 12);

    expect(recorderMock.flushNow).toHaveBeenCalled();
    expect(snapshotsMock.appendBodyBaselines).toHaveBeenCalledWith(
      expect.objectContaining({
        targets: [{ kind: "scene", id: "s1" }],
        expectedAnchorSequence: 12,
      }),
      expect.any(Function),
    );
  });

  it("no-op when recording is disabled or refs empty", async () => {
    recorderMock.isRecorderEnabled.mockReturnValue(false);
    await rebaselineEntitiesAtTail("p1", [{ kind: "codex", id: "c1" }]);
    expect(recorderMock.flushNow).not.toHaveBeenCalled();

    recorderMock.isRecorderEnabled.mockReturnValue(true);
    await rebaselineEntitiesAtTail("p1", []);
    expect(recorderMock.flushNow).not.toHaveBeenCalled();
    expect(snapshotsMock.appendBodyBaselines).not.toHaveBeenCalled();
  });
});

describe("purgeTimelapseHistory", () => {
  it("recording on: wipes and re-baselines", async () => {
    settingsMock.getProjectSetting.mockResolvedValue("true");
    treeMock.listAllNodes.mockResolvedValue([{ id: "s1", nodeType: "scene" }]);

    await purgeTimelapseHistory("p1");

    expect(snapshotsMock.purgeTimelapseHistoryNative).toHaveBeenCalledWith({
      expectedWorkspacePath: "/workspace/novel.gdx",
      projectId: "p1",
    });
    expect(recorderMock.resetRecorderChain).toHaveBeenCalled();
    expect(recorderMock.setRecorderEnabled).toHaveBeenCalledWith(true);
    expect(snapshotsMock.appendBodyBaselines).toHaveBeenCalledTimes(1);
  });

  it("recording off: wipes only, no re-arm / no baseline", async () => {
    settingsMock.getProjectSetting.mockResolvedValue("false");

    await purgeTimelapseHistory("p1");

    expect(snapshotsMock.purgeTimelapseHistoryNative).toHaveBeenCalled();
    expect(recorderMock.resetRecorderChain).toHaveBeenCalled();
    expect(recorderMock.setRecorderEnabled).not.toHaveBeenCalled();
    expect(snapshotsMock.appendGenesisBaselines).not.toHaveBeenCalled();
  });
});
