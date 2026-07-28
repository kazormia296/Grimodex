// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

const { loadBatchAiRatioMock } = vi.hoisted(() => ({
  loadBatchAiRatioMock: vi.fn(),
}));

vi.mock("@/features/attribution/api", () => ({
  loadBatchAiRatio: loadBatchAiRatioMock,
}));

vi.mock("@/lib/tauri", () => ({
  invoke: vi.fn(),
  listen: vi.fn(),
}));

vi.mock("@/features/project/projectStore", () => ({
  getCurrentProjectId: () => "p1",
}));

import { useTreeStore } from "./treeStore";

describe("treeStore.refreshAiRatio", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useTreeStore.setState({
      aiRatios: {},
      hydratedProjectId: "p1",
      hydratedWorkspaceOpenRevision: null,
    });
  });

  it("merges refreshed ratio for the node", async () => {
    useTreeStore.setState({ aiRatios: { s1: 10, s2: 40 } });
    loadBatchAiRatioMock.mockResolvedValue({ s1: 25 });

    await useTreeStore.getState().refreshAiRatio("s1");

    expect(useTreeStore.getState().aiRatios).toEqual({ s1: 25, s2: 40 });
  });

  it("clears stale ratio when the node is absent from the result", async () => {
    // AIテキスト全削除で spans が消え、シーンも空 (charCount 0) になった場合
    // loadBatchAiRatio は当該ノードを結果から省く。旧値を残すと
    // ツリー再ロードまで古い % がバッジに表示され続ける。
    // 0 を書き込まず key ごと消す (初期一括ロードの省略=key無しと同一表現)。
    useTreeStore.setState({ aiRatios: { s1: 50, s2: 40 } });
    loadBatchAiRatioMock.mockResolvedValue({});

    await useTreeStore.getState().refreshAiRatio("s1");

    expect(useTreeStore.getState().aiRatios).toEqual({ s2: 40 });
  });

  it("keeps previous value when the load fails", async () => {
    useTreeStore.setState({ aiRatios: { s1: 50 } });
    loadBatchAiRatioMock.mockRejectedValue(new Error("db down"));

    await useTreeStore.getState().refreshAiRatio("s1");

    expect(useTreeStore.getState().aiRatios.s1).toBe(50);
  });

  it("does not publish a result after Tree hydration authority changes", async () => {
    let resolve!: (ratios: Record<string, number>) => void;
    loadBatchAiRatioMock.mockReturnValue(
      new Promise<Record<string, number>>((done) => {
        resolve = done;
      }),
    );

    const refresh = useTreeStore.getState().refreshAiRatio("s1");
    useTreeStore.setState({
      hydratedProjectId: "p2",
      aiRatios: { "p2-scene": 80 },
    });
    resolve({ s1: 25 });
    await refresh;

    expect(useTreeStore.getState().aiRatios).toEqual({ "p2-scene": 80 });
  });
});
