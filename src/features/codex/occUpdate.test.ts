import { describe, it, expect, vi, beforeEach } from "vitest";

// db をモック: 条件付き UPDATE の .returning() と、衝突判定用の存在チェック
// (.select().from().where().limit()) を制御する。markLinkedForeshadowsDirty の
// db.select は then で [] に解決させ「リンク無し→早期 return」にする。
const returningMock = vi.fn();
const limitMock = vi.fn();
const whereResult = {
  limit: limitMock,
  then: (resolve: (v: unknown) => void) => resolve([]),
};
vi.mock("@/db/client", () => ({
  db: {
    update: () => ({
      set: () => ({ where: () => ({ returning: returningMock }) }),
    }),
    select: () => ({ from: () => ({ where: () => whereResult }) }),
  },
}));
vi.mock("@/features/semantic-search/scheduler", () => ({
  scheduleCodexIndex: vi.fn(),
}));
vi.mock("./mentionRescanQueue", () => ({ enqueueRescan: vi.fn() }));

import { updateCodexEntry } from "./api";
import { CodexVersionConflictError } from "./occ";

beforeEach(() => {
  returningMock.mockReset();
  limitMock.mockReset();
});

describe("updateCodexEntry OCC (base_version)", () => {
  it("baseVersion 一致 → 更新成功し、返り値の version はインクリメント値", async () => {
    returningMock.mockResolvedValueOnce([
      { id: "e1", projectId: "p", version: 3, content: "x" },
    ]);
    const r = await updateCodexEntry(
      "p",
      "e1",
      { content: "x" },
      { baseVersion: 2 },
    );
    expect(r?.version).toBe(3);
  });

  it("baseVersion 不一致かつ行は存在 → CodexVersionConflictError を投げる", async () => {
    returningMock.mockResolvedValueOnce([]); // 条件付き UPDATE が 0 件
    limitMock.mockResolvedValueOnce([{ id: "e1" }]); // 行は存在する
    await expect(
      updateCodexEntry("p", "e1", { content: "x" }, { baseVersion: 2 }),
    ).rejects.toBeInstanceOf(CodexVersionConflictError);
  });

  it("行が存在しない (別プロジェクト等) → undefined (従来通り)", async () => {
    returningMock.mockResolvedValueOnce([]);
    limitMock.mockResolvedValueOnce([]); // 行なし
    const r = await updateCodexEntry(
      "p",
      "e1",
      { content: "x" },
      { baseVersion: 2 },
    );
    expect(r).toBeUndefined();
  });

  it("baseVersion 省略 → blind UPDATE (version 非加算・後方互換)", async () => {
    returningMock.mockResolvedValueOnce([
      { id: "e1", projectId: "p", version: 0, content: "x" },
    ]);
    const r = await updateCodexEntry("p", "e1", { content: "x" });
    expect(r?.id).toBe("e1");
    // OCC を使っていないので存在チェック (limit) は呼ばれない
    expect(limitMock).not.toHaveBeenCalled();
  });
});
