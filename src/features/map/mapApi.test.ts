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

vi.mock("@/lib/tauri", () => ({
  invoke: vi.fn().mockResolvedValue({
    changeEventUid: "map-change-event",
    maintenanceTransactionId: "map-maintenance-transaction",
    undoJournalId: "map-undo-journal",
  }),
}));

vi.mock("@/features/timelapse/recorder", () => ({
  getRecorderSessionId: vi.fn(() => "map-test-session"),
  recordChangeEvent: vi.fn(),
}));

vi.mock("@/features/codex/codexRelationEvents", () => ({
  notifyCodexRelationsChanged: vi.fn(),
}));

import { db } from "@/db/client";
import { notifyCodexRelationsChanged } from "@/features/codex/codexRelationEvents";
import { recordChangeEvent } from "@/features/timelapse/recorder";
import { invoke } from "@/lib/tauri";

const mockRecord = vi.mocked(recordChangeEvent);
const mockInvoke = vi.mocked(invoke);
const mockNotifyCodexRelationsChanged = vi.mocked(notifyCodexRelationsChanged);

function pmDoc(text: string): string {
  return JSON.stringify({
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  });
}

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
  chain["toSQL"] = vi
    .fn()
    .mockReturnValue({ sql: "INSERT INTO t VALUES (?)", params: [] });
  chain["returning"] = vi.fn().mockResolvedValue(returnValue);
  chain["then"] = (
    resolve: (v: unknown) => void,
    reject: (e: unknown) => void,
  ) => Promise.resolve(returnValue).then(resolve, reject);
  return chain;
}

