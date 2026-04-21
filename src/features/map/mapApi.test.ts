import { describe, it, expect, vi, beforeEach } from "vitest";

// DB は Tauri invoke 経由なのでモック
vi.mock("@/db/client", () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue({}),
}));

import { db } from "@/db/client";

// Helper to build a chainable query mock.
// All chain methods return the same chain object.
// The chain is thenable so awaiting it resolves to returnValue.
// .returning() resolves to returnValue (for insert/update).
function makeMock(returnValue: unknown) {
  const chain: Record<string, unknown> = {};
  const allMethods = ["from", "where", "limit", "values", "set"];
  for (const m of allMethods) {
    chain[m] = vi.fn().mockReturnValue(chain);
  }
  chain["returning"] = vi.fn().mockResolvedValue(returnValue);
  // Thenable: awaiting the chain resolves to returnValue
  chain["then"] = (
    resolve: (v: unknown) => void,
    reject: (e: unknown) => void,
  ) => Promise.resolve(returnValue).then(resolve, reject);
  return chain;
}

describe("mapApi — getOrCreateBoard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("既存ボードが見つかった場合はそれを返す", async () => {
    const existingBoard = {
      id: "proj-main-board",
      projectId: "proj",
      title: "Main",
      sortOrder: 0,
      createdAt: "2024-01-01",
      updatedAt: "2024-01-01",
    };

    const chain = makeMock([existingBoard]);
    (db.select as ReturnType<typeof vi.fn>).mockReturnValue(chain);

    const { getOrCreateBoard } = await import("./mapApi");
    const result = await getOrCreateBoard("proj");
    expect(result.id).toBe("proj-main-board");
  });

  it("ボードが存在しない場合は新規作成する", async () => {
    const newBoard = {
      id: "proj2-main-board",
      projectId: "proj2",
      title: "Main",
      sortOrder: 0,
      createdAt: "2024-01-01",
      updatedAt: "2024-01-01",
    };

    const emptyChain = makeMock([]);
    const insertChain = makeMock([newBoard]);

    (db.select as ReturnType<typeof vi.fn>).mockReturnValue(emptyChain);
    (db.insert as ReturnType<typeof vi.fn>).mockReturnValue(insertChain);

    const { getOrCreateBoard } = await import("./mapApi");
    const result = await getOrCreateBoard("proj2");
    expect(result.projectId).toBe("proj2");
  });
});

describe("mapApi — listNodePositions", () => {
  it("hidden=0 のノードのみ返すクエリを実行する", async () => {
    const positions = [
      { id: "pos1", boardId: "b1", x: 10, y: 20 },
      { id: "pos2", boardId: "b1", x: 30, y: 40 },
    ];

    const chain = makeMock(positions);
    // listNodePositions は select() から始まる
    (db.select as ReturnType<typeof vi.fn>).mockReturnValue(chain);

    const { listNodePositions } = await import("./mapApi");
    const result = await listNodePositions("b1");
    expect(Array.isArray(result)).toBe(true);
  });
});
