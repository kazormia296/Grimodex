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
  const allMethods = ["from", "where", "limit", "values", "set", "orderBy"];
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

describe("mapApi — extractPreviewText", () => {
  it("ProseMirror doc から先頭 40 文字を返す", async () => {
    const { extractPreviewText } = await import("./mapApi");
    const body = JSON.stringify({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "Hello world" }],
        },
      ],
    });
    expect(extractPreviewText(body)).toBe("Hello world");
  });

  it("40 文字超は省略記号を付ける", async () => {
    const { extractPreviewText } = await import("./mapApi");
    const long = "a".repeat(50);
    const body = JSON.stringify({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: long }] }],
    });
    const result = extractPreviewText(body);
    expect(result.length).toBeLessThanOrEqual(41);
    expect(result.endsWith("…")).toBe(true);
  });

  it("table ノードを (table) に変換する", async () => {
    const { extractPreviewText } = await import("./mapApi");
    const body = JSON.stringify({
      type: "doc",
      content: [{ type: "table", content: [] }],
    });
    expect(extractPreviewText(body)).toBe("(table)");
  });

  it("空ボディは空文字を返す", async () => {
    const { extractPreviewText } = await import("./mapApi");
    expect(extractPreviewText('{"type":"doc","content":[]}')).toBe("");
  });

  it("不正 JSON でも例外を投げない", async () => {
    const { extractPreviewText } = await import("./mapApi");
    expect(() => extractPreviewText("not json")).not.toThrow();
    expect(extractPreviewText("not json")).toBe("");
  });
});

describe("mapApi — createSticky", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sticky と position を同時に作成して返す", async () => {
    const newSticky = {
      id: "sticky-1",
      boardId: "b1",
      title: null,
      body: '{"type":"doc","content":[]}',
      previewText: null,
      paletteId: "post-it-playful",
      colorSlot: 0,
      aiBranchId: null,
      sourceChatMessageId: null,
      createdAt: "2024-01-01",
      updatedAt: "2024-01-01",
    };
    const newPos = {
      id: "pos-1",
      boardId: "b1",
      nodeRefType: "sticky",
      stickyId: "sticky-1",
      x: 10,
      y: 20,
    };

    const insertChain = makeMock([newSticky]);
    const selectChain = makeMock([]);
    const insertPosChain = makeMock([newPos]);

    (db.insert as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce(insertChain)
      .mockReturnValueOnce(insertPosChain);
    (db.select as ReturnType<typeof vi.fn>).mockReturnValue(selectChain);

    const { createSticky } = await import("./mapApi");
    const result = await createSticky({ boardId: "b1", x: 10, y: 20 });
    expect(result.sticky.paletteId).toBe("post-it-playful");
    expect(result.sticky.colorSlot).toBe(0);
    expect(result.position.nodeRefType).toBe("sticky");
  });
});

describe("mapApi — duplicateBoard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("ソースボードが存在しない場合はエラーを投げる", async () => {
    const emptyChain = makeMock([]);
    (db.select as ReturnType<typeof vi.fn>).mockReturnValue(emptyChain);

    const { duplicateBoard } = await import("./mapApi");
    await expect(duplicateBoard("nonexistent", "proj")).rejects.toThrow();
  });
});

describe("mapApi — createAiBranch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("branch + positions + stickies + edges + authorship spans を作成する", async () => {
    const branch = {
      id: "branch-1",
      boardId: "b1",
      prompt: "アイデアを出して",
      seedNodeIds: "[]",
      sessionId: null,
      model: null,
      tokenUsage: null,
      createdAt: "2024-01-01",
      updatedAt: "2024-01-01",
    };
    const branchPos = {
      id: "pos-branch",
      boardId: "b1",
      nodeRefType: "ai_branch",
      aiBranchId: "branch-1",
      x: 0,
      y: 0,
    };
    const sticky1 = {
      id: "sticky-1",
      boardId: "b1",
      title: "アイデア1",
      body: '{"type":"doc","content":[]}',
      previewText: null,
      paletteId: "post-it-playful",
      colorSlot: 0,
      aiBranchId: "branch-1",
      sourceChatMessageId: null,
      createdAt: "2024-01-01",
      updatedAt: "2024-01-01",
    };
    const stickyPos1 = {
      id: "pos-s1",
      boardId: "b1",
      nodeRefType: "sticky",
      stickyId: "sticky-1",
      x: 0,
      y: -280,
    };
    const edge1 = { id: "edge-1", boardId: "b1", style: "dashed" };
    const span1 = { id: "span-1" };

    // Sequence of insert calls:
    // 1: mapAiBranches → branch
    // 2: mapNodePositions (branch pos)
    // 3: mapStickies (sticky 1)
    // 4: mapNodePositions (sticky pos 1)
    // 5: mapEdges (edge 1)
    // 6: authorshipSpans (span 1)
    (db.insert as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce(makeMock([branch]))
      .mockReturnValueOnce(makeMock([branchPos]))
      .mockReturnValueOnce(makeMock([sticky1]))
      .mockReturnValueOnce(makeMock([stickyPos1]))
      .mockReturnValueOnce(makeMock([edge1]))
      .mockReturnValueOnce(makeMock([span1]));

    const { createAiBranch } = await import("./mapApi");
    const result = await createAiBranch(
      "b1",
      "アイデアを出して",
      [],
      [{ title: "アイデア1", body: '{"type":"doc","content":[]}' }],
    );

    expect(result.branch.prompt).toBe("アイデアを出して");
    expect(result.stickies).toHaveLength(1);
    expect(result.stickies[0].aiBranchId).toBe("branch-1");
    // branch position + 1 sticky position
    expect(result.positions).toHaveLength(2);
    // insert was called 6 times (branch, branchPos, sticky, stickyPos, edge, span)
    expect(db.insert).toHaveBeenCalledTimes(6);
  });

  it("cards が空のとき branch と branchPosition だけ作成する", async () => {
    const branch = {
      id: "branch-empty",
      boardId: "b1",
      prompt: "テスト",
      seedNodeIds: "[]",
      sessionId: null,
      model: null,
      tokenUsage: null,
      createdAt: "2024-01-01",
      updatedAt: "2024-01-01",
    };
    const branchPos = {
      id: "pos-branch-empty",
      boardId: "b1",
      nodeRefType: "ai_branch",
      aiBranchId: "branch-empty",
      x: 0,
      y: 0,
    };

    (db.insert as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce(makeMock([branch]))
      .mockReturnValueOnce(makeMock([branchPos]));

    const { createAiBranch } = await import("./mapApi");
    const result = await createAiBranch("b1", "テスト", [], []);

    expect(result.stickies).toHaveLength(0);
    expect(result.positions).toHaveLength(1);
    expect(db.insert).toHaveBeenCalledTimes(2);
  });
});
