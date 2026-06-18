import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockCodexIndexStatus,
  mockCodexReindexAll,
  mockSemanticIndexStatus,
  mockSemanticReindexAll,
  mockInvoke,
} = vi.hoisted(() => ({
  mockCodexIndexStatus: vi.fn(),
  mockCodexReindexAll: vi.fn(),
  mockSemanticIndexStatus: vi.fn(),
  mockSemanticReindexAll: vi.fn(),
  mockInvoke: vi.fn(),
}));

vi.mock("./api", () => ({
  codexIndexStatus: mockCodexIndexStatus,
  codexReindexAll: mockCodexReindexAll,
  semanticIndexStatus: mockSemanticIndexStatus,
  semanticReindexAll: mockSemanticReindexAll,
}));
vi.mock("@/lib/tauri", () => ({ invoke: mockInvoke }));

import {
  ensureCodexIndexed,
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

describe("ensureSceneIndexed", () => {
  it("reindexes when indexedSceneCount < total scenes", async () => {
    mockSemanticIndexStatus.mockResolvedValue(
      sceneStatus({ indexedSceneCount: 1 }),
    );
    mockInvoke.mockResolvedValue({ rows: [{ n: 4 }] });
    await ensureSceneIndexed("p1");
    expect(mockSemanticReindexAll).toHaveBeenCalledWith("p1");
    expect(useReindexProgressStore.getState().running).toBe(false);
  });

  it("reindexes when stale chunks exist", async () => {
    mockSemanticIndexStatus.mockResolvedValue(
      sceneStatus({ indexedSceneCount: 4, staleChunkCount: 2 }),
    );
    mockInvoke.mockResolvedValue({ rows: [{ n: 4 }] });
    await ensureSceneIndexed("p1");
    expect(mockSemanticReindexAll).toHaveBeenCalledWith("p1");
  });

  it("skips when scenes fully indexed and fresh", async () => {
    mockSemanticIndexStatus.mockResolvedValue(
      sceneStatus({ indexedSceneCount: 4, staleChunkCount: 0 }),
    );
    mockInvoke.mockResolvedValue({ rows: [{ n: 4 }] });
    await ensureSceneIndexed("p1");
    expect(mockSemanticReindexAll).not.toHaveBeenCalled();
  });

  it("defers when a reindex is already running", async () => {
    useReindexProgressStore.getState().setRunning(true);
    await ensureSceneIndexed("p1");
    expect(mockSemanticIndexStatus).not.toHaveBeenCalled();
    expect(mockSemanticReindexAll).not.toHaveBeenCalled();
  });

  it("is silent and clears running when reindex fails", async () => {
    mockSemanticIndexStatus.mockResolvedValue(
      sceneStatus({ indexedSceneCount: 0 }),
    );
    mockInvoke.mockResolvedValue({ rows: [{ n: 4 }] });
    mockSemanticReindexAll.mockRejectedValueOnce(new Error("boom"));
    await expect(ensureSceneIndexed("p1")).resolves.toBeUndefined();
    expect(useReindexProgressStore.getState().running).toBe(false);
  });
});

describe("ensureSemanticIndexesOnOpen", () => {
  it("runs both codex and scene back-index", async () => {
    mockCodexIndexStatus.mockResolvedValue({
      indexedEntryCount: 0,
      totalEntryCount: 2,
    });
    mockSemanticIndexStatus.mockResolvedValue(
      sceneStatus({ indexedSceneCount: 0 }),
    );
    mockInvoke.mockResolvedValue({ rows: [{ n: 3 }] });
    await ensureSemanticIndexesOnOpen("p1");
    expect(mockCodexReindexAll).toHaveBeenCalledWith("p1");
    expect(mockSemanticReindexAll).toHaveBeenCalledWith("p1");
  });
});
