import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockInvoke } = vi.hoisted(() => ({
  mockInvoke: vi.fn(),
}));

vi.mock("@/lib/tauri", () => ({
  invoke: mockInvoke,
}));

vi.mock("@/features/chat/chatApi", () => ({
  sendChatMessageWithThinking: vi.fn(),
}));

import {
  createForeshadow,
  deleteSetup,
  getChapterForeshadowStats,
  getSceneForeshadowContext,
  getSceneForeshadowInfo,
  listForeshadowsByCodexEntry,
  listForeshadowsWithLabels,
  listOpenForeshadowsForContext,
  listSetups,
  updateForeshadow,
  updateSetup,
} from "./api";

function authoritativeForeshadowRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "f1",
    project_id: "p1",
    title: "伏線A",
    intent: null,
    notes: null,
    payoff_scene_id: null,
    payoff_from_pos: null,
    payoff_to_pos: null,
    payoff_confirmed: 0,
    abandoned: 0,
    secret: 0,
    load_bearing: null,
    version: 0,
    created_at: 1714000000000,
    updated_at: 1714000001000,
    ...overrides,
  };
}

describe("foreshadow api tauri mapping", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    (globalThis as unknown as { window?: Record<string, unknown> }).window = {
      __TAURI_INTERNALS__: {},
    };
  });

  it("normalizes snake_case row from foreshadow_create", async () => {
    mockInvoke.mockResolvedValue({
      id: "f1",
      project_id: "p1",
      title: "伏線A",
      intent: null,
      notes: null,
      payoff_scene_id: null,
      payoff_from_pos: null,
      payoff_to_pos: null,
      payoff_confirmed: 0,
      abandoned: 0,
      version: 0,
      created_at: 1714000000000,
      updated_at: 1714000001000,
    });

    const result = await createForeshadow({
      id: "local-id",
      projectId: "p1",
      title: "伏線A",
      intent: null,
      notes: null,
      payoffSceneId: null,
      payoffFromPos: null,
      payoffToPos: null,
      payoffConfirmed: false,
      abandoned: false,
    });

    expect(result.projectId).toBe("p1");
    expect(result.payoffConfirmed).toBe(false);
    expect(result.abandoned).toBe(false);
    expect(result.createdAt).toBeInstanceOf(Date);
  });

  it("normalizes setup rows from the dedicated tauri command", async () => {
    mockInvoke.mockResolvedValueOnce({
      setups: [
        {
          id: "s1",
          foreshadow_id: "f1",
          scene_id: "scene-1",
          from_pos: 3,
          to_pos: 9,
          kind: "designated_existing",
          strength: null,
          ai_strength: null,
          ai_reasoning: null,
          attribution: "human",
          ai_rationale: null,
          last_evaluated_at: null,
          is_orphan: 1,
          created_at: 1714000000000,
          updated_at: 1714000001000,
        },
      ],
    });

    const setups = await listSetups("f1");

    expect(setups[0].foreshadowId).toBe("f1");
    expect(setups[0].sceneId).toBe("scene-1");
    expect(setups[0].isOrphan).toBe(true);
  });

  it("loads foreshadows with labels in a single tauri command", async () => {
    mockInvoke.mockResolvedValue({
      foreshadows: [
        {
          id: "f1",
          project_id: "p1",
          title: "伏線A",
          intent: null,
          notes: null,
          payoff_scene_id: null,
          payoff_from_pos: null,
          payoff_to_pos: null,
          payoff_confirmed: 0,
          abandoned: 0,
          load_bearing: null,
          version: 0,
          created_at: 1714000000000,
          updated_at: 1714000001000,
        },
      ],
      setups: [
        {
          foreshadow_id: "f1",
          is_orphan: 0,
          strength: null,
          ai_strength: null,
          ai_reasoning: null,
        },
      ],
    });

    const result = await listForeshadowsWithLabels("p1");

    expect(mockInvoke).toHaveBeenCalledWith("foreshadow_list_with_labels", {
      projectId: "p1",
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].setupCount).toBe(1);
    expect(result.items[0].label).toBe("seeded");
  });

  it("loads open foreshadows for chat context in one command", async () => {
    mockInvoke.mockResolvedValue({
      foreshadows: [
        {
          id: "f1",
          title: "伏線A",
          intent: "hint",
          load_bearing: "critical",
          updated_at: 1714000001000,
        },
      ],
      setups: [{ foreshadow_id: "f1", is_orphan: 0 }],
    });

    const rows = await listOpenForeshadowsForContext("p1");

    expect(mockInvoke).toHaveBeenCalledWith(
      "foreshadow_list_open_for_context",
      {
        projectId: "p1",
      },
    );
    expect(rows[0].setupCount).toBe(1);
    expect(rows[0].loadBearing).toBe("critical");
  });

  it("loads scene foreshadow info in one command", async () => {
    mockInvoke.mockResolvedValue({
      setupForeshadowIds: ["f1"],
      payoffForeshadowIds: ["f2"],
    });

    const info = await getSceneForeshadowInfo("scene-1");

    expect(mockInvoke).toHaveBeenCalledWith("foreshadow_get_scene_info", {
      sceneId: "scene-1",
    });
    expect(info).toEqual({
      setupForeshadowIds: ["f1"],
      payoffForeshadowIds: ["f2"],
    });
  });

  it("loads scene foreshadow context in one command", async () => {
    mockInvoke.mockResolvedValue({
      setups: [{ title: "Setup A", intent: "i1" }],
      payoffs: [{ id: "f2", title: "Payoff B", intent: "i2" }],
      setupSceneRows: [{ foreshadowId: "f2", sceneTitle: "Scene X" }],
    });

    const ctx = await getSceneForeshadowContext("scene-1");

    expect(mockInvoke).toHaveBeenCalledWith("foreshadow_get_scene_context", {
      sceneId: "scene-1",
    });
    expect(ctx.setups[0].title).toBe("Setup A");
    expect(ctx.payoffs[0].setupSceneTitle).toBe("Scene X");
  });

  it("loads codex-linked foreshadows with labels in one command", async () => {
    mockInvoke.mockResolvedValue({
      foreshadows: [
        {
          id: "f1",
          project_id: "p1",
          title: "伏線A",
          intent: null,
          notes: null,
          payoff_scene_id: null,
          payoff_from_pos: null,
          payoff_to_pos: null,
          payoff_confirmed: 0,
          abandoned: 0,
          version: 0,
          created_at: 1714000000000,
          updated_at: 1714000001000,
        },
      ],
      setups: [],
    });

    const items = await listForeshadowsByCodexEntry("codex-1");

    expect(mockInvoke).toHaveBeenCalledWith("foreshadow_list_by_codex_entry", {
      codexEntryId: "codex-1",
    });
    expect(items[0].label).toBe("planned");
  });

  it("loads chapter stats bundle in one command", async () => {
    mockInvoke.mockResolvedValue({
      scenes: [
        {
          id: "scene-1",
          content: JSON.stringify({ content: [{ type: "paragraph" }] }),
        },
      ],
      setupsOnScenes: [],
      payoffForeshadows: [],
      relatedForeshadows: [],
      relatedSetups: [],
    });

    const stats = await getChapterForeshadowStats("ch-1");

    expect(mockInvoke).toHaveBeenCalledWith("foreshadow_get_chapter_stats", {
      chapterId: "ch-1",
    });
    expect(stats.totalScenes).toBe(1);
    expect(stats.scenesWithBody).toBe(1);
  });

  it("routes setup update and delete through tauri commands", async () => {
    mockInvoke
      .mockResolvedValueOnce(authoritativeForeshadowRow({ version: 8 }))
      .mockResolvedValueOnce({
        setupId: null,
        foreshadow: authoritativeForeshadowRow({ version: 9 }),
      });

    await updateSetup(
      "s1",
      {
        aiStrength: "subtle",
        aiReasoning: "{}",
        lastEvaluatedAt: new Date(1714000000000),
      },
      7,
    );
    await deleteSetup("s1", 8);

    expect(mockInvoke).toHaveBeenCalledWith("foreshadow_update_setup", {
      id: "s1",
      patch: {
        aiStrength: "subtle",
        aiReasoning: "{}",
        lastEvaluatedAt: 1714000000000,
        baseVersion: 7,
      },
    });
    expect(mockInvoke).toHaveBeenCalledWith("foreshadow_resolve_orphan", {
      payload: { setupId: "s1", action: "delete", baseVersion: 8 },
    });
  });

  it("preserves omitted fields and explicit null in update payload", async () => {
    mockInvoke.mockResolvedValue(
      authoritativeForeshadowRow({
        title: "更新タイトル",
        version: 5,
      }),
    );

    await updateForeshadow(
      "f1",
      {
        title: "更新タイトル",
        payoffSceneId: null,
        payoffFromPos: null,
        payoffToPos: null,
      },
      4,
    );

    expect(mockInvoke).toHaveBeenCalledWith("foreshadow_update", {
      id: "f1",
      patch: {
        title: "更新タイトル",
        payoffSceneId: null,
        payoffFromPos: null,
        payoffToPos: null,
        baseVersion: 4,
      },
    });
  });
});
