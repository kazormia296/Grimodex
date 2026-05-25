import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/tauri", () => ({
  isTauriRuntime: vi.fn(() => false),
}));

const mockSelect = vi.fn();

vi.mock("@/db/client", () => ({
  db: {
    select: (...args: unknown[]) => mockSelect(...args),
  },
}));

vi.mock("@/db/schema", () => ({
  foreshadows: {
    id: "id",
    title: "title",
    intent: "intent",
    notes: "notes",
    payoffConfirmed: "payoffConfirmed",
    abandoned: "abandoned",
    loadBearing: "loadBearing",
    payoffSceneId: "payoffSceneId",
    projectId: "projectId",
  },
  foreshadowSetups: {
    foreshadowId: "foreshadowId",
    sceneId: "sceneId",
    isOrphan: "isOrphan",
    strength: "strength",
    aiStrength: "aiStrength",
    aiReasoning: "aiReasoning",
  },
  treeNodes: { id: "id", title: "title" },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((...args: unknown[]) => ({ eq: args })),
  and: vi.fn((...args: unknown[]) => ({ and: args })),
  inArray: vi.fn((...args: unknown[]) => ({ inArray: args })),
}));

import { getSceneForeshadowContext } from "./api";

function chain(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(rows),
  };
}

describe("getSceneForeshadowContext setup dedup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns one setup row per foreshadow when multiple setups exist in scene", async () => {
    mockSelect
      .mockReturnValueOnce(
        chain([
          {
            foreshadowId: "f1",
            title: "伏線A",
            intent: "意図",
            notes: "notes1",
            payoffConfirmed: false,
            abandoned: false,
            loadBearing: null,
            strength: "moderate",
            aiStrength: null,
            aiReasoning: null,
            isOrphan: false,
          },
          {
            foreshadowId: "f1",
            title: "伏線A",
            intent: "意図",
            notes: "notes2",
            payoffConfirmed: false,
            abandoned: false,
            loadBearing: null,
            strength: "overt",
            aiStrength: null,
            aiReasoning: null,
            isOrphan: false,
          },
        ]),
      )
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(chain([]));

    const ctx = await getSceneForeshadowContext("scene-1");

    expect(ctx.setups).toHaveLength(1);
    expect(ctx.setups[0]?.foreshadowId).toBe("f1");
    expect(ctx.setups[0]?.strength).toBe("moderate");
  });
});
