import { describe, expect, it, beforeEach, vi } from "vitest";
import { useCodexStore } from "@/features/codex/codexStore";
import type { CodexEntry } from "@/features/codex/api";

vi.mock("@/features/chat/chatApi", () => ({
  sendChatMessageWithThinking: vi.fn(),
}));

// hidden の判定（resolveCodexForAi）が引く DB と Phase。where は解釈せず、store の
// entries をそのまま返す（判定は executor 側の責務）。
const h = vi.hoisted(() => ({
  phases: [] as Array<Record<string, unknown>>,
  rows: [] as Array<Record<string, unknown>>,
}));
vi.mock("@/features/codex/phaseApi", () => ({
  listPhasesByEntryIds: async (ids: string[]) =>
    h.phases.filter((p) => ids.includes(String(p["entryId"]))),
  listDetailOverridesByPhaseIds: async () => [],
}));
vi.mock("@/db/client", () => {
  const chain: Record<string, unknown> = {
    from: () => chain,
    where: () => chain,
    then: (
      resolve: (v: unknown[]) => unknown,
      reject: (r: unknown) => unknown,
    ) => Promise.resolve(h.rows).then(resolve, reject),
  };
  return { db: { select: () => chain } };
});

import { usePhaseStore } from "@/features/codex/phaseStore";
import { buildSceneTimeIndex } from "@/features/codex/context/sceneTimeIndex";
import { detectRelatedCodex } from "./api";

function makeEntry(overrides: Partial<CodexEntry> = {}): CodexEntry {
  return {
    id: "c-1",
    projectId: "proj-1",
    parentId: null,
    type: "character",
    name: "朱音",
    summary: "主人公。雨を嫌う。",
    content: "{}",
    icon: null,
    aliases: "[]",
    excludedAliases: "[]",
    tagsCache: null,
    contextMode: "mentioned",
    childrenBudget: "compact",
    sourceChatMessageId: null,
    notes: null,
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    ...overrides,
  } as CodexEntry;
}

/** store と DB の fake に同じ Codex を入れる。 */
function setEntries(entries: CodexEntry[]) {
  useCodexStore.setState({ entries });
  h.rows = entries.map((e) => ({
    id: e.id,
    summary: e.summary,
    contextMode: e.contextMode,
  }));
}

describe("detectRelatedCodex", () => {
  beforeEach(() => {
    h.phases = [];
    h.rows = [];
    useCodexStore.setState({ entries: [] });
    usePhaseStore.setState({
      sceneTimeIndex: buildSceneTimeIndex([]),
      resolutionMode: "reading",
    });
  });

  it("テキストに言及されたエントリを id/name/summary で返す", async () => {
    setEntries([
      makeEntry({ id: "c-akane", name: "朱音", summary: "主人公。" }),
      makeEntry({ id: "c-rin", name: "凛", summary: "幼馴染。" }),
    ]);

    const result = await detectRelatedCodex("朱音が雨の中を歩いた。");

    expect(result).toEqual([
      { id: "c-akane", name: "朱音", summary: "主人公。" },
    ]);
  });

  it("hidden / suppress のエントリは検出対象外", async () => {
    setEntries([
      makeEntry({ id: "c-h", name: "朱音", contextMode: "hidden" }),
      makeEntry({ id: "c-s", name: "凛", contextMode: "suppress" }),
    ]);

    await expect(detectRelatedCodex("朱音と凛が話した。")).resolves.toEqual([]);
  });

  it("summary が空のエントリは除外する", async () => {
    setEntries([makeEntry({ id: "c-1", name: "朱音", summary: "  " })]);

    await expect(detectRelatedCodex("朱音が現れた。")).resolves.toEqual([]);
  });

  it("空テキストは検出せず [] を返す", async () => {
    setEntries([makeEntry()]);
    await expect(detectRelatedCodex("   ")).resolves.toEqual([]);
  });

  it("合計 3000 字を超える summary は打ち切る (inline AI と同水準の cap)", async () => {
    setEntries([
      makeEntry({ id: "c-1", name: "朱音", summary: "あ".repeat(2950) }),
      makeEntry({ id: "c-2", name: "凛", summary: "い".repeat(100) }),
    ]);

    const result = await detectRelatedCodex("朱音と凛が向かい合う。");

    expect(result.map((e) => e.id)).toEqual(["c-1"]);
  });
  describe("Phase 解決後の hidden（伏線の提案の AI）", () => {
    const now = "2026-01-01T00:00:00.000Z";
    const node = (id: string, sortOrder: string) => ({
      id,
      projectId: "proj-1",
      parentId: null,
      nodeType: "scene" as const,
      title: id,
      synopsis: null,
      intent: null,
      sortOrder,
      status: null,
      storyTimeOrder: null,
      storyTimeLabel: null,
      povCharacterId: null,
      locationId: null,
      charCount: 0,
      createdAt: now,
      updatedAt: now,
    });
    const phase = (entryId: string, over: Record<string, unknown>) => ({
      id: `ph-${entryId}`,
      entryId,
      anchorNodeId: "scene-2",
      label: "後半",
      summaryOverride: null,
      contentOverride: null,
      contextModeOverride: null,
      version: 0,
      createdAt: now,
      updatedAt: now,
      ...over,
    });
    beforeEach(() => {
      usePhaseStore.setState({
        sceneTimeIndex: buildSceneTimeIndex([
          node("scene-1", "a0"),
          node("scene-2", "a1"),
        ]),
        resolutionMode: "reading",
      });
    });

    it("base は mentioned でも、その場面の Phase で hidden になったものは渡さない", async () => {
      setEntries([makeEntry({ id: "c-1", name: "朱音" })]);
      h.phases = [phase("c-1", { contextModeOverride: "hidden" })];
      await expect(
        detectRelatedCodex("朱音が現れた。", { sceneId: "scene-1" }),
      ).resolves.toHaveLength(1);
      await expect(
        detectRelatedCodex("朱音が現れた。", { sceneId: "scene-2" }),
      ).resolves.toEqual([]);
    });

    it("不明な mode のエントリは渡さない", async () => {
      setEntries([
        makeEntry({ id: "c-1", name: "朱音", contextMode: "weird" }),
      ]);
      await expect(detectRelatedCodex("朱音が現れた。")).resolves.toEqual([]);
    });

    it("base が hidden でも Phase で解除されたものは、base でなく Phase 解決後の summary を渡す", async () => {
      setEntries([
        makeEntry({
          id: "c-1",
          name: "朱音",
          summary: "base の秘匿の要約",
          contextMode: "hidden",
        }),
      ]);
      h.phases = [
        phase("c-1", {
          summaryOverride: "公開された要約",
          contextModeOverride: "mentioned",
        }),
      ];
      const result = await detectRelatedCodex("朱音が現れた。", {
        sceneId: "scene-2",
      });
      expect(result).toEqual([
        { id: "c-1", name: "朱音", summary: "公開された要約" },
      ]);
      await expect(
        detectRelatedCodex("朱音が現れた。", { sceneId: "scene-1" }),
      ).resolves.toEqual([]);
    });

    it("hidden でない項目の summary は Phase の summaryOverride でも置き換えない（base のまま）", async () => {
      setEntries([
        makeEntry({ id: "c-1", name: "朱音", summary: "base の要約" }),
      ]);
      h.phases = [phase("c-1", { summaryOverride: "Phase の要約" })];
      const result = await detectRelatedCodex("朱音が現れた。", {
        sceneId: "scene-2",
      });
      expect(result[0]?.summary).toBe("base の要約");
    });
  });
});
