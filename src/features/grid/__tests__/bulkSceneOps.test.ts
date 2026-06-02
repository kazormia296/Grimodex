import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/features/tree/treeStore", () => ({
  useTreeStore: {
    getState: vi.fn(),
  },
}));

import { useTreeStore } from "@/features/tree/treeStore";
import { moveScenesToChapter, deleteScenes } from "../bulkSceneOps";

const mockGetState = vi.mocked(useTreeStore.getState);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("moveScenesToChapter", () => {
  it("Grid 表示順を保ったまま各シーンを章末尾に移動する", async () => {
    const moveNode = vi.fn().mockResolvedValue(undefined);
    mockGetState.mockReturnValue({
      moveNode,
    } as unknown as ReturnType<typeof useTreeStore.getState>);

    await moveScenesToChapter(["s1", "s2", "s3"], "ch-target");

    expect(moveNode).toHaveBeenCalledTimes(3);
    expect(moveNode).toHaveBeenNthCalledWith(1, "s1", "ch-target", undefined);
    expect(moveNode).toHaveBeenNthCalledWith(2, "s2", "ch-target", undefined);
    expect(moveNode).toHaveBeenNthCalledWith(3, "s3", "ch-target", undefined);
  });

  it("空配列を渡した場合は何もしない", async () => {
    const moveNode = vi.fn().mockResolvedValue(undefined);
    mockGetState.mockReturnValue({
      moveNode,
    } as unknown as ReturnType<typeof useTreeStore.getState>);

    await moveScenesToChapter([], "ch-target");

    expect(moveNode).not.toHaveBeenCalled();
  });

  // 全 moveNode を同じ同期 tick で一括 issue することを gate する
  // (逐次 await 実装は 1 回目しか同期発行せず、残りは前の promise 完了待ちになる)。
  // 加えて issue の相対順 (s1, s2, s3) も assert する。
  // NOTE: moveNode は deferred mock なので、各 moveNode が get().nodes 越しに
  // 前の楽観配置を読む semantics は gate しない (発行の同期性と順序のみ)。
  // CRITICAL: 呼び出しと assertion の間に await を一切挟まないこと。挟むと逐次実装が
  // 進んでしまい discriminate しなくなる (両実装で silently pass する)。
  it("全 moveNode を同じ同期 tick で一括発行し相対順 (s1, s2, s3) を保つ", async () => {
    const releasers: Array<() => void> = [];
    const moveNode = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releasers.push(() => resolve());
        }),
    );
    mockGetState.mockReturnValue({
      moveNode,
    } as unknown as ReturnType<typeof useTreeStore.getState>);

    // 返り値の promise を await せず捕捉する。
    const pending = moveScenesToChapter(["s1", "s2", "s3"], "ch-target");

    // ここで一切 await しないまま同期 assert する。
    expect(moveNode).toHaveBeenCalledTimes(3);
    expect(moveNode).toHaveBeenNthCalledWith(1, "s1", "ch-target", undefined);
    expect(moveNode).toHaveBeenNthCalledWith(2, "s2", "ch-target", undefined);
    expect(moveNode).toHaveBeenNthCalledWith(3, "s3", "ch-target", undefined);

    // deferred resolver を全て release してから返り値を await する
    // (unhandled rejection / 宙ぶらりんの pending promise を避ける)。
    releasers.forEach((release) => release());
    await pending;
  });
});

describe("deleteScenes", () => {
  it("各シーンを順番に削除する", async () => {
    const deleteNode = vi.fn().mockResolvedValue(undefined);
    mockGetState.mockReturnValue({
      deleteNode,
    } as unknown as ReturnType<typeof useTreeStore.getState>);

    await deleteScenes(["s1", "s2"]);

    expect(deleteNode).toHaveBeenCalledTimes(2);
    expect(deleteNode).toHaveBeenNthCalledWith(1, "s1");
    expect(deleteNode).toHaveBeenNthCalledWith(2, "s2");
  });

  it("空配列を渡した場合は何もしない", async () => {
    const deleteNode = vi.fn().mockResolvedValue(undefined);
    mockGetState.mockReturnValue({
      deleteNode,
    } as unknown as ReturnType<typeof useTreeStore.getState>);

    await deleteScenes([]);

    expect(deleteNode).not.toHaveBeenCalled();
  });
});
