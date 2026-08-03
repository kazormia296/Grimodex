import { describe, it, expect, beforeEach, vi } from "vitest";
import { usePhaseStore } from "./phaseStore";

vi.mock("./phaseApi", () => ({
  listPhasesByEntry: vi.fn(),
  listPhasesByEntryIds: vi.fn(),
  createPhase: vi.fn(),
  updatePhase: vi.fn(),
  getPhase: vi.fn(),
  deletePhase: vi.fn(),
  listDetailOverridesByPhaseIds: vi.fn(),
  upsertDetailOverride: vi.fn(),
  deleteDetailOverride: vi.fn(),
}));

import * as phaseApi from "./phaseApi";
import type { CodexEntryPhase, CodexPhaseDetailOverride } from "./phaseApi";
import type { TreeNodeData } from "@/features/tree/treeStore";
import { buildSceneTimeIndex } from "./context/sceneTimeIndex";
import { useGlobalHistoryStore } from "@/store/globalHistoryStore";
import {
  externalDocumentStateKey,
  useExternalWriteStore,
} from "@/features/concurrency/externalWriteStore";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

const mockListPhasesByEntry = vi.mocked(phaseApi.listPhasesByEntry);
const mockListDetailOverridesByPhaseIds = vi.mocked(
  phaseApi.listDetailOverridesByPhaseIds,
);
const mockCreatePhase = vi.mocked(phaseApi.createPhase);
const mockUpdatePhase = vi.mocked(phaseApi.updatePhase);
const mockGetPhase = vi.mocked(phaseApi.getPhase);
const mockDeletePhase = vi.mocked(phaseApi.deletePhase);
const mockUpsertDetailOverride = vi.mocked(phaseApi.upsertDetailOverride);
const mockDeleteDetailOverride = vi.mocked(phaseApi.deleteDetailOverride);

