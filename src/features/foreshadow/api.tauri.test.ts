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
  listForeshadows,
  listForeshadowsWithLabels,
  listSetups,
  proposePastSetups,
  updateForeshadow,
  type ProposeRequest,
} from "./api";

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

  it("normalizes list rows and setup rows from tauri commands", async () => {
    mockInvoke
      .mockResolvedValueOnce([
        {
          id: "f1",
          project_id: "p1",
          title: "伏線A",
          intent: null,
          notes: null,
          payoff_scene_id: null,
          payoff_from_pos: null,
          payoff_to_pos: null,
          payoff_confirmed: 1,
          abandoned: 0,
          created_at: 1714000000000,
          updated_at: 1714000001000,
        },
      ])
      .mockResolvedValueOnce({
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

    const foreshadows = await listForeshadows("p1");
    const setups = await listSetups("f1");

    expect(foreshadows[0].payoffConfirmed).toBe(true);
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

    const items = await listForeshadowsWithLabels("p1");

    expect(mockInvoke).toHaveBeenCalledWith("foreshadow_list_with_labels", {
      projectId: "p1",
    });
    expect(items).toHaveLength(1);
    expect(items[0].setupCount).toBe(1);
    expect(items[0].label).toBe("seeded");
  });

  it("filters invalid candidates from tauri propose response", async () => {
    mockInvoke.mockResolvedValue({
      candidates: [
        {
          sceneId: "scene-1",
          kind: "designated_existing",
          rationale: "ok",
          predictedStrength: "subtle",
        },
        {
          sceneId: "scene-2",
          kind: "invalid_kind",
          rationale: "ng",
          predictedStrength: "subtle",
        },
      ],
    });

    const req: ProposeRequest = {
      intent: "intent",
      payoffSceneId: "scene-9",
      payoffExcerpt: "payoff",
      pastScenes: [],
      relatedCodex: [],
    };
    const result = await proposePastSetups(req);
    expect(result).toHaveLength(1);
    expect(result[0].sceneId).toBe("scene-1");
  });

  it("preserves omitted fields and explicit null in update payload", async () => {
    mockInvoke.mockResolvedValue(undefined);

    await updateForeshadow("f1", {
      title: "更新タイトル",
      payoffSceneId: null,
      payoffFromPos: null,
      payoffToPos: null,
    });

    expect(mockInvoke).toHaveBeenCalledWith("foreshadow_update", {
      id: "f1",
      patch: {
        title: "更新タイトル",
        payoffSceneId: null,
        payoffFromPos: null,
        payoffToPos: null,
      },
    });
  });
});