describe("mapApi — canonical history context", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("undo/redo lineage を必須化し、retry中は同じrequest identityを維持する", async () => {
    const { createMapHistoryWriteLease, createMapWriteContext } =
      await import("./mapApi");
    expect(() => createMapWriteContext("undo")).toThrow(
      "canonical transaction lineage",
    );

    const receipt = {
      changeEventUid: "forward-event",
      maintenanceTransactionId: "forward-transaction",
      undoJournalId: "forward-journal",
    };
    const lease = createMapHistoryWriteLease("undo", receipt);
    const first = lease.acquire();
    expect(lease.acquire()).toEqual(first);
    expect(first).toMatchObject({
      origin: "undo",
      originalTransactionId: "forward-transaction",
      undoJournalId: "forward-journal",
    });

    lease.committed();
    expect(lease.acquire().requestId).not.toBe(first.requestId);
  });
});

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

    const findCodexRelationByEdgeEndpoints = vi
      .fn()
      .mockResolvedValue({ id: "rel-existing" });
    vi.doMock("@/features/codex/codexRelationApi", () => ({
      findCodexRelationByEdgeEndpoints,
    }));

    const { promoteUserEdgeToCodexRelation } = await import("./mapApi");
    const result = await promoteUserEdgeToCodexRelation("edge-1", "proj", [
      makePosition({ id: "pos-a", nodeRefType: "codex", codexEntryId: "c-a" }),
      makePosition({ id: "pos-b", nodeRefType: "codex", codexEntryId: "c-b" }),
    ]);

    expect(result).toEqual({ relationId: "rel-existing" });
    expect(mockInvoke).toHaveBeenCalledWith(
      "map_write_bundle",
      expect.objectContaining({
        payload: expect.objectContaining({
          kind: "promote-user-edge-to-codex-relation",
          projectId: "proj",
          edgeId: "edge-1",
          relationId: "rel-existing",
          reuseExistingRelation: true,
        }),
      }),
    );
    expect(db.delete).not.toHaveBeenCalled();
    expect(mockRecord).not.toHaveBeenCalled();
    expect(mockNotifyCodexRelationsChanged).not.toHaveBeenCalled();
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

    const findCodexRelationByEdgeEndpoints = vi
      .fn()
      .mockResolvedValue(undefined);
    vi.doMock("@/features/codex/codexRelationApi", () => ({
      findCodexRelationByEdgeEndpoints,
    }));

    const { promoteUserEdgeToCodexRelation } = await import("./mapApi");
    const result = await promoteUserEdgeToCodexRelation("edge-1", "proj", [
      makePosition({ id: "pos-a", nodeRefType: "codex", codexEntryId: "c-a" }),
      makePosition({ id: "pos-b", nodeRefType: "codex", codexEntryId: "c-b" }),
    ]);

    expect(result?.relationId).toEqual(expect.any(String));
    expect(mockInvoke).toHaveBeenCalledWith(
      "map_write_bundle",
      expect.objectContaining({
        payload: expect.objectContaining({
          kind: "promote-user-edge-to-codex-relation",
          projectId: "proj",
          fromCodexId: "c-a",
          toCodexId: "c-b",
          edgeId: "edge-1",
          label: "師匠",
          reuseExistingRelation: false,
        }),
      }),
    );
    expect(db.delete).not.toHaveBeenCalled();
    expect(mockRecord).not.toHaveBeenCalled();
    expect(mockNotifyCodexRelationsChanged).toHaveBeenCalledExactlyOnceWith(
      "proj",
    );
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

  it("新規ボード (空 showConfig) は notes / aiBranch をデフォルト表示する", async () => {
    const { parseShowConfig } = await import("./mapApi");
    const { DEFAULT_SHOW } = await import("./types");
    // DEFAULT_SHOW は単一定義 (types.ts)。mapStore 初期 show と parseShowConfig
    // のフォールバックが同じ定数を共有していることで、二重定義による
    // notes/aiBranch のデフォルト食い違いが再発しないことを担保する。
    expect(DEFAULT_SHOW.notes).toBe(true);
    expect(DEFAULT_SHOW.aiBranch).toBe(true);
    const fresh = parseShowConfig("{}");
    expect(fresh.notes).toBe(true);
    expect(fresh.aiBranch).toBe(true);
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

  it("AI branch position/edge を除外し、派生 Sticky を採用済みとして複製する", async () => {
    const source = {
      id: "source",
      projectId: "proj",
      title: "Source",
      sortOrder: 0,
      mode: "free",
      viewportX: 0,
      viewportY: 0,
      viewportZoom: 1,
      showConfig: "{}",
      colorBy: "none",
      createdAt: "old",
      updatedAt: "old",
    };
    const sticky = {
      id: "sticky-1",
      boardId: "source",
      title: "Idea",
      body: pmDoc("idea"),
      previewText: "idea",
      paletteId: "post-it-playful",
      colorSlot: 0,
      aiBranchId: "branch-1",
      aiDerived: 1,
      sourceChatMessageId: "message-1",
      createdAt: "old",
      updatedAt: "old",
    };
    const branchPosition = {
      id: "position-branch",
      boardId: "source",
      nodeRefType: "ai_branch",
      treeNodeId: null,
      codexEntryId: null,
      snippetId: null,
      stickyId: null,
      aiBranchId: "branch-1",
      x: 0,
      y: 0,
      pinned: 0,
      zIndex: 0,
      createdAt: "old",
      updatedAt: "old",
    };
    const stickyPosition = {
      ...branchPosition,
      id: "position-sticky",
      nodeRefType: "sticky",
      stickyId: "sticky-1",
      aiBranchId: null,
    };
    const edge = {
      id: "edge-1",
      boardId: "source",
      fromPositionId: "position-branch",
      toPositionId: "position-sticky",
      forwardLabel: null,
      backwardLabel: null,
      labels: "[]",
      style: "dashed",
      color: "#888",
      direction: "forward",
      createdAt: "old",
      updatedAt: "old",
    };
    (db.select as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce(makeMock([source]))
      .mockReturnValueOnce(makeMock([]))
      .mockReturnValueOnce(makeMock([sticky]))
      .mockReturnValueOnce(makeMock([branchPosition, stickyPosition]))
      .mockReturnValueOnce(makeMock([edge]))
      .mockReturnValueOnce(makeMock([]));

    const { duplicateBoard } = await import("./mapApi");
    await duplicateBoard("source", "proj");

    const payload = mockInvoke.mock.calls[0][1]?.payload as {
      stickies: Array<{
        aiBranchId: string | null;
        sourceChatMessageId: string | null;
      }>;
      positions: Array<{ nodeRefType: string }>;
      edges: unknown[];
    };
    expect(payload.stickies).toEqual([
      expect.objectContaining({
        aiBranchId: null,
        sourceChatMessageId: null,
      }),
    ]);
    expect(payload.positions).toEqual([
      expect.objectContaining({ nodeRefType: "sticky" }),
    ]);
    expect(payload.edges).toEqual([]);
  });
});

describe("mapApi — createAiBranch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("branch + positions + stickies + edges + authorship spans を作成する", async () => {
    (db.select as ReturnType<typeof vi.fn>).mockReturnValue(
      makeMock([{ id: "b1", projectId: "p1" }]),
    );

    const { createAiBranch } = await import("./mapApi");
    const result = await createAiBranch(
      "b1",
      "アイデアを出して",
      [],
      [{ title: "アイデア1", body: '{"type":"doc","content":[]}' }],
    );

    expect(result.branch.prompt).toBe("アイデアを出して");
    expect(result.stickies).toHaveLength(1);
    expect(result.stickies[0].aiBranchId).toBe(result.branch.id);
    expect(result.positions).toHaveLength(2);
    expect(mockInvoke).toHaveBeenCalledWith("map_write_bundle", {
      payload: expect.objectContaining({
        kind: "create-ai-branch",
        projectId: "p1",
        branch: result.branch,
        branchPosition: result.positions[0],
        stickies: result.stickies,
        positions: [result.positions[1]],
        edges: result.edges,
        spans: [expect.objectContaining({ stickyId: result.stickies[0].id })],
      }),
    });
  });

  it("sticky 本文に作成時 'ai' authorship mark がシードされる", async () => {
    (db.select as ReturnType<typeof vi.fn>).mockReturnValue(
      makeMock([{ id: "b1", projectId: "p1" }]),
    );

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

    const payload = mockInvoke.mock.calls[0][1]?.payload as {
      stickies: Array<{ body: string }>;
    };
    const insertedBody = payload.stickies[0].body;
    const parsed = JSON.parse(insertedBody);
    expect(parsed.content[0].content[0].marks[0]).toMatchObject({
      type: "authorship",
      attrs: { source: "ai" },
    });
  });

  it("cards が空のとき branch と branchPosition だけ作成する", async () => {
    (db.select as ReturnType<typeof vi.fn>).mockReturnValue(
      makeMock([{ id: "b1", projectId: "p1" }]),
    );

    const { createAiBranch } = await import("./mapApi");
    const result = await createAiBranch("b1", "テスト", [], []);

    expect(result.stickies).toHaveLength(0);
    expect(result.positions).toHaveLength(1);
    expect(mockInvoke).toHaveBeenCalledWith("map_write_bundle", {
      payload: expect.objectContaining({
        kind: "create-ai-branch",
        stickies: [],
        positions: [],
        edges: [],
        spans: [],
      }),
    });
  });
});

