import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockWhere } = vi.hoisted(() => ({
  mockWhere: vi.fn(),
}));

vi.mock("@/db/client", () => ({
  db: {
    selectDistinct: vi.fn(() => ({
      from: vi.fn(() => ({ where: mockWhere })),
    })),
    select: vi.fn(() => ({ from: vi.fn(() => ({ where: mockWhere })) })),
  },
}));

vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("drizzle-orm")>();
  return { ...actual };
});

vi.mock("@/db/schema", () => ({
  foreshadowSetups: { sceneId: "sceneId", foreshadowId: "foreshadowId" },
  foreshadows: { id: "id", payoffSceneId: "payoffSceneId" },
}));

// Silence unrelated imports
vi.mock("@/features/chat/chatApi", () => ({
  sendChatMessageWithThinking: vi.fn(),
}));
vi.mock("@/lib/tauri", () => ({ invoke: vi.fn() }));
vi.mock("@/prompts/index", () => ({ getPromptCatalog: vi.fn() }));
vi.mock("@/prompts/shared/jsonContract", () => ({
  extractJsonObject: vi.fn(),
}));
vi.mock("@/features/tree/treeStore", () => ({ useTreeStore: vi.fn() }));
vi.mock("@/features/project/api", () => ({ getProject: vi.fn() }));

import { getSceneForeshadowInfo } from "./api";

describe("getSceneForeshadowInfo", () => {
  beforeEach(() => {
    mockWhere.mockReset();
  });

  it("setup も payoff もない場合は空配列を返す", async () => {
    mockWhere
      .mockResolvedValueOnce([]) // setupRows
      .mockResolvedValueOnce([]); // payoffRows

    const result = await getSceneForeshadowInfo("s1");

    expect(result).toEqual({
      setupForeshadowIds: [],
      payoffForeshadowIds: [],
    });
  });

  it("setup が存在する場合 setupForeshadowIds に foreshadowId が入る", async () => {
    mockWhere
      .mockResolvedValueOnce([{ foreshadowId: "f-1" }, { foreshadowId: "f-2" }])
      .mockResolvedValueOnce([]);

    const result = await getSceneForeshadowInfo("s1");

    expect(result.setupForeshadowIds).toEqual(["f-1", "f-2"]);
    expect(result.payoffForeshadowIds).toEqual([]);
  });

  it("payoff が存在する場合 payoffForeshadowIds に id が入る", async () => {
    mockWhere.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: "f-3" }]);

    const result = await getSceneForeshadowInfo("s1");

    expect(result.setupForeshadowIds).toEqual([]);
    expect(result.payoffForeshadowIds).toEqual(["f-3"]);
  });

  it("setup と payoff が両方ある場合に両配列が正しく返る", async () => {
    mockWhere
      .mockResolvedValueOnce([{ foreshadowId: "f-1" }])
      .mockResolvedValueOnce([{ id: "f-2" }, { id: "f-3" }]);

    const result = await getSceneForeshadowInfo("s1");

    expect(result.setupForeshadowIds).toEqual(["f-1"]);
    expect(result.payoffForeshadowIds).toEqual(["f-2", "f-3"]);
  });
});
