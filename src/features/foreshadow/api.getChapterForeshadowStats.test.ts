import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockWhere } = vi.hoisted(() => ({
  mockWhere: vi.fn(),
}));

vi.mock("@/db/client", () => ({
  db: {
    select: vi.fn(() => ({ from: vi.fn(() => ({ where: mockWhere })) })),
  },
}));

vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("drizzle-orm")>();
  return { ...actual };
});

vi.mock("@/db/schema", () => ({
  treeNodes: {
    id: "id",
    content: "content",
    parentId: "parentId",
    nodeType: "nodeType",
  },
  foreshadowSetups: {
    sceneId: "sceneId",
    foreshadowId: "foreshadowId",
    isOrphan: "isOrphan",
  },
  foreshadows: { id: "id", payoffSceneId: "payoffSceneId" },
}));

import { getChapterForeshadowStats } from "./api";
import type { ForeshadowRow, ForeshadowSetupRow } from "./types";

function makeScene(id: string, withBody = true) {
  return {
    id,
    content: withBody
      ? JSON.stringify({ content: [{ type: "paragraph" }] })
      : JSON.stringify({ content: [] }),
  };
}

function makeForeshadowRow(
  overrides: Partial<ForeshadowRow> = {},
): ForeshadowRow {
  return {
    id: "f-1",
    projectId: "proj-1",
    title: "テスト伏線",
    intent: null,
    notes: null,
    payoffSceneId: null,
    payoffFromPos: null,
    payoffToPos: null,
    payoffConfirmed: false,
    abandoned: false,
    createdAt: new Date("2024-01-01"),
    updatedAt: new Date("2024-01-01"),
    ...overrides,
  };
}

function makeSetupRow(
  overrides: Partial<ForeshadowSetupRow> = {},
): ForeshadowSetupRow {
  return {
    id: "s-1",
    foreshadowId: "f-1",
    sceneId: "scene-1",
    fromPos: 0,
    toPos: 5,
    kind: "designated_existing",
    strength: null,
    aiStrength: null,
    aiReasoning: null,
    attribution: "human",
    aiRationale: null,
    lastEvaluatedAt: null,
    isOrphan: false,
    createdAt: new Date("2024-01-01"),
    updatedAt: new Date("2024-01-01"),
    ...overrides,
  };
}

describe("getChapterForeshadowStats", () => {
  beforeEach(() => {
    mockWhere.mockReset();
  });

  it("章配下にシーンがない場合は空の stats を返す", async () => {
    mockWhere.mockResolvedValueOnce([]); // scenes query → []

    const result = await getChapterForeshadowStats("ch-1");

    expect(result).toEqual({
      chapterId: "ch-1",
      totalScenes: 0,
      scenesWithBody: 0,
      byLabel: {},
      orphanCount: 0,
      needsStrengtheningCount: 0,
    });
    expect(mockWhere).toHaveBeenCalledTimes(1);
  });

  it("シーンはあるが関連 foreshadow がない場合 totalScenes / scenesWithBody を正しく返す", async () => {
    const scenes = [makeScene("s-1", true), makeScene("s-2", false)];
    mockWhere
      .mockResolvedValueOnce(scenes) // scenes
      .mockResolvedValueOnce([]) // setups by sceneId
      .mockResolvedValueOnce([]); // payoffForeshadows by sceneId

    const result = await getChapterForeshadowStats("ch-1");

    expect(result).toEqual({
      chapterId: "ch-1",
      totalScenes: 2,
      scenesWithBody: 1,
      byLabel: {},
      orphanCount: 0,
      needsStrengtheningCount: 0,
    });
  });

  it("seeded ラベルの伏線が byLabel に集計される", async () => {
    const scenes = [makeScene("s-1")];
    const frow = makeForeshadowRow({ id: "f-1", payoffSceneId: null });
    const setup = makeSetupRow({
      foreshadowId: "f-1",
      sceneId: "s-1",
      isOrphan: false,
    });

    mockWhere
      .mockResolvedValueOnce(scenes) // scenes
      .mockResolvedValueOnce([setup]) // setups by sceneId
      .mockResolvedValueOnce([]) // payoffForeshadows by sceneId
      .mockResolvedValueOnce([frow]) // fRows (foreshadow 本体)
      .mockResolvedValueOnce([setup]); // allSetups by foreshadowId

    const result = await getChapterForeshadowStats("ch-1");

    expect(result.byLabel.seeded).toBe(1);
    expect(result.orphanCount).toBe(0);
    expect(result.needsStrengtheningCount).toBe(0);
  });

  it("needs_strengthening ラベルが needsStrengtheningCount に反映される", async () => {
    const scenes = [makeScene("s-1")];
    // subtle strength + payoffConfirmed=false → needs_strengthening
    const frow = makeForeshadowRow({
      id: "f-1",
      payoffSceneId: null,
      payoffConfirmed: false,
    });
    const setup = makeSetupRow({
      foreshadowId: "f-1",
      sceneId: "s-1",
      isOrphan: false,
      strength: "subtle",
    });

    mockWhere
      .mockResolvedValueOnce(scenes) // scenes
      .mockResolvedValueOnce([setup]) // setups by sceneId
      .mockResolvedValueOnce([frow]) // payoffForeshadows by sceneId
      .mockResolvedValueOnce([frow]) // fRows
      .mockResolvedValueOnce([setup]); // allSetups

    const result = await getChapterForeshadowStats("ch-1");

    expect(result.needsStrengtheningCount).toBe(1);
    expect(result.byLabel.needs_strengthening).toBe(1);
  });

  it("orphan setup は countMap に加算されず orphanCount には影響しない", async () => {
    const scenes = [makeScene("s-1")];
    const frow = makeForeshadowRow({ id: "f-1" });
    const orphanSetup = makeSetupRow({
      foreshadowId: "f-1",
      sceneId: "s-1",
      isOrphan: true,
    });

    mockWhere
      .mockResolvedValueOnce(scenes)
      .mockResolvedValueOnce([orphanSetup])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([frow])
      .mockResolvedValueOnce([orphanSetup]);

    const result = await getChapterForeshadowStats("ch-1");

    // orphan setup is skipped in countMap → setupCount=0 → label "planned" (no payoffSceneId)
    expect(result.byLabel.planned).toBe(1);
    expect(result.orphanCount).toBe(0);
  });
});
