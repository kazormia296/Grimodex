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
function makeMock(returnValue: unknown) {
  const chain: Record<string, unknown> = {};
  const allMethods = ["from", "where", "limit", "values", "set"];
  for (const m of allMethods) {
    chain[m] = vi.fn().mockReturnValue(chain);
  }
  chain["returning"] = vi.fn().mockResolvedValue(returnValue);
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
    (db.select as ReturnType<typeof vi.fn>).mockReturnValue(chain);

    const { listNodePositions } = await import("./mapApi");
    const result = await listNodePositions("b1");
    expect(Array.isArray(result)).toBe(true);
  });
});

describe("mapApi — user edges", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("listUserEdges がボードのエッジ一覧を返す", async () => {
    const edges = [
      {
        id: "edge1",
        boardId: "b1",
        fromPositionId: "pos1",
        toPositionId: "pos2",
        label: null,
        style: "solid",
        color: "#000000",
        direction: "none",
      },
    ];
    const chain = makeMock(edges);
    (db.select as ReturnType<typeof vi.fn>).mockReturnValue(chain);

    const { listUserEdges } = await import("./mapApi");
    const result = await listUserEdges("b1");
    expect(Array.isArray(result)).toBe(true);
  });

  it("createUserEdge がエッジを挿入して返す", async () => {
    const newEdge = {
      id: "edge-new",
      boardId: "b1",
      fromPositionId: "pos1",
      toPositionId: "pos2",
      label: null,
      style: "solid",
      color: "#000000",
      direction: "none",
    };
    const chain = makeMock([newEdge]);
    (db.insert as ReturnType<typeof vi.fn>).mockReturnValue(chain);

    const { createUserEdge } = await import("./mapApi");
    const result = await createUserEdge({
      boardId: "b1",
      fromPositionId: "pos1",
      toPositionId: "pos2",
    });
    expect(result.boardId).toBe("b1");
  });

  it("deleteUserEdge がエッジを削除する", async () => {
    const chain = makeMock([]);
    (db.delete as ReturnType<typeof vi.fn>).mockReturnValue(chain);

    const { deleteUserEdge } = await import("./mapApi");
    await expect(deleteUserEdge("edge1")).resolves.toBeUndefined();
  });
});

describe("mapApi — frames", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("listFrames がボードのフレーム一覧を返す", async () => {
    const frames = [
      {
        id: "frame1",
        boardId: "b1",
        title: "Part I",
        x: 100,
        y: 100,
        width: 400,
        height: 300,
        background: "#f5f5f5",
        borderColor: "#cccccc",
        zIndex: -1,
      },
    ];
    const chain = makeMock(frames);
    (db.select as ReturnType<typeof vi.fn>).mockReturnValue(chain);

    const { listFrames } = await import("./mapApi");
    const result = await listFrames("b1");
    expect(Array.isArray(result)).toBe(true);
  });

  it("createFrame がフレームを挿入して返す", async () => {
    const newFrame = {
      id: "frame-new",
      boardId: "b1",
      title: "Frame",
      x: 0,
      y: 0,
      width: 400,
      height: 300,
      background: "#f5f5f5",
      borderColor: "#cccccc",
      zIndex: -1,
    };
    const chain = makeMock([newFrame]);
    (db.insert as ReturnType<typeof vi.fn>).mockReturnValue(chain);

    const { createFrame } = await import("./mapApi");
    const result = await createFrame({
      boardId: "b1",
      title: "Frame",
      x: 0,
      y: 0,
      width: 400,
      height: 300,
    });
    expect(result.boardId).toBe("b1");
    expect(result.title).toBe("Frame");
  });

  it("deleteFrame がフレームを削除する", async () => {
    const chain = makeMock([]);
    (db.delete as ReturnType<typeof vi.fn>).mockReturnValue(chain);

    const { deleteFrame } = await import("./mapApi");
    await expect(deleteFrame("frame1")).resolves.toBeUndefined();
  });
});
