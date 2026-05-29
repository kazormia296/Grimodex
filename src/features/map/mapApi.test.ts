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
  const allMethods = [
    "from",
    "where",
    "limit",
    "values",
    "set",
    "orderBy",
    "onConflictDoNothing",
  ];
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

describe("mapApi — promoteUserEdgeToCodexRelation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  function makePosition(over: {
    id: string;
    nodeRefType: "codex" | "scene" | "note";
    codexEntryId?: string | null;
  }) {
    return {
      id: over.id,
      boardId: "b1",
      nodeRefType: over.nodeRefType,
      treeNodeId: null,
      codexEntryId: over.codexEntryId ?? null,
      snippetId: null,
      stickyId: null,
      aiBranchId: null,
      x: 0,
      y: 0,
      pinned: 0,
      zIndex: 0,
      createdAt: "2024-01-01",
      updatedAt: "2024-01-01",
    };
  }

  it("両端が codex でない場合は null を返し、エッジは削除しない", async () => {
    const edge = {
      id: "edge-1",
      boardId: "b1",
      fromPositionId: "pos-a",
      toPositionId: "pos-b",
      forwardLabel: "師匠",
    };
    const selectChain = makeMock([edge]);
    (db.select as ReturnType<typeof vi.fn>).mockReturnValue(selectChain);
    const deleteChain = makeMock([]);
    (db.delete as ReturnType<typeof vi.fn>).mockReturnValue(deleteChain);

    vi.doMock("@/features/codex/codexRelationApi", () => ({
      createCodexRelation: vi.fn(),
      findCodexRelationByEdgeEndpoints: vi.fn(),
    }));

    const { promoteUserEdgeToCodexRelation } = await import("./mapApi");
    const result = await promoteUserEdgeToCodexRelation("edge-1", "proj", [
      makePosition({ id: "pos-a", nodeRefType: "codex", codexEntryId: "c-a" }),
      // 片端が scene → promotion 不可
      makePosition({ id: "pos-b", nodeRefType: "scene" }),
    ]);

    expect(result).toBeNull();
    expect(db.delete).not.toHaveBeenCalled();
  });

  it("既存 relation があれば再利用し、user edge は削除する", async () => {
    const edge = {
      id: "edge-1",
      boardId: "b1",
      fromPositionId: "pos-a",
      toPositionId: "pos-b",
      forwardLabel: "師匠",
    };
    const selectChain = makeMock([edge]);
    (db.select as ReturnType<typeof vi.fn>).mockReturnValue(selectChain);
    const deleteChain = makeMock([]);
    (db.delete as ReturnType<typeof vi.fn>).mockReturnValue(deleteChain);

    const createCodexRelation = vi.fn();
    const findCodexRelationByEdgeEndpoints = vi
      .fn()
      .mockResolvedValue({ id: "rel-existing" });
    vi.doMock("@/features/codex/codexRelationApi", () => ({
      createCodexRelation,
      findCodexRelationByEdgeEndpoints,
    }));

    const { promoteUserEdgeToCodexRelation } = await import("./mapApi");
    const result = await promoteUserEdgeToCodexRelation("edge-1", "proj", [
      makePosition({ id: "pos-a", nodeRefType: "codex", codexEntryId: "c-a" }),
      makePosition({ id: "pos-b", nodeRefType: "codex", codexEntryId: "c-b" }),
    ]);

    expect(result).toEqual({ relationId: "rel-existing" });
    expect(createCodexRelation).not.toHaveBeenCalled();
    expect(db.delete).toHaveBeenCalled();
  });

  it("新規 relation を作って user edge を削除する", async () => {
    const edge = {
      id: "edge-1",
      boardId: "b1",
      fromPositionId: "pos-a",
      toPositionId: "pos-b",
      forwardLabel: "師匠",
    };
    const selectChain = makeMock([edge]);
    (db.select as ReturnType<typeof vi.fn>).mockReturnValue(selectChain);
    const deleteChain = makeMock([]);
    (db.delete as ReturnType<typeof vi.fn>).mockReturnValue(deleteChain);

    const createCodexRelation = vi.fn().mockResolvedValue({ id: "rel-new" });
    const findCodexRelationByEdgeEndpoints = vi
      .fn()
      .mockResolvedValue(undefined);
    vi.doMock("@/features/codex/codexRelationApi", () => ({
      createCodexRelation,
      findCodexRelationByEdgeEndpoints,
    }));

    const { promoteUserEdgeToCodexRelation } = await import("./mapApi");
    const result = await promoteUserEdgeToCodexRelation("edge-1", "proj", [
      makePosition({ id: "pos-a", nodeRefType: "codex", codexEntryId: "c-a" }),
      makePosition({ id: "pos-b", nodeRefType: "codex", codexEntryId: "c-b" }),
    ]);

    expect(result).toEqual({ relationId: "rel-new" });
    expect(createCodexRelation).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "proj",
        fromCodexId: "c-a",
        toCodexId: "c-b",
        sourceMapEdgeId: "edge-1",
        label: "師匠",
      }),
    );
    expect(db.delete).toHaveBeenCalled();
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

