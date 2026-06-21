import { describe, it, expect, beforeEach, vi } from "vitest";
import { usePhaseStore } from "./phaseStore";

vi.mock("./phaseApi", () => ({
  listPhasesByEntry: vi.fn(),
  listPhasesByEntryIds: vi.fn(),
  createPhase: vi.fn(),
  updatePhase: vi.fn(),
  deletePhase: vi.fn(),
  listDetailOverridesByPhaseIds: vi.fn(),
  upsertDetailOverride: vi.fn(),
  deleteDetailOverride: vi.fn(),
}));

import * as phaseApi from "./phaseApi";
import type { CodexEntryPhase, CodexPhaseDetailOverride } from "./phaseApi";
import type { TreeNodeData } from "@/features/tree/treeStore";

const mockListPhasesByEntry = vi.mocked(phaseApi.listPhasesByEntry);
const mockListDetailOverridesByPhaseIds = vi.mocked(
  phaseApi.listDetailOverridesByPhaseIds,
);
const mockCreatePhase = vi.mocked(phaseApi.createPhase);
const mockUpdatePhase = vi.mocked(phaseApi.updatePhase);
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
    usePhaseStore.setState({
      phasesByEntry: {},
      detailOverrides: {},
      globalSceneOrder: new Map(),
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
    });
  });

  describe("updatePhase", () => {
    it("フェーズを更新してstoreに反映する", async () => {
      usePhaseStore.setState({
        phasesByEntry: { "entry-1": [mockPhase] },
      });
      const updated = { ...mockPhase, label: "更新済み" };
      mockUpdatePhase.mockResolvedValue(updated);

      await usePhaseStore
        .getState()
        .updatePhase("phase-1", { label: "更新済み" });

      expect(usePhaseStore.getState().phasesByEntry["entry-1"]![0]!.label).toBe(
        "更新済み",
      );
    });
  });

  describe("deletePhase", () => {
    it("フェーズを削除してstoreから除去する", async () => {
      usePhaseStore.setState({
        phasesByEntry: { "entry-1": [mockPhase] },
        detailOverrides: { "phase-1": [mockOverride] },
      });
      mockDeletePhase.mockResolvedValue(undefined);

      await usePhaseStore.getState().deletePhase("phase-1");

      expect(usePhaseStore.getState().phasesByEntry["entry-1"]).toEqual([]);
      expect(
        usePhaseStore.getState().detailOverrides["phase-1"],
      ).toBeUndefined();
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
  });

  describe("getResolvedState", () => {
    it("存在しないentryIdはnullを返す", () => {
      const result = usePhaseStore.getState().getResolvedState("non-existent");
      expect(result).toBeNull();
    });
  });
});
