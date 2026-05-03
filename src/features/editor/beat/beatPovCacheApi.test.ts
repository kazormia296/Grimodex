import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/db/client", () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock("@/db/schema", () => ({
  sceneBeatPovCache: {
    sceneId: "sceneId",
    povCharacterId: "povCharacterId",
  },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((col: unknown, val: unknown) => ({ eq: [col, val] })),
  and: vi.fn((...args: unknown[]) => ({ and: args })),
  notInArray: vi.fn((col: unknown, vals: unknown) => ({
    notInArray: [col, vals],
  })),
}));

import { db } from "@/db/client";
const mockDb = vi.mocked(db);

import {
  listSceneBeatPovOverrides,
  upsertSceneBeatPovOverrides,
} from "./beatPovCacheApi";

interface InsertChain {
  values: ReturnType<typeof vi.fn>;
  onConflictDoNothing: ReturnType<typeof vi.fn>;
}
interface DeleteChain {
  where: ReturnType<typeof vi.fn>;
}

function mockInsertChain(): InsertChain {
  const chain: InsertChain = {
    values: vi.fn().mockReturnThis(),
    onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
  };
  mockDb.insert.mockReturnValue(chain as never);
  return chain;
}

function mockDeleteChain(): DeleteChain {
  const chain: DeleteChain = {
    where: vi.fn().mockResolvedValue(undefined),
  };
  mockDb.delete.mockReturnValue(chain as never);
  return chain;
}

describe("upsertSceneBeatPovOverrides", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("空リストのとき insert をスキップし delete のみ実行する", async () => {
    mockInsertChain();
    const deleteChain = mockDeleteChain();

    await upsertSceneBeatPovOverrides("s1", []);

    expect(mockDb.insert).not.toHaveBeenCalled();
    expect(mockDb.delete).toHaveBeenCalledTimes(1);
    expect(deleteChain.where).toHaveBeenCalledTimes(1);
  });

  it("非空リストのとき insert → delete の順で実行する（insert 先行の fail-safe 順序）", async () => {
    const ops: string[] = [];
    const insertChain: InsertChain = {
      values: vi.fn().mockReturnThis(),
      onConflictDoNothing: vi.fn(async () => {
        ops.push("insert");
      }),
    };
    const deleteChain: DeleteChain = {
      where: vi.fn(async () => {
        ops.push("delete");
      }),
    };
    mockDb.insert.mockReturnValue(insertChain as never);
    mockDb.delete.mockReturnValue(deleteChain as never);

    await upsertSceneBeatPovOverrides("s1", ["char-1", "char-2"]);

    expect(ops).toEqual(["insert", "delete"]);
  });

  it("insert に渡す values が正しい shape になっている", async () => {
    const insertChain = mockInsertChain();
    mockDeleteChain();

    await upsertSceneBeatPovOverrides("s1", ["char-1", "char-2"]);

    expect(insertChain.values).toHaveBeenCalledWith([
      { sceneId: "s1", povCharacterId: "char-1" },
      { sceneId: "s1", povCharacterId: "char-2" },
    ]);
    expect(insertChain.onConflictDoNothing).toHaveBeenCalledTimes(1);
  });

  it("insert が失敗したとき stale 削除は実行しない（データ保全）", async () => {
    mockDb.insert.mockReturnValue({
      values: vi.fn().mockReturnThis(),
      onConflictDoNothing: vi.fn().mockRejectedValue(new Error("disk full")),
    } as never);
    const deleteChain = mockDeleteChain();

    await expect(upsertSceneBeatPovOverrides("s1", ["char-1"])).rejects.toThrow(
      "disk full",
    );

    expect(deleteChain.where).not.toHaveBeenCalled();
  });

  it("空リストのとき delete の where 条件は sceneId のみ（notInArray なし）", async () => {
    mockInsertChain();
    const deleteChain = mockDeleteChain();
    const { eq } = await import("drizzle-orm");

    await upsertSceneBeatPovOverrides("s1", []);

    const whereArg = deleteChain.where.mock.calls[0][0];
    // eq(sceneId, "s1") だけが条件として渡される
    expect(eq).toHaveBeenCalledWith("sceneId", "s1");
    expect(whereArg).toEqual({ eq: ["sceneId", "s1"] });
  });

  it("非空リストのとき delete の where 条件は and(eq, notInArray)", async () => {
    mockInsertChain();
    const deleteChain = mockDeleteChain();
    const { and, notInArray } = await import("drizzle-orm");

    await upsertSceneBeatPovOverrides("s1", ["char-1"]);

    expect(notInArray).toHaveBeenCalledWith("povCharacterId", ["char-1"]);
    expect(and).toHaveBeenCalledTimes(1);
    const whereArg = deleteChain.where.mock.calls[0][0];
    expect(whereArg).toMatchObject({ and: expect.any(Array) });
  });
});

describe("listSceneBeatPovOverrides", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function mockSelectChain(rows: { povCharacterId: string }[]) {
    const whereChain = { where: vi.fn().mockResolvedValue(rows) };
    const fromChain = { from: vi.fn().mockReturnValue(whereChain) };
    mockDb.select.mockReturnValue(fromChain as never);
    return whereChain;
  }

  it("返り値は povCharacterId の string[] になっている", async () => {
    mockSelectChain([
      { povCharacterId: "char-a" },
      { povCharacterId: "char-b" },
    ]);

    const result = await listSceneBeatPovOverrides("s1");

    expect(result).toEqual(["char-a", "char-b"]);
  });

  it("該当行がない場合は空配列を返す", async () => {
    mockSelectChain([]);

    const result = await listSceneBeatPovOverrides("s1");

    expect(result).toEqual([]);
  });

  it("where 条件に sceneId が渡される", async () => {
    const chain = mockSelectChain([]);
    const { eq } = await import("drizzle-orm");

    await listSceneBeatPovOverrides("target-scene");

    expect(eq).toHaveBeenCalledWith("sceneId", "target-scene");
    expect(chain.where).toHaveBeenCalledTimes(1);
  });
});