describe("mapApi — deleteAiBranch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("orphan化の単純削除も Native erase bundle からreceiptを返す", async () => {
    (db.select as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce(makeMock([{ id: "branch-1", boardId: "board-1" }]))
      .mockReturnValueOnce(
        makeMock([{ id: "board-1", projectId: "project-1" }]),
      );

    const { deleteAiBranch } = await import("./mapApi");
    await expect(deleteAiBranch("branch-1")).resolves.toMatchObject({
      maintenanceTransactionId: "map-maintenance-transaction",
      undoJournalId: "map-undo-journal",
    });
    expect(mockInvoke).toHaveBeenCalledWith("map_write_bundle", {
      payload: expect.objectContaining({
        kind: "erase-ai-branch",
        projectId: "project-1",
        branchId: "branch-1",
        origin: "human",
        spanIds: [],
        stickyPositionIds: [],
        stickyIds: [],
      }),
    });
    expect(db.delete).not.toHaveBeenCalled();
  });

  it("redo contextをNative bundleへそのまま渡す", async () => {
    (db.select as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce(makeMock([{ id: "branch-1", boardId: "board-1" }]))
      .mockReturnValueOnce(
        makeMock([{ id: "board-1", projectId: "project-1" }]),
      );
    const context = {
      requestId: "redo-request",
      sessionId: "redo-session",
      eventUid: "redo-event",
      origin: "redo" as const,
      originalTransactionId: "forward-transaction",
      undoJournalId: "forward-journal",
    };

    const { deleteAiBranch } = await import("./mapApi");
    await deleteAiBranch("branch-1", context);
    expect(mockInvoke).toHaveBeenCalledWith("map_write_bundle", {
      payload: expect.objectContaining(context),
    });
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

describe("mapApi — updateSticky timelapse capture", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("records sticky.update with a body diff over extracted text", async () => {
    const updated = {
      id: "s1",
      boardId: "b1",
      body: pmDoc("new body"),
      previewText: "new body",
    };
    // 1st db call: SELECT old body. 2nd: UPDATE ... RETURNING.
    (db.select as ReturnType<typeof vi.fn>).mockReturnValue(
      makeMock([{ body: pmDoc("old body") }]),
    );
    (db.update as ReturnType<typeof vi.fn>).mockReturnValue(
      makeMock([updated]),
    );

    const { updateSticky } = await import("./mapApi");
    await updateSticky("s1", { body: pmDoc("new body") });

    const call = mockRecord.mock.calls.find(
      ([arg]) => arg.opType === "sticky.update",
    );
    expect(call).toBeTruthy();
    expect(call![0].domain).toBe("map");
    const payload = call![0].payload as {
      fields: string[];
      diffs?: { body?: { segments: [number, string][] } };
    };
    expect(payload.fields).toContain("body");
    const segs = payload.diffs?.body?.segments;
    expect(segs).toBeTruthy();
    // diff is over extracted plain text, not raw JSON
    const joined = segs!.map(([, t]) => t).join("");
    expect(joined).not.toContain("paragraph");
    const reconBefore = segs!
      .filter(([op]) => op !== 1)
      .map(([, t]) => t)
      .join("");
    const reconAfter = segs!
      .filter(([op]) => op !== -1)
      .map(([, t]) => t)
      .join("");
    expect(reconBefore).toBe("old body");
    expect(reconAfter).toBe("new body");
  });

  it("omits diffs when only non-body fields change", async () => {
    (db.update as ReturnType<typeof vi.fn>).mockReturnValue(
      makeMock([{ id: "s1", boardId: "b1" }]),
    );

    const { updateSticky } = await import("./mapApi");
    await updateSticky("s1", { colorSlot: 2 });

    const call = mockRecord.mock.calls.find(
      ([arg]) => arg.opType === "sticky.update",
    );
    expect(call).toBeTruthy();
    const payload = call![0].payload as { fields: string[]; diffs?: unknown };
    expect(payload.fields).toContain("colorSlot");
    expect(payload.diffs).toBeUndefined();
    // body 未更新時は旧 body の SELECT を撃たない
    expect(db.select).not.toHaveBeenCalled();
  });
});