describe("mapApi — updateMapBoardSettings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("ボード設定を更新して返す", async () => {
    const updatedBoard = {
      id: "b1",
      projectId: "p1",
      title: "Main",
      sortOrder: 0,
      mode: "theme",
      viewportX: 10,
      viewportY: 20,
      viewportZoom: 1.5,
      showConfig: '{"scenes":true}',
      colorBy: "status",
      createdAt: "2024-01-01",
      updatedAt: "2024-01-02",
    };
    const chain = makeMock([updatedBoard]);
    (db.update as ReturnType<typeof vi.fn>).mockReturnValue(chain);

    const { updateMapBoardSettings } = await import("./mapApi");
    const result = await updateMapBoardSettings("b1", {
      mode: "theme",
      viewportX: 10,
      viewportY: 20,
      viewportZoom: 1.5,
      showConfig: '{"scenes":true}',
      colorBy: "status",
    });
    expect(result?.mode).toBe("theme");
    expect(result?.viewportZoom).toBe(1.5);
  });

  it("getMapBoard が単体ボードを返す", async () => {
    const board = {
      id: "b1",
      projectId: "p1",
      title: "Main",
      sortOrder: 0,
      mode: "free",
      viewportX: 0,
      viewportY: 0,
      viewportZoom: 1,
      showConfig: "{}",
      colorBy: "none",
      createdAt: "2024-01-01",
      updatedAt: "2024-01-01",
    };
    const chain = makeMock([board]);
    (db.select as ReturnType<typeof vi.fn>).mockReturnValue(chain);

    const { getMapBoard } = await import("./mapApi");
    const result = await getMapBoard("b1");
    expect(result?.id).toBe("b1");
  });
});

