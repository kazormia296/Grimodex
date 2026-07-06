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

import { useTreeStore } from "./treeStore";

describe("treeStore.refreshAiRatio", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useTreeStore.setState({ aiRatios: {} });
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
});
