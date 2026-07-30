// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from "vitest";

// map aggregate payload を捕捉し、それ以外(listBoards)は空 rows を返す。
const { mockInvoke, captured } = vi.hoisted(() => {
  const captured: { payload: Record<string, unknown> | null } = {
    payload: null,
  };
  const mockInvoke = vi.fn(
    async (cmd: string, args: { payload?: Record<string, unknown> }) => {
      if (cmd === "map_write_bundle") {
        captured.payload = args.payload ?? null;
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
  captured.payload = null;
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

    expect(captured.payload).toMatchObject({
      kind: "create-board",
      projectId: "p1",
      stickies: [],
      frames: [],
    });
    const positions = captured.payload?.positions as Array<{
      nodeRefType: string;
    }>;
    const edges = captured.payload?.edges as Array<{ direction: string }>;
    expect(positions).toHaveLength(3);
    expect(positions.every((row) => row.nodeRefType === "scene")).toBe(true);
    expect(edges).toHaveLength(2);
    expect(edges.every((row) => row.direction === "forward")).toBe(true);
  });

  it("解決可能な因果辺が無ければ boardId=null で board を作らない", async () => {
    setScenes(["a", "b"]);
    listAnnotationsMock.mockResolvedValue({ annotations: [] });
    const result = await generateCausalityBoard("p1", ENGINE);
    expect(result).toEqual({ boardId: null, edgeCount: 0, cycleCount: 0 });
    expect(captured.payload).toBeNull();
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
    expect(captured.payload).toBeNull();
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