describe("mapApi — show config", () => {
  it("parseShowConfig / serializeShowConfig が往復できる", async () => {
    const { parseShowConfig, serializeShowConfig } = await import("./mapApi");
    const show = {
      scenes: false,
      codex: true,
      snippets: true,
      notes: true,
      stickies: false,
      aiBranch: true,
      derivedEdges: false,
      userEdges: true,
      frames: false,
    };
    const parsed = parseShowConfig(serializeShowConfig(show));
    expect(parsed).toEqual(show);
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

  it("sticky 本文に作成時 'ai' authorship mark がシードされる", async () => {
    const branch = { id: "branch-2", boardId: "b1" };
    const branchPos = { id: "pos-b" };
    const sticky = { id: "sticky-2", aiBranchId: "branch-2" };
    const stickyPos = { id: "pos-s" };
    const edge = { id: "edge-2" };
    const span = { id: "span-2" };

    (db.insert as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce(makeMock([branch]))
      .mockReturnValueOnce(makeMock([branchPos]))
      .mockReturnValueOnce(makeMock([sticky]))
      .mockReturnValueOnce(makeMock([stickyPos]))
      .mockReturnValueOnce(makeMock([edge]))
      .mockReturnValueOnce(makeMock([span]));

    const { createAiBranch } = await import("./mapApi");
    await createAiBranch(
      "b1",
      "p",
      [],
      [
        {
          title: "t",
          body: JSON.stringify({
            type: "doc",
            content: [
              { type: "paragraph", content: [{ type: "text", text: "本文" }] },
            ],
          }),
        },
      ],
    );

    // 3rd insert は mapStickies。values() に渡った body を検査する。
    const stickyChain = (db.insert as ReturnType<typeof vi.fn>).mock.results[2]
      .value as { values: ReturnType<typeof vi.fn> };
    const insertedBody = stickyChain.values.mock.calls[0][0].body as string;
    const parsed = JSON.parse(insertedBody);
    expect(parsed.content[0].content[0].marks[0]).toMatchObject({
      type: "authorship",
      attrs: { source: "ai" },
    });
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

describe("mapApi — adoptSticky / reattachSticky / adoptAllForBranch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("branch 由来 Sticky を採用すると aiBranchId が null になり点線エッジが削除される", async () => {
    const sticky = {
      id: "s1",
      boardId: "b1",
      aiBranchId: "br1",
      aiDerived: 1,
    };
    const stickyPos = { id: "pos-s1", boardId: "b1", stickyId: "s1" };
    const branchPos = { id: "pos-br1", boardId: "b1", aiBranchId: "br1" };
    const edge = {
      id: "edge1",
      boardId: "b1",
      fromPositionId: "pos-br1",
      toPositionId: "pos-s1",
      style: "dashed",
    };
    const updated = { ...sticky, aiBranchId: null };

    (db.select as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce(makeMock([sticky])) // sticky lookup
      .mockReturnValueOnce(makeMock([stickyPos])) // sticky position
      .mockReturnValueOnce(makeMock([branchPos])) // branch position
      .mockReturnValueOnce(makeMock([edge])); // dashed edge
    (db.delete as ReturnType<typeof vi.fn>).mockReturnValue(makeMock([]));
    (db.update as ReturnType<typeof vi.fn>).mockReturnValue(
      makeMock([updated]),
    );

    const { adoptSticky } = await import("./mapApi");
    const result = await adoptSticky("s1");

    expect(result.sticky.aiBranchId).toBeNull();
    expect(result.previousAiBranchId).toBe("br1");
    expect(result.removedEdge?.id).toBe("edge1");
    expect(db.delete).toHaveBeenCalledTimes(1);
  });

  it("採用は ai_derived を変更しない (AI 由来 provenance を保持する)", async () => {
    const sticky = {
      id: "s2",
      boardId: "b1",
      aiBranchId: "br1",
      aiDerived: 1,
    };
    const stickyPos = { id: "pos-s2", boardId: "b1", stickyId: "s2" };
    const branchPos = { id: "pos-br1", boardId: "b1", aiBranchId: "br1" };

    (db.select as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce(makeMock([sticky]))
      .mockReturnValueOnce(makeMock([stickyPos]))
      .mockReturnValueOnce(makeMock([branchPos]))
      .mockReturnValueOnce(makeMock([])); // no edge found
    (db.update as ReturnType<typeof vi.fn>).mockReturnValue(
      makeMock([{ ...sticky, aiBranchId: null }]),
    );

    const { adoptSticky } = await import("./mapApi");
    await adoptSticky("s2");

    const updateChain = (db.update as ReturnType<typeof vi.fn>).mock.results[0]
      .value as { set: ReturnType<typeof vi.fn> };
    const setArg = updateChain.set.mock.calls[0][0] as Record<string, unknown>;
    expect("aiBranchId" in setArg).toBe(true);
    expect(setArg.aiBranchId).toBeNull();
    expect(setArg).not.toHaveProperty("aiDerived");
  });

  it("既に aiBranchId が null の Sticky は no-op (エッジ削除しない)", async () => {
    const sticky = { id: "s3", boardId: "b1", aiBranchId: null, aiDerived: 0 };
    (db.select as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      makeMock([sticky]),
    );
    (db.update as ReturnType<typeof vi.fn>).mockReturnValue(makeMock([sticky]));

    const { adoptSticky } = await import("./mapApi");
    const result = await adoptSticky("s3");

    expect(result.removedEdge).toBeNull();
    expect(result.previousAiBranchId).toBeNull();
    expect(db.delete).not.toHaveBeenCalled();
  });

  it("reattachSticky は aiBranchId を戻しエッジを復元する (undo)", async () => {
    const edge = {
      id: "edge1",
      boardId: "b1",
      fromPositionId: "pos-br1",
      toPositionId: "pos-s1",
      style: "dashed",
    };
    (db.update as ReturnType<typeof vi.fn>).mockReturnValue(makeMock([]));
    (db.insert as ReturnType<typeof vi.fn>).mockReturnValue(makeMock([edge]));

    const { reattachSticky } = await import("./mapApi");
    await reattachSticky("s1", "br1", edge as never);

    const updateChain = (db.update as ReturnType<typeof vi.fn>).mock.results[0]
      .value as { set: ReturnType<typeof vi.fn> };
    expect(updateChain.set.mock.calls[0][0]).toMatchObject({
      aiBranchId: "br1",
    });
    expect(db.insert).toHaveBeenCalledTimes(1);
  });

  it("reattachSticky は edge=null なら insert しない", async () => {
    (db.update as ReturnType<typeof vi.fn>).mockReturnValue(makeMock([]));

    const { reattachSticky } = await import("./mapApi");
    await reattachSticky("s1", "br1", null);

    expect(db.insert).not.toHaveBeenCalled();
  });

  it("adoptAllForBranch は branch の全派生 Sticky を採用する", async () => {
    const sticky = {
      id: "s1",
      boardId: "b1",
      aiBranchId: "br1",
      aiDerived: 1,
    };
    const stickyPos = { id: "pos-s1", boardId: "b1", stickyId: "s1" };
    const branchPos = { id: "pos-br1", boardId: "b1", aiBranchId: "br1" };
    const edge = {
      id: "edge1",
      boardId: "b1",
      fromPositionId: "pos-br1",
      toPositionId: "pos-s1",
      style: "dashed",
    };

    (db.select as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce(makeMock([sticky])) // derived stickies of branch
      .mockReturnValueOnce(makeMock([sticky])) // adoptSticky: sticky lookup
      .mockReturnValueOnce(makeMock([stickyPos])) // sticky position
      .mockReturnValueOnce(makeMock([branchPos])) // branch position
      .mockReturnValueOnce(makeMock([edge])); // dashed edge
    (db.delete as ReturnType<typeof vi.fn>).mockReturnValue(makeMock([]));
    (db.update as ReturnType<typeof vi.fn>).mockReturnValue(
      makeMock([{ ...sticky, aiBranchId: null }]),
    );

    const { adoptAllForBranch } = await import("./mapApi");
    const results = await adoptAllForBranch("br1");

    expect(results).toHaveLength(1);
    expect(results[0].previousAiBranchId).toBe("br1");
    expect(results[0].removedEdge?.id).toBe("edge1");
  });
});
