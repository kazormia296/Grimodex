// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from "vitest";

// invoke: db_execute_batch の statements を捕捉、それ以外(listBoards)は空 rows。
const { mockInvoke, captured } = vi.hoisted(() => {
  const captured: {
    statements: Array<{ sql: string; params: unknown[]; method: string }>;
  } = { statements: [] };
  const mockInvoke = vi.fn(
    async (cmd: string, args: { statements?: typeof captured.statements }) => {
      if (cmd === "db_execute_batch") {
        captured.statements = args.statements ?? [];
        return [];
      }
      return { rows: [] };
    },
  );
  return { mockInvoke, captured };
});
vi.mock("@/lib/tauri", () => ({ invoke: mockInvoke }));

const { listAnnotationsMock } = vi.hoisted(() => ({
  listAnnotationsMock: vi.fn(),
}));
vi.mock("@/features/post-effect/api", () => ({
  listAnnotationsForProject: listAnnotationsMock,
}));

import { generateCausalityBoard } from "./causalityBoard";
import { SyncForceLayoutEngine } from "./layouts/forceEngine";
import { useTreeStore } from "@/features/tree/treeStore";

function setScenes(ids: string[]) {
  useTreeStore.setState({
    nodes: ids.map((id) => ({ id, title: `title-${id}`, nodeType: "scene" })),
  } as never);
}

function causalAnn(effect: string, cause: string, reason = "理由") {
  return {
    sceneId: effect,
    category: "timeline_anchor",
    metadata: JSON.stringify({
      relation: "causality",
      cause_scene_id: cause,
      llm_reason: reason,
    }),
  };
}

const ENGINE = { engine: new SyncForceLayoutEngine() };

beforeEach(() => {
  vi.clearAllMocks();
  captured.statements = [];
  listAnnotationsMock.mockResolvedValue({ annotations: [] });
  setScenes([]);
});

describe("generateCausalityBoard", () => {
  it("causality 注釈から scene ノード + 有向 edge の board を生成する", async () => {
    setScenes(["a", "b", "c"]);
    listAnnotationsMock.mockResolvedValue({
      annotations: [causalAnn("b", "a"), causalAnn("c", "a")],
    });

    const result = await generateCausalityBoard("p1", ENGINE);

    expect(result.edgeCount).toBe(2);
    expect(result.cycleCount).toBe(0);
    expect(result.boardId).toBeTruthy();

    // board + positions + edges の statement が書き込まれた
    expect(captured.statements.length).toBeGreaterThanOrEqual(3);
    const allParams = captured.statements.flatMap((s) => s.params);
    // scene ノードとして配置
    expect(allParams).toContain("scene");
    // 有向 edge
    expect(allParams).toContain("forward");
  });

  it("解決可能な因果辺が無ければ boardId=null で board を作らない", async () => {
    setScenes(["a", "b"]);
    listAnnotationsMock.mockResolvedValue({ annotations: [] });
    const result = await generateCausalityBoard("p1", ENGINE);
    expect(result).toEqual({ boardId: null, edgeCount: 0, cycleCount: 0 });
    expect(captured.statements).toEqual([]);
  });

  it("実在しないシーンを指す causality 辺は board に出ない", async () => {
    setScenes(["a", "b"]); // "ghost" は無い
    listAnnotationsMock.mockResolvedValue({
      annotations: [causalAnn("b", "ghost"), causalAnn("b", "a")],
    });
    const result = await generateCausalityBoard("p1", ENGINE);
    expect(result.edgeCount).toBe(1); // a->b のみ
  });

  it("tree 未ロード (scenes 空) は throw して「該当なし」と区別する", async () => {
    setScenes([]); // tree 未ロード
    listAnnotationsMock.mockResolvedValue({
      annotations: [causalAnn("b", "a")],
    });
    await expect(generateCausalityBoard("p1", ENGINE)).rejects.toThrow();
    expect(captured.statements).toEqual([]);
  });

  it("循環があれば cycleCount に反映する", async () => {
    setScenes(["a", "b"]);
    listAnnotationsMock.mockResolvedValue({
      annotations: [causalAnn("b", "a"), causalAnn("a", "b")],
    });
    const result = await generateCausalityBoard("p1", ENGINE);
    expect(result.edgeCount).toBe(2);
    expect(result.cycleCount).toBeGreaterThanOrEqual(1);
  });
});
