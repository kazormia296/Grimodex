import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockCodexIndexStatus,
  mockCodexReindexAll,
  mockChatIndexStatus,
  mockChatReindexAll,
  mockSemanticIndexStatus,
  mockSemanticReindexAll,
  mockInvoke,
} = vi.hoisted(() => ({
  mockCodexIndexStatus: vi.fn(),
  mockCodexReindexAll: vi.fn(),
  mockChatIndexStatus: vi.fn(),
  mockChatReindexAll: vi.fn(),
  mockSemanticIndexStatus: vi.fn(),
  mockSemanticReindexAll: vi.fn(),
  mockInvoke: vi.fn(),
}));

vi.mock("./api", () => ({
  codexIndexStatus: mockCodexIndexStatus,
  codexReindexAll: mockCodexReindexAll,
  chatIndexStatus: mockChatIndexStatus,
  chatReindexAll: mockChatReindexAll,
  semanticIndexStatus: mockSemanticIndexStatus,
  semanticReindexAll: mockSemanticReindexAll,
}));
vi.mock("@/lib/tauri", () => ({ invoke: mockInvoke }));

import {
  ensureCodexIndexed,
  ensureChatIndexed,
  ensureSceneIndexed,
  ensureSemanticIndexesOnOpen,
  _resetAutoIndexForTests,
} from "./autoIndex";
import { useReindexProgressStore } from "./reindexProgressStore";

function sceneStatus(over: Partial<Record<string, unknown>> = {}) {
  return {
    indexedChunkCount: 0,
    staleChunkCount: 0,
    indexedSceneCount: 0,
    nonemptySceneCount: 0,
    currentModelId: "m",
    currentEmbeddingDim: 256,
    currentChunkerVersion: "v1",
    ...over,
  };
}

beforeEach(() => {
  _resetAutoIndexForTests();
  mockCodexIndexStatus.mockReset();
  mockCodexReindexAll.mockReset().mockResolvedValue(0);
  mockChatIndexStatus.mockReset();
  mockChatReindexAll.mockReset().mockResolvedValue(0);
  mockSemanticIndexStatus.mockReset();
  mockSemanticReindexAll.mockReset().mockResolvedValue(0);
  mockInvoke.mockReset().mockResolvedValue({ rows: [{ n: 0 }] });
  useReindexProgressStore.getState().setRunning(false);
});

describe("ensureCodexIndexed", () => {
  it("reindexes when indexed < total", async () => {
    mockCodexIndexStatus.mockResolvedValue({
      indexedEntryCount: 2,
      totalEntryCount: 5,
    });
    await ensureCodexIndexed("p1");
    expect(mockCodexReindexAll).toHaveBeenCalledWith("p1");
  });

  it("skips reindex when fully indexed", async () => {
    mockCodexIndexStatus.mockResolvedValue({
      indexedEntryCount: 5,
      totalEntryCount: 5,
    });
    await ensureCodexIndexed("p1");
    expect(mockCodexReindexAll).not.toHaveBeenCalled();
  });

  it("runs at most once per project per session", async () => {
    mockCodexIndexStatus.mockResolvedValue({
      indexedEntryCount: 0,
      totalEntryCount: 3,
    });
    await ensureCodexIndexed("p1");
    await ensureCodexIndexed("p1");
    expect(mockCodexIndexStatus).toHaveBeenCalledTimes(1);
    expect(mockCodexReindexAll).toHaveBeenCalledTimes(1);
  });

  it("is silent and retriable when reindex fails", async () => {
    mockCodexIndexStatus.mockResolvedValue({
      indexedEntryCount: 0,
      totalEntryCount: 3,
    });
    mockCodexReindexAll.mockRejectedValueOnce(new Error("no model"));
    await expect(ensureCodexIndexed("p1")).resolves.toBeUndefined();
    // ガードが外れ、次の open で再試行できる。
    mockCodexReindexAll.mockResolvedValueOnce(3);
    await ensureCodexIndexed("p1");
    expect(mockCodexReindexAll).toHaveBeenCalledTimes(2);
  });

  it("ignores empty projectId", async () => {
    await ensureCodexIndexed("");
    expect(mockCodexIndexStatus).not.toHaveBeenCalled();
  });
});

describe("ensureChatIndexed", () => {
  it("reindexes when indexed < total", async () => {
    mockChatIndexStatus.mockResolvedValue({
      indexedMessageCount: 1,
      totalMessageCount: 8,
    });
    await ensureChatIndexed("p1");
    expect(mockChatReindexAll).toHaveBeenCalledWith("p1");
  });

  it("skips reindex when fully indexed", async () => {
    mockChatIndexStatus.mockResolvedValue({
      indexedMessageCount: 8,
      totalMessageCount: 8,
    });
    await ensureChatIndexed("p1");
    expect(mockChatReindexAll).not.toHaveBeenCalled();
  });

  it("runs at most once per project per session", async () => {
    mockChatIndexStatus.mockResolvedValue({
      indexedMessageCount: 0,
      totalMessageCount: 4,
    });
    await ensureChatIndexed("p1");
    await ensureChatIndexed("p1");
    expect(mockChatIndexStatus).toHaveBeenCalledTimes(1);
    expect(mockChatReindexAll).toHaveBeenCalledTimes(1);
  });

  it("is silent and retriable when reindex fails", async () => {
    mockChatIndexStatus.mockResolvedValue({
      indexedMessageCount: 0,
      totalMessageCount: 4,
    });
    mockChatReindexAll.mockRejectedValueOnce(new Error("no model"));
    await expect(ensureChatIndexed("p1")).resolves.toBeUndefined();
    mockChatReindexAll.mockResolvedValueOnce(4);
    await ensureChatIndexed("p1");
    expect(mockChatReindexAll).toHaveBeenCalledTimes(2);
  });

  it("ignores empty projectId", async () => {
    await ensureChatIndexed("");
    expect(mockChatIndexStatus).not.toHaveBeenCalled();
  });
});