const mockPhase: CodexEntryPhase = {
  id: "phase-1",
  entryId: "entry-1",
  anchorNodeId: "scene-1",
  label: "フェーズ1",
  summaryOverride: "変化後のsummary",
  contentOverride: null,
  contextModeOverride: null,
  version: 0,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

const mockOverride: CodexPhaseDetailOverride = {
  phaseId: "phase-1",
  definitionId: "def-1",
  value: "新しい値",
};

const mockScene: TreeNodeData = {
  id: "scene-1",
  projectId: "proj-1",
  parentId: null,
  nodeType: "scene",
  title: "シーン 1",
  synopsis: null,

  intent: null,
  sortOrder: "a1",
  status: "draft",
  storyTimeOrder: null,
  storyTimeLabel: null,
  povCharacterId: null,
  locationId: null,
  charCount: 0,
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-01-01T00:00:00Z",
};

describe("phaseStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useGlobalHistoryStore.getState().clear();
    useExternalWriteStore.getState().clear();
    usePhaseStore.getState().resetForProject();
    usePhaseStore.setState({
      projectEpoch: 0,
      phasesByEntry: {},
      detailOverrides: {},
      globalSceneOrder: new Map(),
      sceneTimeIndex: buildSceneTimeIndex([]),
      resolvedStates: {},
      resolutionMode: "reading",
      cachedNodes: [],
    });
  });

  describe("loadPhasesForEntry", () => {
    it("フェーズとoverridesをロードする", async () => {
      mockListPhasesByEntry.mockResolvedValue([mockPhase]);
      mockListDetailOverridesByPhaseIds.mockResolvedValue([mockOverride]);

      await usePhaseStore.getState().loadPhasesForEntry("entry-1");

      expect(mockListPhasesByEntry).toHaveBeenCalledWith("entry-1");
      expect(mockListDetailOverridesByPhaseIds).toHaveBeenCalledWith([
        "phase-1",
      ]);
      expect(usePhaseStore.getState().phasesByEntry["entry-1"]).toEqual([
        mockPhase,
      ]);
      expect(usePhaseStore.getState().detailOverrides["phase-1"]).toEqual([
        mockOverride,
      ]);
    });

    it("フェーズがない場合は空配列を設定する", async () => {
      mockListPhasesByEntry.mockResolvedValue([]);
      mockListDetailOverridesByPhaseIds.mockResolvedValue([]);

      await usePhaseStore.getState().loadPhasesForEntry("entry-2");

      expect(usePhaseStore.getState().phasesByEntry["entry-2"]).toEqual([]);
    });

    it("再ロード結果が空なら以前の detail override も破棄する", async () => {
      usePhaseStore.setState({
        phasesByEntry: { "entry-1": [mockPhase] },
        detailOverrides: { "phase-1": [mockOverride] },
      });
      mockListPhasesByEntry.mockResolvedValue([]);
      mockListDetailOverridesByPhaseIds.mockResolvedValue([]);

      await usePhaseStore.getState().loadPhasesForEntry("entry-1");

      expect(usePhaseStore.getState().phasesByEntry["entry-1"]).toEqual([]);
      expect(
        usePhaseStore.getState().detailOverrides["phase-1"],
      ).toBeUndefined();
    });

    it("Project reset より前に開始したロード結果を公開しない", async () => {
      const pending = deferred<CodexEntryPhase[]>();
      mockListPhasesByEntry.mockReturnValue(pending.promise);

      const load = usePhaseStore.getState().loadPhasesForEntry("entry-1");
      usePhaseStore.getState().resetForProject();
      pending.resolve([mockPhase]);
      await load;

      expect(usePhaseStore.getState().phasesByEntry).toEqual({});
      expect(mockListDetailOverridesByPhaseIds).not.toHaveBeenCalled();
    });

    it("mutation 中に完了した古い同一 entry load を破棄して再取得する", async () => {
      const oldList = deferred<CodexEntryPhase[]>();
      const authoritativeList = deferred<CodexEntryPhase[]>();
      const created = {
        ...mockPhase,
        id: "phase-created",
        label: "Created",
      };
      const stale = { ...mockPhase, id: "phase-stale", label: "Stale" };
      mockListPhasesByEntry
        .mockReturnValueOnce(oldList.promise)
        .mockReturnValueOnce(authoritativeList.promise);
      mockListDetailOverridesByPhaseIds.mockResolvedValue([]);
      mockCreatePhase.mockResolvedValue(created);

      const load = usePhaseStore.getState().loadPhasesForEntry("entry-1");
      await usePhaseStore.getState().createPhase({
        entryId: "entry-1",
        label: "Created",
      });
      oldList.resolve([stale]);
      await load;

      expect(usePhaseStore.getState().phasesByEntry["entry-1"]).toEqual([
        created,
      ]);
      await vi.waitFor(() =>
        expect(mockListPhasesByEntry).toHaveBeenCalledTimes(2),
      );
      authoritativeList.resolve([created]);
      await vi.waitFor(() =>
        expect(usePhaseStore.getState().phasesByEntry["entry-1"]).toEqual([
          created,
        ]),
      );
    });
  });

  describe("createPhase", () => {
    it("フェーズを作成してstoreに追加する", async () => {
      mockCreatePhase.mockResolvedValue(mockPhase);

      const result = await usePhaseStore.getState().createPhase({
        entryId: "entry-1",
        label: "フェーズ1",
        anchorNodeId: "scene-1",
      });

      expect(result).toEqual(mockPhase);
      expect(usePhaseStore.getState().phasesByEntry["entry-1"]).toContain(
        mockPhase,
      );
      expect(
        useExternalWriteStore.getState().reloadNonce[
          externalDocumentStateKey({
            kind: "codex",
            id: mockPhase.entryId,
            phaseId: mockPhase.id,
          })
        ],
      ).toBe(1);
    });

    it("Project reset 後に完了した作成を store と履歴へ公開しない", async () => {
      const pending = deferred<CodexEntryPhase>();
      mockCreatePhase.mockReturnValue(pending.promise);

      const creation = usePhaseStore.getState().createPhase({
        entryId: "entry-1",
        label: "フェーズ1",
      });
      usePhaseStore.getState().resetForProject();
      pending.resolve(mockPhase);
      await creation;

      expect(usePhaseStore.getState().phasesByEntry).toEqual({});
      expect(useGlobalHistoryStore.getState().past).toEqual([]);
    });

    it("redo で元の createdAt と updatedAt を復元する", async () => {
      mockCreatePhase
        .mockResolvedValueOnce(mockPhase)
        .mockImplementation(async (input) => ({
          ...mockPhase,
          id: input.id,
          version: input.version ?? 0,
        }));
      mockDeletePhase.mockResolvedValue(true);
      await usePhaseStore.getState().createPhase({
        entryId: "entry-1",
        label: "フェーズ1",
      });

      await useGlobalHistoryStore.getState().undo();
      await useGlobalHistoryStore.getState().redo();

      expect(mockDeletePhase).toHaveBeenCalledWith(mockPhase.id, {
        expectedVersion: mockPhase.version,
      });
      expect(mockCreatePhase).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          id: mockPhase.id,
          version: 1,
          createdAt: mockPhase.createdAt,
          updatedAt: mockPhase.updatedAt,
        }),
      );
      expect(
        useExternalWriteStore.getState().reloadNonce[
          externalDocumentStateKey({
            kind: "codex",
            id: mockPhase.entryId,
            phaseId: mockPhase.id,
          })
        ],
      ).toBe(3);
    });

    it("create と後続 update を跨ぐ undo/redo でも再作成 token を伝播する", async () => {
      mockCreatePhase
        .mockResolvedValueOnce(mockPhase)
        .mockImplementation(async (input) => ({
          ...mockPhase,
          id: input.id,
          version: input.version ?? 0,
        }));
      let persisted = { ...mockPhase };
      mockUpdatePhase.mockImplementation(async (_id, patch, options) => {
        persisted = {
          ...persisted,
          ...patch,
          version: options.baseVersion + 1,
        };
        return persisted;
      });
      mockDeletePhase.mockResolvedValue(true);

      await usePhaseStore.getState().createPhase({
        entryId: mockPhase.entryId,
        label: mockPhase.label,
      });
      await usePhaseStore
        .getState()
        .updatePhase(mockPhase.id, { label: "更新済み" });
      await useGlobalHistoryStore.getState().undo();
      await useGlobalHistoryStore.getState().undo();

      expect(mockDeletePhase).toHaveBeenLastCalledWith(mockPhase.id, {
        expectedVersion: 2,
      });

      await useGlobalHistoryStore.getState().redo();
      await useGlobalHistoryStore.getState().redo();

      expect(mockCreatePhase).toHaveBeenLastCalledWith(
        expect.objectContaining({ id: mockPhase.id, version: 3 }),
      );
      expect(mockUpdatePhase).toHaveBeenLastCalledWith(
        mockPhase.id,
        { label: "更新済み" },
        { baseVersion: 3 },
      );
    });
  });

  describe("resetForProject", () => {
    it("Project 所有 cache を破棄し epoch を進めて mode を保持する", () => {
      usePhaseStore.setState({
        projectEpoch: 6,
        phasesByEntry: { "entry-1": [mockPhase] },
        detailOverrides: { "phase-1": [mockOverride] },
        sceneTimeIndex: buildSceneTimeIndex([mockScene], 9),
        resolutionMode: "story",
        cachedNodes: [mockScene],
      });

      usePhaseStore.getState().resetForProject();

      const state = usePhaseStore.getState();
      expect(state.projectEpoch).toBe(7);
      expect(state.phasesByEntry).toEqual({});
      expect(state.detailOverrides).toEqual({});
      expect(state.sceneTimeIndex.revision).toBe(10);
      expect(state.resolutionMode).toBe("story");
      expect(state.cachedNodes).toEqual([]);
    });
  });

  describe("updatePhase", () => {
    it("フェーズを更新してstoreに反映する", async () => {
      usePhaseStore.setState({
        phasesByEntry: { "entry-1": [mockPhase] },
      });
      const updated = { ...mockPhase, label: "更新済み" };
      mockUpdatePhase.mockResolvedValue(updated);

      const result = await usePhaseStore
        .getState()
        .updatePhase("phase-1", { label: "更新済み" });

      expect(result).toEqual(updated);
      expect(mockUpdatePhase).toHaveBeenCalledWith(
        "phase-1",
        { label: "更新済み" },
        { baseVersion: 0 },
      );
      expect(usePhaseStore.getState().phasesByEntry["entry-1"]![0]!.label).toBe(
        "更新済み",
      );
      expect(useGlobalHistoryStore.getState().past.at(-1)).toMatchObject({
        kind: "phase",
        entityId: "phase-1",
        documentKey: {
          kind: "codex",
          id: "entry-1",
          phaseId: "phase-1",
        },
        retainOnVersionConflict: true,
      });
    });

    it("store に未ロードなら最新行の version を読み、CAS する", async () => {
      mockGetPhase.mockResolvedValue({ ...mockPhase, version: 4 });
      mockUpdatePhase.mockResolvedValue({
        ...mockPhase,
        label: "更新済み",
        version: 5,
      });

      const result = await usePhaseStore
        .getState()
        .updatePhase("phase-1", { label: "更新済み" });

      expect(mockUpdatePhase).toHaveBeenCalledWith(
        "phase-1",
        { label: "更新済み" },
        { baseVersion: 4 },
      );
      expect(result?.version).toBe(5);
    });

    it("複数履歴を連続 undo/redo しても logical endpoint の OCC token を伝播する", async () => {
      usePhaseStore.setState({
        phasesByEntry: { "entry-1": [mockPhase] },
      });
      let persisted = { ...mockPhase };
      mockUpdatePhase.mockImplementation(async (_id, patch, options) => {
        if (options.baseVersion !== persisted.version) {
          throw new Error(
            `stale ${options.baseVersion}, current ${persisted.version}`,
          );
        }
        persisted = {
          ...persisted,
          ...patch,
          version: options.baseVersion + 1,
        };
        return persisted;
      });

      await usePhaseStore.getState().updatePhase("phase-1", { label: "更新A" });
      await usePhaseStore
        .getState()
        .updatePhase("phase-1", { summaryOverride: "更新B" });
      await useGlobalHistoryStore.getState().undo();
      await useGlobalHistoryStore.getState().undo();
      await useGlobalHistoryStore.getState().redo();
      await useGlobalHistoryStore.getState().redo();

      expect(
        mockUpdatePhase.mock.calls.map((call) => call[2].baseVersion),
      ).toEqual([0, 1, 2, 3, 4, 5]);
      expect(
        usePhaseStore.getState().phasesByEntry["entry-1"]![0],
      ).toMatchObject({
        label: "更新A",
        summaryOverride: "更新B",
        version: 6,
      });
    });

    it("OCC 衝突時は store を変更せず null を返す", async () => {
      const { PhaseVersionConflictError } = await import("./phaseOcc");
      usePhaseStore.setState({
        phasesByEntry: { "entry-1": [{ ...mockPhase, version: 2 }] },
      });
      mockUpdatePhase.mockRejectedValue(
        new PhaseVersionConflictError("phase-1"),
      );

      const result = await usePhaseStore
        .getState()
        .updatePhase("phase-1", { label: "競合する更新" });

      expect(result).toBeNull();
      expect(usePhaseStore.getState().phasesByEntry["entry-1"]![0]).toEqual({
        ...mockPhase,
        version: 2,
      });
      expect(useGlobalHistoryStore.getState().past).toHaveLength(0);
    });

    it("明示 baseVersion を優先する", async () => {
      usePhaseStore.setState({
        phasesByEntry: { "entry-1": [{ ...mockPhase, version: 8 }] },
      });
      mockUpdatePhase.mockResolvedValue({ ...mockPhase, version: 4 });

      await usePhaseStore
        .getState()
        .updatePhase("phase-1", { label: "更新済み" }, { baseVersion: 3 });

      expect(mockUpdatePhase).toHaveBeenCalledWith(
        "phase-1",
        { label: "更新済み" },
        { baseVersion: 3 },
      );
    });

    it("履歴 undo の OCC 衝突時はコマンドを保持する", async () => {
      const { PhaseVersionConflictError } = await import("./phaseOcc");
      usePhaseStore.setState({
        phasesByEntry: { "entry-1": [{ ...mockPhase, version: 2 }] },
      });
      mockUpdatePhase
        .mockResolvedValueOnce({
          ...mockPhase,
          label: "更新済み",
          version: 3,
        })
        .mockRejectedValueOnce(new PhaseVersionConflictError("phase-1"));

      await usePhaseStore
        .getState()
        .updatePhase("phase-1", { label: "更新済み" });
      const command = useGlobalHistoryStore.getState().past.at(-1);

      await useGlobalHistoryStore.getState().undo();

      expect(mockUpdatePhase).toHaveBeenLastCalledWith(
        "phase-1",
        { label: mockPhase.label },
        { baseVersion: 3 },
      );
      expect(useGlobalHistoryStore.getState().past).toEqual([command]);
      expect(useGlobalHistoryStore.getState().future).toEqual([]);
    });
  });

  describe("deletePhase", () => {
    it("フェーズを削除してstoreから除去する", async () => {
      usePhaseStore.setState({
        phasesByEntry: { "entry-1": [mockPhase] },
        detailOverrides: { "phase-1": [mockOverride] },
      });
      mockDeletePhase.mockResolvedValue(true);

      await usePhaseStore.getState().deletePhase("phase-1");

      expect(mockDeletePhase).toHaveBeenCalledWith("phase-1", {
        expectedVersion: 0,
      });
      expect(usePhaseStore.getState().phasesByEntry["entry-1"]).toEqual([]);
      expect(
        usePhaseStore.getState().detailOverrides["phase-1"],
      ).toBeUndefined();
      expect(
        useExternalWriteStore.getState().reloadNonce[
          externalDocumentStateKey({
            kind: "codex",
            id: mockPhase.entryId,
            phaseId: mockPhase.id,
          })
        ],
      ).toBe(1);
    });

    it("undo で削除前の createdAt と updatedAt を復元する", async () => {
      usePhaseStore.setState({
        phasesByEntry: { "entry-1": [mockPhase] },
      });
      mockDeletePhase.mockResolvedValue(true);
      mockCreatePhase.mockImplementation(async (input) => ({
        ...mockPhase,
        id: input.id,
        version: input.version ?? 0,
      }));

      await usePhaseStore.getState().deletePhase("phase-1");
      await useGlobalHistoryStore.getState().undo();

      expect(mockCreatePhase).toHaveBeenCalledWith(
        expect.objectContaining({
          id: mockPhase.id,
          version: 1,
          createdAt: mockPhase.createdAt,
          updatedAt: mockPhase.updatedAt,
        }),
      );

      await useGlobalHistoryStore.getState().redo();
      expect(mockDeletePhase).toHaveBeenLastCalledWith("phase-1", {
        expectedVersion: 1,
      });

      await useGlobalHistoryStore.getState().undo();
      expect(mockCreatePhase).toHaveBeenLastCalledWith(
        expect.objectContaining({ id: mockPhase.id, version: 2 }),
      );
      expect(
        useExternalWriteStore.getState().reloadNonce[
          externalDocumentStateKey({
            kind: "codex",
            id: mockPhase.entryId,
            phaseId: mockPhase.id,
          })
        ],
      ).toBe(4);
    });

    it("OCC衝突時は削除せずstoreと履歴を維持する", async () => {
      const { PhaseVersionConflictError } = await import("./phaseOcc");
      usePhaseStore.setState({
        phasesByEntry: { "entry-1": [{ ...mockPhase, version: 4 }] },
      });
      mockDeletePhase.mockRejectedValue(
        new PhaseVersionConflictError("phase-1"),
      );

      await usePhaseStore.getState().deletePhase("phase-1");

      expect(usePhaseStore.getState().phasesByEntry["entry-1"]).toEqual([
        { ...mockPhase, version: 4 },
      ]);
      expect(useGlobalHistoryStore.getState().past).toHaveLength(0);
    });
  });

  describe("upsertDetailOverride", () => {
    it("overrideをupsertしてstoreに反映する", async () => {
      mockUpsertDetailOverride.mockResolvedValue(mockOverride);

      await usePhaseStore
        .getState()
        .upsertDetailOverride("phase-1", "def-1", "新しい値");

      expect(mockUpsertDetailOverride).toHaveBeenCalledWith(
        "phase-1",
        "def-1",
        "新しい値",
      );
      expect(usePhaseStore.getState().detailOverrides["phase-1"]).toContain(
        mockOverride,
      );
    });
  });

  describe("deleteDetailOverride", () => {
    it("overrideを削除してstoreから除去する", async () => {
      usePhaseStore.setState({
        detailOverrides: { "phase-1": [mockOverride] },
      });
      mockDeleteDetailOverride.mockResolvedValue(undefined);

      await usePhaseStore.getState().deleteDetailOverride("phase-1", "def-1");

      expect(usePhaseStore.getState().detailOverrides["phase-1"]).toEqual([]);
    });
  });

  describe("recomputeSceneOrder", () => {
    it("ノード配列からシーン順序を計算する", () => {
      usePhaseStore.getState().recomputeSceneOrder([mockScene]);

      expect(usePhaseStore.getState().globalSceneOrder.get("scene-1")).toBe(0);
    });

    it("空配列を渡すと空のMapになる", () => {
      usePhaseStore.getState().recomputeSceneOrder([]);

      expect(usePhaseStore.getState().globalSceneOrder.size).toBe(0);
    });

    it("story モード時: storyTimeOrder 順でインデックスを割り当てる", () => {
      usePhaseStore.getState().setResolutionMode("story");
      const scene1 = {
        ...mockScene,
        id: "s1",
        sortOrder: "a1",
        storyTimeOrder: "a2",
      };
      const scene2 = {
        ...mockScene,
        id: "s2",
        sortOrder: "a2",
        storyTimeOrder: "a1",
      };
      usePhaseStore.getState().recomputeSceneOrder([scene1, scene2]);

      expect(usePhaseStore.getState().globalSceneOrder.get("s2")).toBe(0);
      expect(usePhaseStore.getState().globalSceneOrder.get("s1")).toBe(1);
    });
  });

  describe("setResolutionMode", () => {
    it("モードを変更してノードをキャッシュして再計算する", () => {
      const scene1 = {
        ...mockScene,
        id: "s1",
        sortOrder: "a1",
        storyTimeOrder: "a2",
      };
      const scene2 = {
        ...mockScene,
        id: "s2",
        sortOrder: "a2",
        storyTimeOrder: "a1",
      };
      // まず reading モードでロード
      usePhaseStore.getState().recomputeSceneOrder([scene1, scene2]);
      expect(usePhaseStore.getState().globalSceneOrder.get("s1")).toBe(0); // reading order

      // story モードに切り替え → キャッシュ済みノードで再計算
      usePhaseStore.getState().setResolutionMode("story");
      expect(usePhaseStore.getState().globalSceneOrder.get("s2")).toBe(0); // story order
      expect(usePhaseStore.getState().globalSceneOrder.get("s1")).toBe(1);
    });

    it("モード変更後に recomputeSceneOrder を呼ぶと新モードで計算される", () => {
      const scene1 = {
        ...mockScene,
        id: "s1",
        sortOrder: "a1",
        storyTimeOrder: "a2",
      };
      const scene2 = {
        ...mockScene,
        id: "s2",
        sortOrder: "a2",
        storyTimeOrder: "a1",
      };
      usePhaseStore.getState().setResolutionMode("story");
      usePhaseStore.getState().recomputeSceneOrder([scene1, scene2]);

      expect(usePhaseStore.getState().globalSceneOrder.get("s2")).toBe(0);
    });

    it("reading モードに戻すと reading-order が復元される", () => {
      const scene1 = {
        ...mockScene,
        id: "s1",
        sortOrder: "a1",
        storyTimeOrder: "a2",
      };
      const scene2 = {
        ...mockScene,
        id: "s2",
        sortOrder: "a2",
        storyTimeOrder: "a1",
      };
      usePhaseStore.getState().recomputeSceneOrder([scene1, scene2]);
      usePhaseStore.getState().setResolutionMode("story");
      // story: s2=0, s1=1
      expect(usePhaseStore.getState().globalSceneOrder.get("s2")).toBe(0);

      usePhaseStore.getState().setResolutionMode("reading");
      // reading: s1=0, s2=1
      expect(usePhaseStore.getState().globalSceneOrder.get("s1")).toBe(0);
      expect(usePhaseStore.getState().globalSceneOrder.get("s2")).toBe(1);
    });
  });

  describe("resolveForScene", () => {
    it("フェーズなしの場合はBase stateを返す", () => {
      usePhaseStore.setState({
        phasesByEntry: {},
        globalSceneOrder: new Map([["scene-1", 0]]),
      });

      const entry = {
        id: "entry-1",
        projectId: "proj-1",
        parentId: null,
        type: "character",
        name: "アリス",
        summary: "主人公",
        content: "{}",
        icon: null,
        aliases: "[]",
        excludedAliases: "[]",
        readings: null,
        tagsCache: null,
        contextMode: "mentioned",
        childrenBudget: "compact",
        sourceChatMessageId: null,
        notes: null,
        version: 0,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      };

      usePhaseStore.getState().resolveForScene([entry], new Map(), "scene-1");

      const resolved = usePhaseStore.getState().getResolvedState("entry-1");
      expect(resolved).not.toBeNull();
      expect(resolved!.summary).toBe("主人公");
      expect(resolved!.appliedPhaseIds).toEqual([]);
    });

    it("currentSceneId=nullの場合はBase stateを返す", () => {
      usePhaseStore.setState({
        phasesByEntry: { "entry-1": [mockPhase] },
        globalSceneOrder: new Map([["scene-1", 0]]),
      });

      const entry = {
        id: "entry-1",
        projectId: "proj-1",
        parentId: null,
        type: "character",
        name: "アリス",
        summary: "元のsummary",
        content: "{}",
        icon: null,
        aliases: "[]",
        excludedAliases: "[]",
        readings: null,
        tagsCache: null,
        contextMode: "mentioned",
        childrenBudget: "compact",
        sourceChatMessageId: null,
        notes: null,
        version: 0,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      };

      usePhaseStore.getState().resolveForScene([entry], new Map(), null);

      const resolved = usePhaseStore.getState().getResolvedState("entry-1");
      expect(resolved!.summary).toBe("元のsummary");
      expect(resolved!.appliedPhaseIds).toEqual([]);
    });

    it("auto の部分設定では reading に倒して未来 Phase を適用しない", () => {
      const chapter1 = {
        ...mockScene,
        id: "chapter-1",
        sortOrder: "a0",
        storyTimeOrder: null,
      };
      const chapter8 = {
        ...mockScene,
        id: "chapter-8",
        sortOrder: "a1",
        storyTimeOrder: "a0",
      };
      const futurePhase = {
        ...mockPhase,
        id: "future",
        anchorNodeId: "chapter-8",
      };
      usePhaseStore.setState({
        phasesByEntry: { "entry-1": [futurePhase] },
        resolutionMode: "auto",
      });
      usePhaseStore.getState().recomputeSceneOrder([chapter1, chapter8]);

      const entry = {
        id: "entry-1",
        projectId: "proj-1",
        parentId: null,
        type: "character",
        name: "アリス",
        summary: "元のsummary",
        content: "{}",
        icon: null,
        aliases: "[]",
        excludedAliases: "[]",
        readings: null,
        tagsCache: null,
        contextMode: "mentioned",
        childrenBudget: "compact",
        sourceChatMessageId: null,
        notes: null,
        version: 0,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      };
      usePhaseStore.getState().resolveForScene([entry], new Map(), "chapter-1");

      const resolved = usePhaseStore.getState().getResolvedState("entry-1");
      expect(resolved?.summary).toBe("元のsummary");
      expect(resolved?.appliedPhaseIds).toEqual([]);
      expect(resolved?.axisUsed).toBe("reading");
      expect(resolved?.fallbackReason).toBe("auto-incomplete-story-coverage");
      expect(usePhaseStore.getState().sceneTimeIndex.liveSceneCount).toBe(2);
      expect(usePhaseStore.getState().sceneTimeIndex.scheduledSceneCount).toBe(
        1,
      );
    });
  });

  describe("getResolvedState", () => {
    it("存在しないentryIdはnullを返す", () => {
      const result = usePhaseStore.getState().getResolvedState("non-existent");
      expect(result).toBeNull();
    });
  });
});