describe("ensureSceneIndexed", () => {
  it("reindexes when indexedSceneCount < nonemptySceneCount", async () => {
    mockSemanticIndexStatus.mockResolvedValue(
      sceneStatus({ indexedSceneCount: 1, nonemptySceneCount: 4 }),
    );
    await ensureSceneIndexed("p1");
    expect(mockSemanticReindexAll).toHaveBeenCalledWith("p1");
    expect(useReindexProgressStore.getState().running).toBe(false);
  });

  it("reindexes when stale chunks exist", async () => {
    mockSemanticIndexStatus.mockResolvedValue(
      sceneStatus({
        indexedSceneCount: 4,
        nonemptySceneCount: 4,
        staleChunkCount: 2,
      }),
    );
    await ensureSceneIndexed("p1");
    expect(mockSemanticReindexAll).toHaveBeenCalledWith("p1");
  });

  it("skips when scenes fully indexed and fresh", async () => {
    mockSemanticIndexStatus.mockResolvedValue(
      sceneStatus({
        indexedSceneCount: 4,
        nonemptySceneCount: 4,
        staleChunkCount: 0,
      }),
    );
    await ensureSceneIndexed("p1");
    expect(mockSemanticReindexAll).not.toHaveBeenCalled();
  });

  it("skips when only empty scenes remain unindexed (indexed == nonempty, stale=0)", async () => {
    // 回帰ガード: 空 scene 14 + 実体 1 のプロジェクト。indexedSceneCount(1) は
    // total scene 数(15) より小さいが、空 scene は chunk を生まないので
    // nonemptySceneCount は 1。分母を total にしていた旧実装では 1<15 で毎回
    // 再インデックスが走っていた。nonemptySceneCount を分母にすれば発火しない。
    mockSemanticIndexStatus.mockResolvedValue(
      sceneStatus({
        indexedSceneCount: 1,
        nonemptySceneCount: 1,
        staleChunkCount: 0,
      }),
    );
    await ensureSceneIndexed("p1");
    expect(mockSemanticReindexAll).not.toHaveBeenCalled();
    expect(useReindexProgressStore.getState().running).toBe(false);
  });

  it("defers when a reindex is already running", async () => {
    useReindexProgressStore.getState().setRunning(true);
    await ensureSceneIndexed("p1");
    expect(mockSemanticIndexStatus).not.toHaveBeenCalled();
    expect(mockSemanticReindexAll).not.toHaveBeenCalled();
  });

  it("is silent and clears running when reindex fails", async () => {
    mockSemanticIndexStatus.mockResolvedValue(
      sceneStatus({ indexedSceneCount: 0, nonemptySceneCount: 4 }),
    );
    mockSemanticReindexAll.mockRejectedValueOnce(new Error("boom"));
    await expect(ensureSceneIndexed("p1")).resolves.toBeUndefined();
    expect(useReindexProgressStore.getState().running).toBe(false);
  });

  it("single-flights an A→B race: only one bulk reindex proceeds and the flag is not cleared early", async () => {
    mockSemanticIndexStatus.mockResolvedValue(
      sceneStatus({ indexedSceneCount: 0, nonemptySceneCount: 4 }),
    );
    // 先発 (A) の bulk reindex を in-flight に保持する deferred。
    let releaseA: () => void = () => {};
    const aInFlight = new Promise<number>((resolve) => {
      releaseA = () => resolve(7);
    });
    mockSemanticReindexAll.mockReturnValueOnce(aInFlight);

    // A→B を相次いで起動 (A の reindex は未解決のまま B が走り出す)。
    const aDone = ensureSceneIndexed("pA");
    const bDone = ensureSceneIndexed("pB");
    // B は A の in-flight トークンに弾かれ、bulk reindex を始めない。
    await bDone;
    expect(mockSemanticReindexAll).toHaveBeenCalledTimes(1);
    expect(mockSemanticReindexAll).toHaveBeenCalledWith("pA");
    // A がまだ実行中なので running フラグは下りていない (横取りで早期クリアされない)。
    expect(useReindexProgressStore.getState().running).toBe(true);

    // A 完了でフラグが下りる。
    releaseA();
    await aDone;
    expect(useReindexProgressStore.getState().running).toBe(false);
  });
});

describe("ensureSemanticIndexesOnOpen", () => {
  it("runs codex, chat and scene back-index", async () => {
    mockCodexIndexStatus.mockResolvedValue({
      indexedEntryCount: 0,
      totalEntryCount: 2,
    });
    mockChatIndexStatus.mockResolvedValue({
      indexedMessageCount: 0,
      totalMessageCount: 3,
    });
    mockSemanticIndexStatus.mockResolvedValue(
      sceneStatus({ indexedSceneCount: 0, nonemptySceneCount: 3 }),
    );
    await ensureSemanticIndexesOnOpen("p1");
    expect(mockCodexReindexAll).toHaveBeenCalledWith("p1");
    expect(mockChatReindexAll).toHaveBeenCalledWith("p1");
    expect(mockSemanticReindexAll).toHaveBeenCalledWith("p1");
  });
});
